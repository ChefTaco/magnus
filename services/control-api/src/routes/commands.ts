import { NodeApiClient } from '../sdk/node-api-client.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { getNodeManagerSecret } from '../utils/env.js';
import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { getDb } from '../db/index.js';
import { authMiddleware, getUser, requireRole } from '../middleware/auth.js';
import { logAuditEvent, sanitizeDetails } from '../services/audit-service.js';
import { claimIdempotency, type IdempotencyClaim } from '../utils/idempotency.js';
import { enqueueCommand } from '../queue/workers.js';
import { cancelQueuedCommand } from '../services/command-lifecycle.js';
import { HttpError } from '../middleware/error-handler.js';
import { parseBody } from '../utils/validate.js';
import { dispatchCommandSchema, cancelCommandSchema, reconcileCommandResourceSchema } from '../schemas/commands.js';
import { serializeStringArray, serializeRecord } from '../utils/json-fields.js';
import { eventBus, EventChannels } from '../services/event-bus.js';

export const commandsRouter = new Hono<AppVariables>();
commandsRouter.use('*', authMiddleware);

const STALE_THRESHOLD_MS = Number(process.env['STALE_NODE_THRESHOLD_MS'] ?? 120_000);

function isNodeStale(lastHeartbeatAt: Date | null): boolean {
  return !lastHeartbeatAt || Date.now() - lastHeartbeatAt.getTime() > STALE_THRESHOLD_MS;
}

// ── List recent commands ──
commandsRouter.get('/', async (c) => {
  const db = getDb();
  const nodeId = c.req.query('nodeId') ?? undefined;
  const status = c.req.query('status') ?? undefined;
  const hours = Math.min(Math.max(Number(c.req.query('hours') ?? '24'), 1), 24 * 30);
  const pageSize = Math.min(Math.max(Number(c.req.query('pageSize') ?? '25'), 1), 100);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const commands = await db.remoteCommand.findMany({
    where: {
      createdAt: { gte: since },
      ...(nodeId ? { nodeId } : {}),
      ...(status ? { status: status.toUpperCase() as never } : {}),
    },
    include: {
      node: { select: { id: true, name: true, hostname: true } },
      result: { select: { exitCode: true, durationMs: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: pageSize,
  });

  return c.json({
    success: true,
    data: commands.map(({ environment: _environment, ...command }) => command),
    meta: { count: commands.length, hours, pageSize },
  });
});

// ── Dispatch command to one or more nodes ──
commandsRouter.post('/', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const body = await parseBody(c, dispatchCommandSchema);

  const idempotencyKey: string = body.idempotencyKey ?? c.req.header('x-idempotency-key') ?? '';
  if (!idempotencyKey) throw new HttpError(400, 'VALIDATION_ERROR', 'x-idempotency-key required');

  const nodeIds: string[] = body.nodeIds;
  if (!nodeIds?.length) throw new HttpError(400, 'VALIDATION_ERROR', 'nodeIds required');

  if (body.dryRun) {
    const previewNodes = await db.node.findMany({
      where: { id: { in: nodeIds } },
      select: { id: true, name: true, status: true, lastHeartbeatAt: true },
    });
    return c.json({
      success: true,
      data: {
        dryRun: true,
        command: body.command,
        args: body.args ?? [],
        timeoutSeconds: body.timeoutSeconds ?? 300,
        riskLevel: body.riskLevel ?? 'medium',
        targets: previewNodes.map((node) => ({
          id: node.id,
          name: node.name,
          status: node.status,
          stale: isNodeStale(node.lastHeartbeatAt),
          allowed: node.status === 'ONLINE' && !isNodeStale(node.lastHeartbeatAt),
        })),
      },
    });
  }

  // Fetch node details for queue dispatch
  const nodes = await db.node.findMany({
    where: { id: { in: nodeIds }, status: 'ONLINE' },
  });

  const staleTargets = nodes.filter((node) => isNodeStale(node.lastHeartbeatAt));
  if (staleTargets.length > 0) {
    throw new HttpError(
      409,
      'STALE_NODE_BLOCKED',
      `Command blocked for stale node(s): ${staleTargets.map((node) => node.name).join(', ')}`,
    );
  }

  const commands: Array<{ id: string; nodeId: string; status: string }> = [];

  // Claim only after validation, dry-run, and stale-node checks, so a retry
  // after a rejected or preview request is not reported as a duplicate. A
  // request with no online targets creates nothing and claims nothing.
  let claim: IdempotencyClaim | undefined;
  if (nodes.length > 0) claim = await claimIdempotency('commands.dispatch', user.userId, idempotencyKey);

  try {
    for (const node of nodes) {
      const cmd = await db.remoteCommand.create({
        data: {
          nodeId: node.id,
          command: body.command,
          args: serializeStringArray(body.args),
          workingDirectory: body.workingDirectory ?? null,
          environment: serializeRecord(sanitizeDetails(body.environment ?? {}) as Record<string, unknown>),
          timeoutSeconds: body.timeoutSeconds ?? 300,
          status: 'QUEUED',
          riskLevel: body.riskLevel ?? 'medium',
          idempotencyKey: `${idempotencyKey}:${node.id}`,
          correlationId: c.get('traceId') as string | undefined,
          createdBy: user.userId,
        },
      });

      // The durable QUEUED row is retried by the reconciler if Redis is unavailable.
      void enqueueCommand(cmd.id).catch(() => console.error('[commands] queue admission pending'));

      commands.push({ id: cmd.id, nodeId: node.id, status: 'QUEUED' });
      void eventBus.publish(EventChannels.COMMAND_STATUS, {
        type: 'command.dispatched', commandId: cmd.id, nodeId: node.id,
        command: body.command, timestamp: new Date().toISOString(), source: 'control-api',
      });
    }
  } catch (err) {
    // Keep duplicate protection once any command exists.
    if (commands.length === 0) await claim?.release();
    // The per-node durable key is globally unique; reuse is still a duplicate.
    if ((err as { code?: unknown }).code === 'P2002') {
      throw new HttpError(409, 'DUPLICATE_REQUEST', `Idempotency key already used: ${idempotencyKey}`);
    }
    throw err;
  }

  await logAuditEvent({
    action: 'command.dispatch',
    actorId: user.userId,
    targetType: 'command',
    targetId: idempotencyKey,
    details: { command: body.command, nodeIds, count: commands.length },
  });

  return c.json({ success: true, data: { commands } }, 201);
});

// ── Get command by ID ──
commandsRouter.get('/:commandId', async (c) => {
  const db = getDb();
  const cmd = await db.remoteCommand.findUnique({
    where: { id: c.req.param('commandId')! },
    include: { result: true },
  });
  if (!cmd) throw new HttpError(404, 'NOT_FOUND', 'Command not found');
  // Strip environment from response — it may contain secrets
  const { environment: _env, ...safeCmd } = cmd;
  return c.json({ success: true, data: safeCmd });
});

// ── Get command result ──
commandsRouter.get('/:commandId/result', async (c) => {
  const db = getDb();
  const result = await db.commandResult.findUnique({
    where: { commandId: c.req.param('commandId')! },
  });
  if (!result) throw new HttpError(404, 'NOT_FOUND', 'Command result not found');
  return c.json({ success: true, data: result });
});

// Resource reconciliation accepts verified node evidence, never a naked unlock.
commandsRouter.get('/:commandId/resource-lease', async c => {
  const lease = await getDb().commandResourceLease.findUnique({ where: { commandId: c.req.param('commandId')! } });
  if (!lease) throw new HttpError(404, 'NOT_FOUND', 'Command has no resource lease');
  const { coordinationJson, ...safe } = lease;
  return c.json({ success: true, data: { ...safe, coordination: JSON.parse(coordinationJson) } });
});

commandsRouter.post('/:commandId/reconcile-resource', requireRole('ADMIN', 'OPERATOR'), async c => {
  const commandId = c.req.param('commandId')!;
  const body = await parseBody(c, reconcileCommandResourceSchema);
  const db = getDb();
  const lease = await db.commandResourceLease.findUnique({ where: { commandId } });
  if (!lease) throw new HttpError(404, 'NOT_FOUND', 'Command has no resource lease');
  const node = await db.node.findUnique({ where: { id: lease.nodeId } });
  if (!node) throw new HttpError(409, 'RESOURCE_TARGET_INVALID', 'Original node identity is unavailable');
  if (body.assertion && body.assertion.commandId !== commandId) throw new HttpError(409, 'RESOURCE_EVIDENCE_INVALID', 'Assertion names a different command');
  const client = new NodeApiClient({ baseUrl: getNodeBaseUrl(node.ipAddress, node.port), nodeToken: getNodeManagerSecret(),
    resourceNodeId: node.id, resourceActorId: getUser(c).userId });
  const expected = { nodeFqdn: node.hostname, requestSha256: lease.requestSha256 };
  const receipt = body.assertion ? await client.reconcileCommandReceipt(body.assertion, expected)
    : await client.getCommandReceipt(commandId, expected);
  const settled = await db.commandResourceLease.findUniqueOrThrow({ where: { commandId } });
  await logAuditEvent({ action: 'command.resource_reconcile', actorId: getUser(c).userId, targetType: 'command', targetId: commandId,
    details: { resourceKey: lease.resourceKey, receiptState: receipt.state, state: settled.state, evidenceSha256: settled.evidenceSha256 } });
  return c.json({ success: true, data: { commandId, receiptState: receipt.state, resourceState: settled.state,
    settlement: settled.settlement, evidenceSha256: settled.evidenceSha256 } });
});

// ── Cancel command ──
commandsRouter.post('/:commandId/cancel', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const commandId = c.req.param('commandId')!;
  const body = await parseBody(c, cancelCommandSchema);

  const updated = await cancelQueuedCommand(commandId);

  await logAuditEvent({
    action: 'command.cancel',
    actorId: user.userId,
    targetType: 'command',
    targetId: commandId,
    details: { reason: body.reason },
  });

  return c.json({ success: true, data: updated });
});

// ── Legacy stream route ──
// Commands are dispatched exactly once by the queue worker. The former stream
// implementation replayed the command against the agent and accepted unsigned
// output, so it is deliberately retired. Clients consume the authenticated
// command-status event stream and fetch the persisted, signature-verified
// result instead.
commandsRouter.get('/:commandId/stream', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb();
  const commandId = c.req.param('commandId')!;
  const cmd = await db.remoteCommand.findUnique({ where: { id: commandId } });
  if (!cmd) throw new HttpError(404, 'NOT_FOUND', 'Command not found');
  throw new HttpError(
    410,
    'COMMAND_STREAM_RETIRED',
    'Use /events/stream for status and /commands/:commandId/result for verified output',
  );
});
