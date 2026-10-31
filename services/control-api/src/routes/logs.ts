import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { streamSSE } from 'hono/streaming';
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

  // Cursor-based pagination: if cursor is provided, use it instead of offset
  if (body.cursor) {
    where['id'] = { lt: body.cursor };
  }

  const [logs, total] = await Promise.all([
    db.logEntry.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: limit,
      ...(body.cursor ? {} : { skip: offset }),
    }),
    db.logEntry.count({ where: { ...where, ...(body.cursor ? {} : {}) } }),
  ]);

  const nextCursor = logs.length === limit ? logs[logs.length - 1]?.id : undefined;

  return c.json({
    success: true,
    data: {
      logs,
      total,
      hasMore: body.cursor ? logs.length === limit : offset + limit < total,
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
  if (!verifyLogToken(nodeIdentity, c.req.header('x-log-token') ?? '')) {
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
});

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

    // Wait until the client disconnects
    stream.onAbort(() => {
      clearInterval(heartbeatTimer);
      unsubscribe();
    });

    // Keep the stream open — the onAbort callback will clean up
    // We need to await something that never resolves to keep the stream alive
    await new Promise(() => {
      // intentionally never resolves — stream closed via onAbort
    });
  });
});
