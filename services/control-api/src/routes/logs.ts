import { Hono, type Context } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { streamSSE } from 'hono/streaming';
import { watchOathweaveStream } from '../middleware/oathweave.js';
import { getDb } from '../db/index.js';
import type { AppVariables, LogChunk, LogLevel, LogSource } from '../types/index.js';
import { authMiddleware } from '../middleware/auth.js';
import { sanitizeDetails } from '../services/audit-service.js';
import { emitLog, onLog } from '../services/log-emitter.js';
import { parseBody } from '../utils/validate.js';
import { logQuerySchema, logIngestSchema } from '../schemas/logs.js';
import {
  LOG_INGEST_PREVIOUS_SIGNING_SECRET,
  LOG_INGEST_SIGNING_SECRET,
} from '../utils/env.js';
import { HttpError } from '../middleware/error-handler.js';
import { assertNodeClaims, authenticateNode, nodeAuthOf } from '../middleware/node-auth.js';
import { readNodeAuthHeaders } from '../security/node-request-auth.js';

export const logsRouter = new Hono<AppVariables>();
logsRouter.use('/query', authMiddleware);
logsRouter.use('/stream', authMiddleware);

function verifyLogToken(nodeIdentity: string, provided: string): boolean {
  if (LOG_INGEST_SIGNING_SECRET.length < 32 || !provided) return false;
  const actualBuffer = Buffer.from(provided);
  const candidates = [
    LOG_INGEST_SIGNING_SECRET,
    ...(LOG_INGEST_PREVIOUS_SIGNING_SECRET.length >= 32
      ? [LOG_INGEST_PREVIOUS_SIGNING_SECRET]
      : []),
  ];
  let matched = false;
  for (const secret of candidates) {
    const expectedBuffer = Buffer.from(createHmac('sha256', secret)
      .update(`magnus:log-ingest:v1:${nodeIdentity.toLowerCase()}`)
      .digest('base64url'));
    matched = (
      actualBuffer.length === expectedBuffer.length
      && timingSafeEqual(actualBuffer, expectedBuffer)
    ) || matched;
  }
  return matched;
}

// ── Query logs ──

interface LogCursor { timestamp: Date; id: string }

/** An opaque keyset cursor: the (timestamp, id) of the last row of the previous page. */
export function encodeLogCursor(row: LogCursor): string {
  return Buffer.from(`v1|${row.timestamp.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

export function decodeLogCursor(cursor: string): LogCursor | null {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^v1\|([^|]+)\|([^|]+)$/.exec(text);
  if (!match) return null;
  const timestamp = new Date(match[1]!);
  return Number.isNaN(timestamp.getTime()) ? null : { timestamp, id: match[2]! };
}

logsRouter.post('/query', async (c) => {
  const db = getDb();
  const body = await parseBody(c, logQuerySchema);

  const where: Record<string, unknown> = {};
  if (body.nodeId) where['nodeId'] = body.nodeId;
  if (body.source) where['source'] = body.source;
  if (body.level) where['level'] = body.level;
  if (body.search) {
    where['message'] = { contains: body.search };
  }
  if (body.since || body.until) {
    where['timestamp'] = {
      ...(body.since ? { gte: new Date(body.since) } : {}),
      ...(body.until ? { lte: new Date(body.until) } : {}),
    };
  }

  const limit = Math.min(body.limit ?? 100, 1000);
  const offset = body.offset ?? 0;

  // Keyset pagination on (timestamp, id), the order the rows are returned in. A cursor from an
  // older server is a bare row id: its row supplies the timestamp.
  let after: LogCursor | null = null;
  if (body.cursor) {
    after = decodeLogCursor(body.cursor);
    if (!after) {
      const row = await db.logEntry.findUnique({ where: { id: body.cursor }, select: { id: true, timestamp: true } });
      if (!row) throw new HttpError(400, 'INVALID_CURSOR', 'cursor does not name a log page');
      after = row;
    }
  }
  const pageWhere = after
    ? { AND: [where, { OR: [{ timestamp: { lt: after.timestamp } }, { timestamp: after.timestamp, id: { lt: after.id } }] }] }
    : where;

  const [logs, total] = await Promise.all([
    db.logEntry.findMany({
      where: pageWhere,
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
      take: limit,
      ...(after ? {} : { skip: offset }),
    }),
    db.logEntry.count({ where }),
  ]);

  const last = logs[logs.length - 1];
  const nextCursor = logs.length === limit && last ? encodeLogCursor(last) : undefined;

  return c.json({
    success: true,
    data: {
      logs,
      total,
      hasMore: after ? logs.length === limit : offset + limit < total,
      nextCursor,
    },
  });
});

// ── Ingest logs from agents (internal) ──
logsRouter.post('/ingest', async (c) => {
  const db = getDb();
  const body = await parseBody(c, logIngestSchema);

  const entries = Array.isArray(body) ? body : [body];
  const identities = [...new Set(entries.map((entry) => entry.nodeId.trim().toLowerCase()))];
  if (identities.length !== 1) {
    throw new HttpError(400, 'NODE_IDENTITY_MISMATCH', 'A log batch must contain exactly one node identity');
  }
  const nodeIdentity = identities[0]!;

  // A node signature (or, outside enforce mode, the shared node secret) authenticates the batch
  // like any agent request; the per-node HMAC `x-log-token` stays accepted for older agents.
  const signed = readNodeAuthHeaders((name) => c.req.header(name)) !== null;
  const legacyToken = c.req.header('x-log-token') ?? '';
  if (signed || !legacyToken) {
    await authenticateNode(c, { legacyErrorCode: 'INVALID_CREDENTIALS' });
    const auth = nodeAuthOf(c);
    if (auth.method === 'signature') {
      // The batch names the node by its ID or host name; either must be the key's node.
      await assertNodeClaims(c, nodeIdentity === auth.node.id.toLowerCase() ? { nodeId: auth.node.id } : { fqdn: nodeIdentity });
      return storeLogBatch(c, auth.node.id, entries);
    }
  } else if (!verifyLogToken(nodeIdentity, legacyToken)) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid node-bound log credential');
  }
  const node = await db.node.findFirst({
    where: {
      status: { not: 'DECOMMISSIONED' },
      OR: [
        { id: nodeIdentity },
        { name: { equals: nodeIdentity, mode: 'insensitive' } },
        { hostname: { equals: nodeIdentity, mode: 'insensitive' } },
      ],
    },
    select: { id: true },
  });
  if (!node) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Unknown node identity');
  // The shared node secret may not speak for a node that has its own key.
  if (!legacyToken || signed) await assertNodeClaims(c, { nodeId: node.id });
  return storeLogBatch(c, node.id, entries);
});

type LogBatch = Array<{ source?: string | undefined; level?: string | undefined; message: string; metadata?: Record<string, unknown> | undefined; timestamp?: string | undefined }>;

async function storeLogBatch(c: Context, nodeId: string, entries: LogBatch): Promise<Response> {
  const db = getDb();
  const node = { id: nodeId };
  await db.logEntry.createMany({
    data: entries.map((e) => ({
      nodeId: node.id,
      source: e.source ?? 'agent',
      level: e.level ?? 'info',
      message: e.message,
      metadata: e.metadata ? JSON.stringify(sanitizeDetails(e.metadata)) : '{}',
      timestamp: e.timestamp ? new Date(e.timestamp) : new Date(),
    })),
  });

  // Emit to SSE subscribers
  for (const e of entries) {
    emitLog({
      id: '',
      nodeId: node.id,
      source: (e.source ?? 'agent') as LogSource,
      level: (e.level ?? 'info') as LogLevel,
      message: e.message,
      metadata: e.metadata ? sanitizeDetails(e.metadata) : {},
      timestamp: e.timestamp ? new Date(e.timestamp) : new Date(),
    });
  }

  return c.json({ success: true, data: { ingested: entries.length } }, 201);
}

// ── SSE log stream (live tail) ──
logsRouter.get('/stream', (c) => {
  // Parse optional filters from query params
  const nodeIdsParam = c.req.query('nodeIds');
  const sourcesParam = c.req.query('sources');
  const levelsParam = c.req.query('levels');

  const nodeIds = nodeIdsParam ? nodeIdsParam.split(',').filter(Boolean) : undefined;
  const sources = sourcesParam ? (sourcesParam.split(',').filter(Boolean) as LogSource[]) : undefined;
  const levels = levelsParam ? (levelsParam.split(',').filter(Boolean) as LogLevel[]) : undefined;

  return streamSSE(c, async (stream) => {
    let eventId = 0;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });

    // Keep-alive heartbeat every 30s
    const heartbeatTimer = setInterval(() => {
      void stream.writeSSE({ data: '', event: 'heartbeat', id: String(eventId++) });
    }, 30_000);

    const unsubscribe = onLog((entry: LogChunk) => {
      // Apply filters
      if (nodeIds && !nodeIds.includes(entry.nodeId)) return;
      if (sources && !sources.includes(entry.source)) return;
      if (levels && !levels.includes(entry.level)) return;

      void stream.writeSSE({
        data: JSON.stringify(entry),
        event: 'log',
        id: String(eventId++),
      });
    });

    // One idempotent cleanup for both ways a stream ends. A stream the server closes
    // (revoked or expired session) never reports an abort, so the abort callback alone
    // would leave the timer and the log subscription behind.
    let stopWatching: () => void = () => undefined;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeatTimer);
      stopWatching();
      unsubscribe();
      finish();
    };
    stopWatching = watchOathweaveStream(c.req.header('Authorization'), cleanup);
    stream.onAbort(cleanup);

    // Hold the stream open until the client disconnects or the session ends;
    // the helper closes it once this callback returns.
    await finished;
  });
});
