/** Fleet-wide views and decisions of per-node credentials (docs/NODE_CREDENTIALS.md). */
import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware, getUser, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { approvePendingBinding, credentialDowngradeCheck, listPendingBindings, rejectPendingBinding } from '../services/node-credential-service.js';
import { nodeCredentialFleetSummary } from '../services/node-credential-summary.js';
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
