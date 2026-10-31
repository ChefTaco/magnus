import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware, getUser, requireRole } from '../middleware/auth.js';
import {
  sharedResourceLeaseIdentitySchema,
  sharedResourceOperationIdSchema,
  sharedResourceReconciliationSchema,
  sharedResourceReserveSchema,
  sharedResourceTerminalEvidenceSchema,
} from '../schemas/shared-resource-lease.js';
import { logAuditEvent } from '../services/audit-service.js';
import {
  inspectSharedResourceLease,
  recoverSharedResourceLease,
  reconcileSharedResourceLease,
  reserveSharedResources,
  retainUnknownSharedResourceLease,
  settleSharedResourceLease,
  startSharedResourceLease,
} from '../services/shared-resource-leases.js';
import { parseBody } from '../utils/validate.js';

const leaseIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
function leaseId(value: string): string { return leaseIdSchema.parse(value); }

export const sharedResourceLeasesRouter = new Hono();
sharedResourceLeasesRouter.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});
sharedResourceLeasesRouter.use('*', authMiddleware);

sharedResourceLeasesRouter.post('/reserve', requireRole('ADMIN', 'OPERATOR'), async c => {
  const input = await parseBody(c, sharedResourceReserveSchema);
  const actor = getUser(c).userId;
  const data = await reserveSharedResources(input, actor);
  await logAuditEvent({ action: 'resource.shared.reserve', actorId: actor,
    targetType: 'shared-resource-lease', targetId: data.leaseId,
    details: { operationId: data.operationId, resourceKeys: data.resources.map(resource => resource.resourceKey),
      missionRootId: data.missionRootId, missionRevision: data.missionRevision, taskId: data.taskId,
      actionClass: data.actionClass, callerKind: data.caller.kind, state: data.state } });
  return c.json({ success: true, data }, 201);
});

sharedResourceLeasesRouter.get('/operation/:operationId', requireRole('ADMIN', 'OPERATOR'), async c => {
  const user = getUser(c);
  const operationId = sharedResourceOperationIdSchema.parse(c.req.param('operationId'));
  return c.json({ success: true,
    data: await recoverSharedResourceLease(operationId, user.userId, user.role === 'ADMIN') });
});

sharedResourceLeasesRouter.get('/:leaseId', requireRole('ADMIN', 'OPERATOR'), async c => {
  const user = getUser(c);
  return c.json({ success: true, data: await inspectSharedResourceLease(
    leaseId(c.req.param('leaseId')!), user.userId, user.role === 'ADMIN') });
});

sharedResourceLeasesRouter.post('/:leaseId/start', requireRole('ADMIN', 'OPERATOR'), async c => {
  const id = leaseId(c.req.param('leaseId')!);
  const actor = getUser(c).userId;
  const data = await startSharedResourceLease(id, await parseBody(c, sharedResourceLeaseIdentitySchema), actor);
  await logAuditEvent({ action: 'resource.shared.start', actorId: getUser(c).userId,
    targetType: 'shared-resource-lease', targetId: id,
    details: { operationId: data.operationId, resourceKeys: data.resources.map(resource => resource.resourceKey), state: data.state } });
  return c.json({ success: true, data });
});

sharedResourceLeasesRouter.post('/:leaseId/unknown', requireRole('ADMIN', 'OPERATOR'), async c => {
  const id = leaseId(c.req.param('leaseId')!);
  const actor = getUser(c).userId;
  const data = await retainUnknownSharedResourceLease(id, await parseBody(c, sharedResourceLeaseIdentitySchema), actor);
  await logAuditEvent({ action: 'resource.shared.unknown', actorId: getUser(c).userId,
    targetType: 'shared-resource-lease', targetId: id,
    details: { operationId: data.operationId, resourceKeys: data.resources.map(resource => resource.resourceKey), state: data.state } });
  return c.json({ success: true, data });
});

sharedResourceLeasesRouter.post('/:leaseId/settle', requireRole('ADMIN', 'OPERATOR'), async c => {
  const id = leaseId(c.req.param('leaseId')!);
  const input = await parseBody(c, sharedResourceTerminalEvidenceSchema);
  const actor = getUser(c).userId;
  const data = await settleSharedResourceLease(id, input, actor);
  await logAuditEvent({ action: 'resource.shared.settle', actorId: getUser(c).userId,
    targetType: 'shared-resource-lease', targetId: id,
    details: { operationId: data.operationId, resourceKeys: data.resources.map(resource => resource.resourceKey),
      state: data.state, settlement: data.settlement, evidenceSha256: data.evidenceSha256,
      issuer: input.issuer, keyId: input.keyId } });
  return c.json({ success: true, data });
});

sharedResourceLeasesRouter.post('/:leaseId/reconcile', requireRole('ADMIN'), async c => {
  const id = leaseId(c.req.param('leaseId')!);
  const input = await parseBody(c, sharedResourceReconciliationSchema);
  const data = await reconcileSharedResourceLease(id, input);
  await logAuditEvent({ action: 'resource.shared.reconcile', actorId: getUser(c).userId,
    targetType: 'shared-resource-lease', targetId: id,
    details: { operationId: data.operationId, resourceKeys: data.resources.map(resource => resource.resourceKey),
      state: data.state, settlement: data.settlement, evidenceSha256: data.evidenceSha256,
      decisionId: input.decisionId, approvalRef: input.approvalRef } });
  return c.json({ success: true, data });
});
