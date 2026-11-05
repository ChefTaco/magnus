import { createHash } from 'node:crypto';
import { Hono, type Context, type Next } from 'hono';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';
import { parseBody } from '../utils/validate.js';
import { safeEqual } from '../utils/safe-equal.js';
import { logAuditEvent } from '../services/audit-service.js';
import type { AppVariables } from '../types/index.js';

/**
 * Machine routes for the fleet gateway, the separate service that holds the restricted SSH key.
 * The gateway asks what a node is and records what happened. Nothing here dials a node.
 */
export const fleetGatewayRouter = new Hono<AppVariables>();

async function requireGatewayCredential(c: Context<AppVariables>, next: Next): Promise<void> {
  const expected = process.env['FLEET_GATEWAY_TOKEN_SHA256'] ?? '';
  const token = c.req.header('x-fleet-gateway-token') ?? '';
  if (!expected || !token || !safeEqual(createHash('sha256').update(token).digest('hex'), expected))
    throw new HttpError(401, 'UNAUTHORIZED', 'Fleet gateway credential required');
  await next();
}

fleetGatewayRouter.use('*', requireGatewayCredential);

const nodeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

/** POST /fleet-gateway/target: inventory facts for one node. The gateway applies its own host-key approval. */
fleetGatewayRouter.post('/target', async (c) => {
  const body = await parseBody(c, z.object({ nodeId }).strict());
  const node = await getDb().node.findUnique({
    where: { id: body.nodeId },
    select: { id: true, hostname: true, ipAddress: true, status: true },
  });
  if (!node) throw new HttpError(404, 'NODE_NOT_FOUND', 'Node not found');
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, data: { nodeId: node.id, hostname: node.hostname, ipAddress: node.ipAddress, status: node.status } });
});

const auditSchema = z.object({
  action: z.enum(['terminal.session.open', 'terminal.session.close', 'terminal.session.refuse', 'terminal.host-key.approve', 'terminal.host-key.remove']),
  subject: z.string().min(1).max(256),
  actorId: z.string().min(1).max(256),
  nodeId: nodeId.nullable(),
  sessionId: z.string().regex(/^ts_[A-Za-z0-9_-]{43}$/).nullable(),
  outcome: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/),
  at: z.iso.datetime(),
  durationMs: z.number().int().nonnegative().nullable(),
  ipAddress: z.union([z.ipv4(), z.ipv6()]).nullable(),
  fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/).nullable(),
}).strict();

/** POST /fleet-gateway/audit: terminal metadata. The schema has no field for terminal input or output. */
fleetGatewayRouter.post('/audit', async (c) => {
  const event = await parseBody(c, auditSchema);
  await logAuditEvent({
    action: event.action,
    actorId: event.actorId,
    actorType: 'user',
    targetType: 'node',
    targetId: event.nodeId ?? 'unspecified',
    ipAddress: event.ipAddress,
    details: {
      subject: event.subject,
      sessionHandle: event.sessionId,
      outcome: event.outcome,
      observedAt: event.at,
      durationMs: event.durationMs,
      hostKeyFingerprint: event.fingerprint,
    },
  });
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, data: { recorded: true } });
});
