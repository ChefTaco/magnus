/** Fleet-wide views and decisions of per-node credentials (docs/NODE_CREDENTIALS.md). */
import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware, getUser, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { approvePendingBinding, credentialDowngradeCheck, listPendingBindings, rejectPendingBinding } from '../services/node-credential-service.js';
import { nodeCredentialFleetSummary } from '../services/node-credential-summary.js';
import { logAuditEvent } from '../services/audit-service.js';
import { promoteNextServerKey, retirePreviousServerKey, serverKeyRotationState, ServerKeyRotationError, stageNextServerKey } from '../services/node-server-key.js';
import type { AppVariables } from '../types/index.js';
import { parseBody } from '../utils/validate.js';

export const nodeCredentialsRouter = new Hono<AppVariables>();
nodeCredentialsRouter.use('*', authMiddleware);
nodeCredentialsRouter.use('*', async (c, next) => { await next(); c.header('Cache-Control', 'no-store'); });

// How far the fleet is from enforce mode: counts, blockers and recent use of the shared credentials.
nodeCredentialsRouter.get('/summary', requireRole('ADMIN', 'OPERATOR'), async c =>
  c.json({ success: true, data: await nodeCredentialFleetSummary() }));

// Before installing an older agent on a node: whether that version keeps the node key, and the reset it needs first if not.
nodeCredentialsRouter.get('/downgrade-check', requireRole('ADMIN', 'OPERATOR'), async c => {
  const query = z.object({ nodeId: z.string().min(1).max(128), to: z.string().min(1).max(64) }).safeParse(c.req.query());
  if (!query.success) throw new HttpError(400, 'VALIDATION_ERROR', 'nodeId and to (an agent version) are required');
  return c.json({ success: true, data: await credentialDowngradeCheck(query.data.nodeId, query.data.to) });
});

// Automatic bindings refused for their address, for an administrator to approve or reject.
nodeCredentialsRouter.get('/pending-bindings', requireRole('ADMIN'), async c => {
  const query = z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(), nodeId: z.string().min(1).max(128).optional() })
    .safeParse(c.req.query());
  const filter = query.success ? { ...(query.data.status ? { status: query.data.status } : {}), ...(query.data.nodeId ? { nodeId: query.data.nodeId } : {}) } : {};
  return c.json({ success: true, data: await listPendingBindings(filter) });
});

nodeCredentialsRouter.post('/pending-bindings/:id/approve', requireRole('ADMIN'), async c => {
  await parseBody(c, z.object({}).strict());
  return c.json({ success: true, data: await approvePendingBinding(c.req.param('id')!, getUser(c).userId) });
});

nodeCredentialsRouter.post('/pending-bindings/:id/reject', requireRole('ADMIN'), async c => {
  const body = await parseBody(c, z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict());
  return c.json({ success: true, data: await rejectPendingBinding(c.req.param('id')!, getUser(c).userId, body.reason ?? null) });
});

// ── Server-key rotation (docs/NODE_CREDENTIALS.md, "Rotating the server key"): stage, promote, retire. ──
// The state (and how many agents pin the staged key) is in GET /node-credentials/summary.
function rotationStep<T>(step: () => T): T {
  try { return step(); }
  catch (error) {
    if (error instanceof ServerKeyRotationError) throw new HttpError(409, error.code, error.message);
    throw error;
  }
}

nodeCredentialsRouter.post('/server-key/stage', requireRole('ADMIN'), async c => {
  await parseBody(c, z.object({}).strict());
  const state = rotationStep(() => stageNextServerKey());
  await logAuditEvent({ action: 'node-auth.server-key.stage', actorId: getUser(c).userId, targetType: 'server-key', targetId: state.next!.keyId,
    details: { keyFingerprint: state.next!.keyFingerprint, activeKeyFingerprint: state.active.keyFingerprint } });
  return c.json({ success: true, data: state });
});

nodeCredentialsRouter.post('/server-key/promote', requireRole('ADMIN'), async c => {
  const body = await parseBody(c, z.object({ graceHours: z.number().int().min(1).max(90 * 24).optional(), force: z.boolean().optional() }).strict());
  // Every keyed node's agent should pin the staged key first; one that has not reads it again by itself
  // when the first request signed with it arrives, so `force` only skips the check.
  const summary = await nodeCredentialFleetSummary();
  const agents = summary.serverKeyRotation?.agents;
  if (summary.serverKeyRotation?.next && agents && agents.pinningNext < agents.keyedNodes && !body.force)
    throw new HttpError(409, 'SERVER_KEY_NOT_PINNED', `${agents.keyedNodes - agents.pinningNext} of ${agents.keyedNodes} keyed nodes have not reported pinning the staged key in the last ten minutes; wait a few heartbeats, or promote with force`);
  const previous = summary.serverKeyRotation?.active;
  const state = rotationStep(() => promoteNextServerKey(body.graceHours ? { graceMs: body.graceHours * 3_600_000 } : {}));
  await logAuditEvent({ action: 'node-auth.server-key.promote', actorId: getUser(c).userId, targetType: 'server-key', targetId: state.active.keyId,
    details: { keyFingerprint: state.active.keyFingerprint, ...(previous ? { previousKeyFingerprint: previous.keyFingerprint } : {}),
      retireAfter: state.previous?.retireAfter, forced: body.force === true, pinningNext: agents?.pinningNext, keyedNodes: agents?.keyedNodes } });
  return c.json({ success: true, data: state });
});

nodeCredentialsRouter.post('/server-key/retire', requireRole('ADMIN'), async c => {
  const body = await parseBody(c, z.object({ force: z.boolean().optional() }).strict());
  const before = rotationStep(() => serverKeyRotationState());
  const state = rotationStep(() => retirePreviousServerKey({ force: body.force === true }));
  await logAuditEvent({ action: 'node-auth.server-key.retire', actorId: getUser(c).userId, targetType: 'server-key', targetId: before.previous?.keyId ?? 'none',
    details: { keyFingerprint: before.previous?.keyFingerprint, forced: body.force === true } });
  return c.json({ success: true, data: state });
});
