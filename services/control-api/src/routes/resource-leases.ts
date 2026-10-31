import { z } from 'zod';
import { getUser } from '../middleware/auth.js';
import { logAuditEvent } from '../services/audit-service.js';
import { assertEnrollmentComplete, lockResourceNode, nodeEnrollmentStatus, enrollmentStatus, inspectEnrollment,
  beginEnrollmentDrain, refreshEnrollmentParticipant, completeEnrollment, verifyDashboardCredential,
  dashboardParticipantReadiness, reserveDashboardWork, startDashboardWork, finishDashboardWork,
  dashboardReserveSchema, dashboardStartSchema, dashboardFinishSchema,
  apiDrainAttestationSchema, acceptApiDrainAttestation, schedulerBoundaryAttestationSchema,
  acceptSchedulerBoundaryAttestation } from '../services/resource-enrollment.js';
import { assertUnenrolledSshTarget } from '../services/managed-ssh-admission.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';
/** Node admission confirmation is coordination only; it cannot create an owner. */
import { Hono } from 'hono';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';
import { NODE_MANAGER_SECRET } from '../utils/env.js';
import { verifyWithRotation } from '../services/credential-rotation-service.js';
import { resourceLeasesRequested } from '../services/command-resource-leases.js';
import { activateArdentScope, ardentScopeActivationSchema, assertArdentScope, inspectArdentScope } from '../services/ardent-scope-enrollment.js';
import { legacyAdmissionRequestSchema, resourceClaimSchema } from '../security/managed-http.js';
import { participantWorkReconciliationSchema, historicalParticipantWorkReconciliationSchema } from '../schemas/resource-participant-reconciliation.js';
import { reconcileParticipantWork, reconcileHistoricalParticipantWork, inspectHistoricalParticipantWork,
  settleParticipantWorkFromNodeReceipt } from '../services/resource-participant-work.js';
import { nodeSessionReceiptSchema } from '../schemas/node-session-receipt.js';
import { transferAuthoritySnapshot } from '../services/transfer-authority-snapshot.js';
import { assertNodeAdmissionOpen, closeNodeAdmission, inspectNodeAdmission, releaseNodeAdmission, admissionFenceRequest } from '../services/admission-fence.js';
import { parseBody } from '../utils/validate.js';
function nodeCredential(token: string): void {
  if (!token || !NODE_MANAGER_SECRET || !verifyWithRotation('NODE_MANAGER_SECRET', NODE_MANAGER_SECRET, token))
    throw new HttpError(401, 'UNAUTHORIZED', 'Node credential required');
}
function workId(value: string | undefined): string {
  const parsed = z.string().guid().safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'INVALID_WORK_ID', 'A work UUID is required');
  return parsed.data;
}
export const resourceLeasesRouter = new Hono();
resourceLeasesRouter.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
resourceLeasesRouter.post('/transfer/authority-snapshot', async c => {
  nodeCredential(c.req.header('x-node-token') ?? '');
  const input = await parseBody(c, z.object({ nodeFqdn: z.string().min(1).max(253), nonce: z.string().guid() }).strict());
  return c.json({ success: true, data: await transferAuthoritySnapshot(input.nodeFqdn, input.nonce) });
});
resourceLeasesRouter.get('/admission/:nodeId', authMiddleware, requireRole('ADMIN', 'OPERATOR'), async c => {
  return c.json({ success: true, data: await inspectNodeAdmission(c.req.param('nodeId')!) });
});
resourceLeasesRouter.post('/admission/:nodeId/close', authMiddleware, requireRole('ADMIN'), async c => {
  const input = await parseBody(c, admissionFenceRequest);
  const data = await closeNodeAdmission(c.req.param('nodeId')!, input.nodeFqdn, input.releaseId);
  await logAuditEvent({ action: 'resource.admission.close', actorId: getUser(c).userId,
    targetType: 'node', targetId: data.nodeId, details: { releaseId: data.releaseId, nodeFqdn: data.nodeFqdn } });
  return c.json({ success: true, data });
});
resourceLeasesRouter.post('/admission/:nodeId/release', authMiddleware, requireRole('ADMIN'), async c => {
  const input = await parseBody(c, admissionFenceRequest);
  const data = await releaseNodeAdmission(c.req.param('nodeId')!, input.nodeFqdn, input.releaseId);
  await logAuditEvent({ action: 'resource.admission.release', actorId: getUser(c).userId,
    targetType: 'node', targetId: data.nodeId, details: { releaseId: data.releaseId, nodeFqdn: data.nodeFqdn } });
  return c.json({ success: true, data });
});
resourceLeasesRouter.post('/claim', async c => {
  const token = c.req.header('x-node-token') ?? '';
  if (!token || !NODE_MANAGER_SECRET || !verifyWithRotation('NODE_MANAGER_SECRET', NODE_MANAGER_SECRET, token))
    throw new HttpError(401, 'UNAUTHORIZED', 'Node credential required');
  const body = await parseBody(c, resourceClaimSchema);
  const db = getDb();
  await db.$transaction(async tx => {
    await lockResourceNode(tx, body.nodeId);
    const lease = await tx.commandResourceLease.findUnique({ where: { id: body.leaseId } });
    const node = await tx.node.findUnique({ where: { id: body.nodeId }, select: { hostname: true } });
    if (!lease || !node || lease.state !== 'running' || lease.nodeId !== body.nodeId || node.hostname !== body.nodeFqdn
      || lease.commandId !== body.commandId || lease.requestSha256 !== body.requestSha256
      || lease.coordinationJson !== JSON.stringify(body.coordination) || lease.deadline.getTime() <= Date.now())
      throw new HttpError(409, 'RESOURCE_CLAIM_INVALID', 'No current durable owner binds this exact node request');
    if (lease.resourceKey === `node:${body.nodeId}:ardent`) {
      const command = await tx.remoteCommand.findUnique({ where: { id: body.commandId } });
      let args: unknown;
      try { args = command ? JSON.parse(command.args) : null; } catch { args = null; }
      if (body.coordination.resourceKey !== lease.resourceKey || lease.completionClass !== 'native-http'
        || lease.completionDescriptorId !== 'ardent-action' || command?.command !== '@magnus/native-http/v1'
        || !Array.isArray(args) || args.length !== 3 || args[0] !== 'POST' || args[1] !== '/ardent/action'
        || typeof args[2] !== 'string' || !/^[a-f0-9]{64}$/.test(args[2])
        || command.timeoutSeconds > 900 || command.workingDirectory || command.environment !== '{}')
        throw new HttpError(409, 'RESOURCE_CLAIM_INVALID', 'Ardent scope does not bind this exact native action');
      await assertArdentScope(tx, body.nodeId, body.nodeFqdn);
    } else await assertEnrollmentComplete(tx, body.nodeId, body.nodeFqdn);
  });
  return c.json({ success: true, data: { admitted: true, ...body } });
});

/** Exact recovery authority for a previously admitted atomic skill publication.
 * It can only observe/adopt the original node journal; it cannot enter a handler
 * or create another effect, and therefore remains valid after deadline expiry. */
resourceLeasesRouter.post('/recovery-claim', async c => {
  nodeCredential(c.req.header('x-node-token') ?? '');
  const body = await parseBody(c, resourceClaimSchema);
  const db = getDb();
  await db.$transaction(async tx => {
    await lockResourceNode(tx, body.nodeId);
    await assertEnrollmentComplete(tx, body.nodeId, body.nodeFqdn);
    const [lease, node] = await Promise.all([
      tx.commandResourceLease.findUnique({ where: { id: body.leaseId } }),
      tx.node.findUnique({ where: { id: body.nodeId }, select: { hostname: true } }),
    ]);
    const command = lease ? await tx.remoteCommand.findUnique({ where: { id: lease.commandId } }) : null;
    let args: unknown;
    try { args = command ? JSON.parse(command.args) : null; } catch { args = null; }
    if (!lease || !node || !['running', 'unknown', 'released'].includes(lease.state)
      || lease.nodeId !== body.nodeId || node.hostname !== body.nodeFqdn
      || lease.commandId !== body.commandId || lease.requestSha256 !== body.requestSha256
      || lease.coordinationJson !== JSON.stringify(body.coordination)
      || command?.command !== '@magnus/native-http/v1'
      || !Array.isArray(args) || args[0] !== 'POST' || args[1] !== '/skills/install'
      || !lease.ownerActor.startsWith('skill-installation:'))
      throw new HttpError(409, 'RESOURCE_RECOVERY_INVALID', 'No exact atomic skill publication owner matches this recovery');
  });
  return c.json({ success: true, data: { admitted: true, ...body } });
});

resourceLeasesRouter.get('/ssh-admission', authMiddleware, requireRole('ADMIN', 'OPERATOR'), async c => {
  await assertUnenrolledSshTarget(c.req.query('host') ?? '');
  return c.json({ success: true, data: { allowed: true, enrolled: false } });
});

// This read is an admission decision, never cacheable discovery. The node holds
// its legacy-inflight barrier until the admitted handler has finished.
resourceLeasesRouter.post('/legacy-admission', async c => {
  const token = c.req.header('x-node-token') ?? '';
  if (!token || !NODE_MANAGER_SECRET || !verifyWithRotation('NODE_MANAGER_SECRET', NODE_MANAGER_SECRET, token))
    throw new HttpError(401, 'UNAUTHORIZED', 'Node credential required');
  const body = await parseBody(c, legacyAdmissionRequestSchema);
  const db = getDb();
  const matches = await db.node.findMany({ where: { hostname: body.nodeFqdn }, select: { id: true, hostname: true }, take: 2 });
  const node = matches.length === 1 ? matches[0] : undefined;
  if (!node) throw new HttpError(409, 'RESOURCE_TARGET_INVALID', 'Canonical inventory identity is required');
  const decision = await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`command-resource-node:${node.id}`}, 0))`;
    const current = await tx.node.findUnique({ where: { id: node.id }, select: { hostname: true } });
    if (current?.hostname !== body.nodeFqdn) throw new HttpError(409, 'RESOURCE_TARGET_INVALID', 'Inventory target changed');
    await assertNodeAdmissionOpen(tx, node.id);
    const [enrollment, leaseHistory, managedCronHistory, participantHistory] = await Promise.all([
      tx.resourceEnrollment.findUnique({ where: { nodeId: node.id } }),
      tx.commandResourceLease.findFirst({ where: { nodeId: node.id }, select: { id: true } }),
      tx.managedCronDefinition.findFirst({ where: { nodeId: node.id }, select: { cronJobId: true } }),
      tx.resourceParticipantWork.findFirst({ where: { nodeId: node.id }, select: { workId: true } }),
    ]);
    const enrolled = Boolean(enrollment && enrollment.state !== 'legacy')
      || Boolean(leaseHistory || managedCronHistory || participantHistory);
    const gateEnabled = resourceLeasesRequested();
    return { ...body, nodeId: node.id, enrolled, gateEnabled, allowedLegacy: !enrolled && !gateEnabled };
  });
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, data: decision });
});

// Versioned drain status is separate from strict legacy-admission v1.
resourceLeasesRouter.post('/enrollment/node-status', async c => {
  nodeCredential(c.req.header('x-node-token') ?? '');
  const input = await parseBody(c, z.object({ nodeFqdn: z.string().min(1).max(253), nonce: z.string().guid() }).strict());
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, data: await nodeEnrollmentStatus(input.nodeFqdn, input.nonce) });
});
resourceLeasesRouter.post('/enrollment/scheduler-status', async c => {
  nodeCredential(c.req.header('x-node-token') ?? '');
  const input = await parseBody(c, z.object({ nodeFqdn: z.string().min(1).max(253), nonce: z.string().guid() }).strict());
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, data: await nodeEnrollmentStatus(input.nodeFqdn, input.nonce, 'scheduler') });
});
resourceLeasesRouter.post('/enrollment/dashboard/status', async c => {
  verifyDashboardCredential(c.req.header('x-resource-drain-key') ?? '');
  const input = await parseBody(c, z.object({ nodeId: z.string().min(1).max(128), nonce: z.string().guid() }).strict());
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, data: await enrollmentStatus(input.nodeId, input.nonce, 'dashboard') });
});
resourceLeasesRouter.post('/enrollment/dashboard/work/reserve', async c => {
  verifyDashboardCredential(c.req.header('x-resource-drain-key') ?? '');
  const data = await reserveDashboardWork(await parseBody(c, dashboardReserveSchema));
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, data });
});
resourceLeasesRouter.post('/enrollment/dashboard/work/:workId/start', async c => {
  verifyDashboardCredential(c.req.header('x-resource-drain-key') ?? '');
  const data = await startDashboardWork(workId(c.req.param('workId')), await parseBody(c, dashboardStartSchema));
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, data });
});
resourceLeasesRouter.post('/enrollment/dashboard/work/:workId/finish', async c => {
  verifyDashboardCredential(c.req.header('x-resource-drain-key') ?? '');
  const data = await finishDashboardWork(workId(c.req.param('workId')), await parseBody(c, dashboardFinishSchema));
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, data });
});
resourceLeasesRouter.post('/enrollment/work/:workId/node-receipt', async c => {
  nodeCredential(c.req.header('x-node-token') ?? '');
  const input = await parseBody(c, nodeSessionReceiptSchema);
  if (input.workId !== workId(c.req.param('workId')))
    throw new HttpError(400, 'INVALID_WORK_ID', 'Path and node receipt work IDs differ');
  const data = await settleParticipantWorkFromNodeReceipt(input);
  return c.json({ success: true, data });
});
resourceLeasesRouter.post('/enrollment/work/:workId/reconcile', authMiddleware, requireRole('ADMIN'), async c => {
  const input = await parseBody(c, participantWorkReconciliationSchema);
  if (input.workId !== workId(c.req.param('workId')))
    throw new HttpError(400, 'INVALID_WORK_ID', 'Path and reconciliation work IDs differ');
  const data = await reconcileParticipantWork(input);
  await logAuditEvent({ action: 'resource.participant.reconcile', actorId: getUser(c).userId,
    targetType: 'resource-participant-work', targetId: input.workId, details: {
      nodeId: input.nodeId, participant: input.participant, kind: input.kind,
      disposition: input.disposition, decisionId: input.decisionId, evidenceSha256: input.evidenceSha256,
    } });
  return c.json({ success: true, data });
});
resourceLeasesRouter.get('/enrollment/work/:workId/historical', authMiddleware, requireRole('ADMIN'), async c => {
  return c.json({ success: true, data: await inspectHistoricalParticipantWork(workId(c.req.param('workId'))) });
});
resourceLeasesRouter.post('/enrollment/work/:workId/historical-reconcile', authMiddleware, requireRole('ADMIN'), async c => {
  const input = await parseBody(c, historicalParticipantWorkReconciliationSchema);
  if (input.workId !== workId(c.req.param('workId')))
    throw new HttpError(400, 'INVALID_WORK_ID', 'Path and historical reconciliation work IDs differ');
  const data = await reconcileHistoricalParticipantWork(input);
  await logAuditEvent({ action: 'resource.participant.historical-reconcile', actorId: getUser(c).userId,
    targetType: 'resource-participant-work', targetId: input.workId, details: {
      nodeId: input.nodeId, participant: input.participant, kind: input.kind,
      disposition: input.disposition, decisionId: input.decisionId, recordSha256: input.recordSha256,
      dashboardObservationSha256: input.dashboardObservationSha256,
      nodeObservationSha256: input.nodeObservationSha256, operationAuditSha256: input.operationAuditSha256,
    } });
  return c.json({ success: true, data });
});
resourceLeasesRouter.get('/enrollment/:nodeId', authMiddleware, requireRole('ADMIN', 'OPERATOR'), async c => {
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, data: await inspectEnrollment(c.req.param('nodeId')!) });
});
resourceLeasesRouter.get('/enrollment/:nodeId/ardent-scope', authMiddleware, requireRole('ADMIN', 'OPERATOR'), async c => {
  return c.json({ success: true, data: await inspectArdentScope(c.req.param('nodeId')!) });
});
resourceLeasesRouter.post('/enrollment/:nodeId/ardent-scope/activate', authMiddleware, requireRole('ADMIN'), async c => {
  const input = await parseBody(c, ardentScopeActivationSchema);
  const data = await activateArdentScope(c.req.param('nodeId')!, input);
  await logAuditEvent({ action: 'resource.enrollment.ardent-scope.activate', actorId: getUser(c).userId,
    targetType: 'node', targetId: data.nodeId, details: { decisionId: input.decisionId,
      epoch: input.epoch, barrierId: input.barrierId, reviewSha256: input.reviewSha256,
      receiptSha256: input.receiptSha256, schedulerSnapshotSha256: input.schedulerSnapshotSha256 } });
  return c.json({ success: true, data });
});
resourceLeasesRouter.post('/enrollment/:nodeId/begin', authMiddleware, requireRole('ADMIN'), async c => {
  await parseBody(c, z.object({}).strict());
  const data = await beginEnrollmentDrain(c.req.param('nodeId')!, getUser(c).userId);
  await logAuditEvent({ action: 'resource.enrollment.begin', actorId: getUser(c).userId,
    targetType: 'node', targetId: data.nodeId, details: { epoch: data.epoch, state: data.state } });
  return c.json({ success: true, data });
});
resourceLeasesRouter.post('/enrollment/:nodeId/refresh', authMiddleware, requireRole('ADMIN'), async c => {
  const input = await parseBody(c, z.object({ participant: z.enum(['agent', 'api', 'dashboard', 'scheduler']) }).strict());
  const data = await refreshEnrollmentParticipant(c.req.param('nodeId')!, input.participant);
  await logAuditEvent({ action: 'resource.enrollment.refresh', actorId: getUser(c).userId,
    targetType: 'node', targetId: c.req.param('nodeId')!, details: data });
  return c.json({ success: true, data });
});
resourceLeasesRouter.post('/enrollment/:nodeId/api-attest', authMiddleware, requireRole('ADMIN'), async c => {
  const input = await parseBody(c, apiDrainAttestationSchema);
  const data = await acceptApiDrainAttestation(c.req.param('nodeId')!, input);
  await logAuditEvent({ action: 'resource.enrollment.api-attest', actorId: getUser(c).userId,
    targetType: 'node', targetId: c.req.param('nodeId')!, details: {
      epoch: input.epoch, barrierId: input.barrierId, evidenceSha256: input.evidenceSha256,
      approvalRef: input.approvalRef, preinstrumentationSha256: input.preinstrumentationSha256,
      localDescendantsSha256: input.localDescendantsSha256, sshDescendantsSha256: input.sshDescendantsSha256,
    } });
  return c.json({ success: true, data });
});
resourceLeasesRouter.post('/enrollment/:nodeId/scheduler-boundary-attest', authMiddleware, requireRole('ADMIN'), async c => {
  const input = await parseBody(c, schedulerBoundaryAttestationSchema);
  const data = await acceptSchedulerBoundaryAttestation(c.req.param('nodeId')!, input);
  await logAuditEvent({ action: 'resource.enrollment.scheduler-boundary-attest', actorId: getUser(c).userId,
    targetType: 'node', targetId: c.req.param('nodeId')!, details: { epoch: input.epoch, barrierId: input.barrierId,
      approvalRef: input.approvalRef, reviewSha256: input.reviewSha256,
      receiptSha256: input.receiptSha256, externalBlockersSha256: input.externalBlockersSha256 } });
  return c.json({ success: true, data });
});
resourceLeasesRouter.post('/enrollment/:nodeId/complete', authMiddleware, requireRole('ADMIN'), async c => {
  await parseBody(c, z.object({}).strict());
  const data = await completeEnrollment(c.req.param('nodeId')!);
  await logAuditEvent({ action: 'resource.enrollment.complete', actorId: getUser(c).userId,
    targetType: 'node', targetId: data.nodeId, details: { epoch: data.epoch, state: data.state } });
  return c.json({ success: true, data });
});

resourceLeasesRouter.post('/enrollment/dashboard/readiness', async c => {
  verifyDashboardCredential(c.req.header('x-resource-drain-key') ?? '');
  await parseBody(c, z.object({}).strict());
  return c.json({ success: true, data: await dashboardParticipantReadiness() });
});
