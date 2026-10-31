/** Durable participant work is coordination, never execution approval.
 * Principals are fixed by server imports; no HTTP caller chooses a participant.
 * SSH exit status alone cannot release running work or prove descendant death.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';
import { lockResourceNode, resourceNodeIdentity as identity } from './resource-node-lock.js';
import { assertNodeAdmissionOpen } from './admission-fence.js';
import {
  participantWorkReconciliationSchema,
  participantWorkReconciliationSigningPayload,
  participantWorkRequestDigest,
  type ParticipantWorkReconciliation,
  participantWorkKindSchema,
  type ParticipantWorkKind,
  historicalParticipantWorkReconciliationSchema,
  historicalParticipantWorkSigningPayload,
} from '../schemas/resource-participant-reconciliation.js';
import {
  canonicalNodeSessionReceipt,
  nodeSessionReceiptSchema,
  verifyNodeSessionReceiptSignature,
} from '../schemas/node-session-receipt.js';
import { RESULT_SIGNING_PREVIOUS_SECRET, RESULT_SIGNING_SECRET } from '../utils/env.js';
import { COMMAND_COMPLETION_REGISTRY, COMMAND_COMPLETION_REGISTRY_SHA256 } from '../security/command-completion-registry.js';
export interface ReserveInput { host: string; workId: string; ownerId: string; kind: ParticipantWorkKind; operationSha256: string; deadline: number }
export interface StartInput { ownerId: string; epoch: number; barrierId: string | null; operationSha256: string; fence: string; deadline: number; requestSha256: string; targetHost?: string }
export interface FinishInput { ownerId: string; disposition: 'not-started' | 'remote-ended' | 'unknown'; evidenceSha256: string }
function fail(code: string, message: string): never { throw new HttpError(409, code, message); }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const PARTICIPANT_KINDS = {
  api: new Set<ParticipantWorkKind>(['ssh-command', 'agent-deploy', 'agent-upgrade', 'control-deploy', 'agent-migrate',
    'self-update-check', 'self-update-apply', 'self-update-restart']),
  dashboard: new Set<ParticipantWorkKind>(['terminal-http', 'terminal-ws', 'hermes-http', 'hermes-ws']),
} as const;
function workFields(row: { workId: string; nodeId: string; nodeFqdn: string | null; participant: string; ownerId: string; kind: string; state: string; epoch: number; barrierId: string | null; requestSha256: string | null; operationSha256: string | null; fence: bigint | null; deadline: Date | null }) {
  return { workId: row.workId, nodeId: row.nodeId, nodeFqdn: row.nodeFqdn, participant: row.participant, ownerId: row.ownerId, kind: row.kind,
    state: row.state, epoch: row.epoch, barrierId: row.barrierId, requestSha256: row.requestSha256,
    operationSha256: row.operationSha256, fence: row.fence?.toString() ?? null, deadline: row.deadline?.getTime() ?? null };
}

function participantWork(participant: 'api' | 'dashboard') {
  async function reserve(input: ReserveInput) {
    if (!participantWorkKindSchema.safeParse(input.kind).success || !PARTICIPANT_KINDS[participant].has(input.kind)
      || !/^[a-f0-9]{64}$/.test(input.operationSha256)
      || !Number.isSafeInteger(input.deadline) || input.deadline <= Date.now() || input.deadline > Date.now() + 3_600_000)
      fail('RESOURCE_WORK_INVALID', 'Exact bounded participant authority is required');
    const nodes = await getDb().node.findMany({ where: { OR: [{ hostname: input.host.toLowerCase() }, { ipAddress: input.host.toLowerCase() }] }, select: { id: true }, take: 2 });
    if (nodes.length !== 1) fail('RESOURCE_TARGET_INVALID', 'Exact unambiguous inventory target required');
    const nodeId = nodes[0]!.id;
    return getDb().$transaction(async tx => {
      await lockResourceNode(tx, nodeId); const { node, row } = await identity(tx, nodeId);
      await assertNodeAdmissionOpen(tx, nodeId);
      const targets = await tx.node.findMany({ where: { OR: [{ hostname: input.host.toLowerCase() }, { ipAddress: input.host.toLowerCase() }] }, select: { id: true }, take: 2 });
      if (targets.length !== 1 || targets[0]?.id !== nodeId) fail('RESOURCE_TARGET_INVALID', 'Target changed or became ambiguous');
      const history = await tx.commandResourceLease.findFirst({ where: { nodeId }, select: { id: true } });
      if (row?.state === 'draining' || ((process.env['MAGNUS_RESOURCE_LEASES_ENABLED'] === 'true' || history) && row?.state !== 'enrolled'))
        fail('RESOURCE_DRAIN_REQUIRED', 'New sessions are barred during enrollment');
      // Enrolled SSH still needs descendant settlement/supervision integration.
      if (row?.state === 'enrolled') fail('RESOURCE_SSH_UNAVAILABLE', 'Enrolled SSH descendants require managed completion evidence');
      const existing = await tx.resourceParticipantWork.findUnique({ where: { workId: input.workId } });
      if (existing) {
        if (existing.participant !== participant || existing.nodeId !== nodeId
          || existing.ownerId !== input.ownerId || existing.kind !== input.kind
          || existing.operationSha256 !== input.operationSha256 || existing.deadline?.getTime() !== input.deadline
          || existing.fence === null || existing.requestSha256 === null)
          fail('RESOURCE_WORK_CONFLICT', 'Work identity already used');
        return workFields(existing);
      }
      const resourceKey = `participant:${participant}:${nodeId}`;
      const allocated = await tx.commandResourceFence.upsert({ where: { resourceKey },
        create: { resourceKey, generation: 1n }, update: { generation: { increment: 1 } }, select: { generation: true } });
      const fence = allocated.generation.toString();
      const requestSha256 = participantWorkRequestDigest({ participant, workId: input.workId, nodeId, nodeFqdn: node.hostname,
        ownerId: input.ownerId, kind: input.kind, epoch: row?.epoch ?? 0, barrierId: row?.barrierId ?? null,
        operationSha256: input.operationSha256, fence, deadline: input.deadline });
      const work = await tx.resourceParticipantWork.create({ data: { workId: input.workId, ownerId: input.ownerId,
        nodeId, nodeFqdn: node.hostname, participant, kind: input.kind, epoch: row?.epoch ?? 0, barrierId: row?.barrierId ?? null,
        operationSha256: input.operationSha256, fence: allocated.generation, deadline: new Date(input.deadline), requestSha256 } });
      return workFields(work);
    });
  }
  async function start(workId: string, input: StartInput) {
    const db = getDb(); const found = await db.resourceParticipantWork.findUnique({ where: { workId } });
    if (!found) throw new HttpError(404, 'RESOURCE_WORK_NOT_FOUND', 'Work not found');
    const result = await db.$transaction(async tx => {
      await lockResourceNode(tx, found.nodeId); const { node, row } = await identity(tx, found.nodeId);
      const work = await tx.resourceParticipantWork.findUniqueOrThrow({ where: { workId } });
      if (work.ownerId !== input.ownerId || work.participant !== participant || work.state !== 'reserved')
        fail('RESOURCE_WORK_CONFLICT', 'Start is a single-use owner grant');
      const history = await tx.commandResourceLease.findFirst({ where: { nodeId: node.id }, select: { id: true } });
      const targets = input.targetHost === undefined ? null : await tx.node.findMany({ where: { OR: [
        { hostname: input.targetHost.toLowerCase() }, { ipAddress: input.targetHost.toLowerCase() }] }, select: { id: true }, take: 2 });
      const admissionFenced = Boolean(await tx.admissionFence.findUnique({ where: { nodeId: node.id }, select: { nodeId: true } }));
      if (admissionFenced || (targets && (targets.length !== 1 || targets[0]?.id !== node.id))
        || row?.state === 'draining' || row?.state === 'enrolled' || history || process.env['MAGNUS_RESOURCE_LEASES_ENABLED'] === 'true'
        || input.epoch !== work.epoch || input.barrierId !== work.barrierId
        || input.operationSha256 !== work.operationSha256 || input.fence !== work.fence?.toString()
        || input.deadline !== work.deadline?.getTime() || input.requestSha256 !== work.requestSha256
        || !work.deadline || work.deadline.getTime() <= Date.now()
        || (row?.epoch ?? 0) !== work.epoch || (row?.barrierId ?? null) !== work.barrierId) {
        await tx.resourceParticipantWork.update({ where: { workId }, data: { state: 'released', settledAt: new Date(),
          settlement: 'barrier-before-dispatch', evidenceSha256: digest({ workId, barrier: row?.barrierId ?? null }) } });
        return null;
      }
      return workFields(await tx.resourceParticipantWork.update({ where: { workId }, data: { state: 'running', startedAt: new Date() } }));
    });
    if (!result) fail('RESOURCE_DRAIN_REQUIRED', 'Drain barrier changed before session dispatch');
    return result;
  }
  async function finish(workId: string, input: FinishInput) {
    const db = getDb(); const found = await db.resourceParticipantWork.findUnique({ where: { workId } });
    if (!found) throw new HttpError(404, 'RESOURCE_WORK_NOT_FOUND', 'Work not found');
    return db.$transaction(async tx => {
      await lockResourceNode(tx, found.nodeId);
      const work = await tx.resourceParticipantWork.findUniqueOrThrow({ where: { workId } });
      if (work.ownerId !== input.ownerId || work.participant !== participant) fail('RESOURCE_WORK_CONFLICT', 'Work owner differs');
      if (work.state === 'released') return workFields(work);
      const released = work.state === 'reserved' && input.disposition === 'not-started';
      const updated = await tx.resourceParticipantWork.update({ where: { workId }, data: { state: released ? 'released' : 'unknown',
        settledAt: released ? new Date() : null, settlement: released ? 'not-dispatched' : 'descendants-unverified', evidenceSha256: input.evidenceSha256 } });
      return workFields(updated);
    });
  }

  return { reserve, start, finish };
}
export const dashboardParticipantWork = participantWork('dashboard');
export const apiParticipantWork = participantWork('api');

/** Settle only the exact durable owner from a node-authenticated, independently
 * supervised terminal receipt. This path observes; it never dispatches/retries. */
export async function settleParticipantWorkFromNodeReceipt(raw: unknown) {
  const value = nodeSessionReceiptSchema.parse(raw);
  if (!verifyNodeSessionReceiptSignature(value, RESULT_SIGNING_SECRET, RESULT_SIGNING_PREVIOUS_SECRET))
    throw new HttpError(403, 'RESOURCE_EVIDENCE_INVALID', 'Node session receipt signature is invalid');
  const db = getDb();
  const found = await db.resourceParticipantWork.findUnique({ where: { workId: value.workId } });
  if (!found) throw new HttpError(404, 'RESOURCE_WORK_NOT_FOUND', 'Participant work not found');
  return db.$transaction(async tx => {
    await lockResourceNode(tx, found.nodeId);
    const work = await tx.resourceParticipantWork.findUniqueOrThrow({ where: { workId: value.workId } });
    const exact = work.nodeId === value.nodeId && work.nodeFqdn === value.nodeFqdn
      && work.participant === value.participant && work.ownerId === value.ownerId && work.kind === value.kind
      && work.operationSha256 === value.operationSha256 && work.requestSha256 === value.requestSha256
      && work.fence?.toString() === value.fence && work.deadline?.getTime() === value.deadline;
    const recomputed = work.nodeFqdn && work.operationSha256 && work.fence !== null && work.deadline
      ? participantWorkRequestDigest({ participant: work.participant as 'api' | 'dashboard', workId: work.workId,
        nodeId: work.nodeId, nodeFqdn: work.nodeFqdn, ownerId: work.ownerId, kind: participantWorkKindSchema.parse(work.kind),
        epoch: work.epoch, barrierId: work.barrierId, operationSha256: work.operationSha256,
        fence: work.fence.toString(), deadline: work.deadline.getTime() }) : null;
    if (!exact || recomputed !== work.requestSha256 || !work.nodeFqdn || !work.operationSha256 || !work.requestSha256 || work.fence === null || !work.deadline)
      fail('RESOURCE_EVIDENCE_INVALID', 'Node receipt does not bind the exact participant authority');
    const descriptor = COMMAND_COMPLETION_REGISTRY.descriptors.find(item => item.id === value.completionDescriptorId);
    if (value.completionRegistrySha256 !== COMMAND_COMPLETION_REGISTRY_SHA256 || !descriptor
      || !descriptor.participantAuthority.allowedKinds.some(kind => kind === value.kind)
      || descriptor.participantAuthority.effectSemantics !== 'read-only-node-diagnostic'
      || value.effectBoundary !== descriptor.participantAuthority.effectBoundary)
      fail('RESOURCE_EVIDENCE_INVALID', 'Node receipt completion owner is not in the exact Control registry');
    if (!work.startedAt || !['running', 'unknown', 'released'].includes(work.state))
      fail('RESOURCE_WORK_CONFLICT', 'Only started participant work can have a node terminal receipt');
    if (value.terminalAt > Date.now() + 300_000)
      fail('RESOURCE_EVIDENCE_INVALID', 'Node receipt terminal time is implausibly in the future');

    const serialized = canonicalNodeSessionReceipt(value);
    const receiptSha256 = digest(serialized);
    if (work.state === 'released') {
      if (work.nodeSessionReceiptSha256 !== receiptSha256 || work.nodeSessionReceiptJson !== serialized)
        fail('RESOURCE_WORK_CONFLICT', 'Participant work already has another terminal settlement');
      return workFields(work);
    }
    const reused = await tx.resourceParticipantWork.findFirst({ where: { nodeSessionReceiptSha256: receiptSha256 }, select: { workId: true } });
    if (reused && reused.workId !== work.workId) fail('RESOURCE_WORK_CONFLICT', 'Node receipt is already bound to other work');
    const updated = await tx.resourceParticipantWork.update({ where: { workId: work.workId }, data: {
      state: 'released', settledAt: new Date(value.terminalAt), settlement: `signed-node-session:${value.disposition}`,
      evidenceSha256: value.resultSha256, nodeSessionReceiptSha256: receiptSha256, nodeSessionReceiptJson: serialized,
    } });
    return workFields(updated);
  });
}

export function reconciliationSecret(): string {
  const secret = process.env['RESOURCE_PARTICIPANT_RECONCILIATION_SECRET'] ?? '';
  const conflicting = ['COMMAND_RECONCILIATION_SECRET', 'RESULT_SIGNING_SECRET', 'NODE_MANAGER_SECRET', 'API_SECRET', 'JWT_SECRET',
    'RESOURCE_ENROLLMENT_DASHBOARD_SECRET', 'SECURITY_APPROVAL_BRIDGE_TOKEN', 'CREDENTIAL_ROTATION_KEY', 'AGENT_DISCOVERY_SECRET'];
  if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(secret)
    || conflicting.some(name => process.env[name] && process.env[name] === secret))
    throw new HttpError(503, 'RESOURCE_RECONCILIATION_UNAVAILABLE', 'Dedicated reconciliation authority is unavailable');
  return secret;
}

function verifyReconciliationSignature(value: ParticipantWorkReconciliation): void {
  const secret = reconciliationSecret();
  const expected = createHmac('sha256', secret).update(participantWorkReconciliationSigningPayload(value)).digest();
  if (!timingSafeEqual(expected, Buffer.from(value.signature, 'hex')))
    throw new HttpError(403, 'RESOURCE_EVIDENCE_INVALID', 'Participant reconciliation signature is invalid');
}

/**
 * Release an unresolved participant owner only after an exact reviewed assertion.
 * The assertion attests to independently verified quiescence; this function does
 * not infer it from SSH exit, process age, transport status, or caller prose.
 */
export async function reconcileParticipantWork(raw: unknown) {
  const value = participantWorkReconciliationSchema.parse(raw);
  verifyReconciliationSignature(value);
  const db = getDb();
  const found = await db.resourceParticipantWork.findUnique({ where: { workId: value.workId } });
  if (!found) throw new HttpError(404, 'RESOURCE_WORK_NOT_FOUND', 'Participant work not found');
  return db.$transaction(async tx => {
    await lockResourceNode(tx, found.nodeId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`resource-participant-reconciliation:${value.decisionId}`}, 0))`;
    const work = await tx.resourceParticipantWork.findUniqueOrThrow({ where: { workId: value.workId } });
    const exact = work.nodeId === value.nodeId && work.nodeFqdn === value.nodeFqdn
      && work.participant === value.participant && work.ownerId === value.ownerId && work.kind === value.kind
      && work.epoch === value.epoch && work.barrierId === value.barrierId
      && work.operationSha256 === value.operationSha256 && work.fence?.toString() === value.fence
      && work.deadline?.getTime() === value.deadline && work.requestSha256 === value.requestSha256;
    const recomputed = work.nodeFqdn && work.operationSha256 && work.fence !== null && work.deadline
      ? participantWorkRequestDigest({ participant: work.participant as 'api' | 'dashboard', workId: work.workId,
        nodeId: work.nodeId, nodeFqdn: work.nodeFqdn, ownerId: work.ownerId, kind: participantWorkKindSchema.parse(work.kind),
        epoch: work.epoch, barrierId: work.barrierId, operationSha256: work.operationSha256,
        fence: work.fence.toString(), deadline: work.deadline.getTime() }) : null;
    if (!exact || recomputed !== work.requestSha256 || !work.nodeFqdn || !work.requestSha256)
      fail('RESOURCE_EVIDENCE_INVALID', 'Reconciliation does not bind the exact participant request');

    const serialized = JSON.stringify(value);
    if (work.state === 'released') {
      if (work.reconciliationDecisionId !== value.decisionId || work.reconciliationJson !== serialized)
        fail('RESOURCE_WORK_CONFLICT', 'Participant work already has another terminal settlement');
      return workFields(work);
    }
    if (!['running', 'unknown'].includes(work.state))
      fail('RESOURCE_WORK_CONFLICT', 'Only started unresolved participant work can be reconciled');
    if (value.expiresAt <= Date.now() || value.expiresAt > Date.now() + 300_000)
      fail('RESOURCE_EVIDENCE_INVALID', 'Participant reconciliation validity is stale or too broad');
    const reused = await tx.resourceParticipantWork.findFirst({ where: { reconciliationDecisionId: value.decisionId }, select: { workId: true } });
    if (reused && reused.workId !== work.workId)
      fail('RESOURCE_WORK_CONFLICT', 'Reconciliation decision is already bound to other work');

    const updated = await tx.resourceParticipantWork.update({ where: { workId: work.workId }, data: {
      state: 'released', settledAt: new Date(), settlement: `signed-reconciliation:${value.disposition}`,
      evidenceSha256: value.evidenceSha256, reconciliationDecisionId: value.decisionId, reconciliationJson: serialized,
    } });
    return workFields(updated);
  });
}

function historicalRecord(row: {
  workId: string; nodeId: string; participant: string; ownerId: string; kind: string;
  epoch: number; barrierId: string | null; nodeFqdn: string | null;
  requestSha256: string | null; operationSha256: string | null; fence: bigint | null;
  deadline: Date | null; state: string; createdAt: Date; startedAt: Date | null;
  settledAt: Date | null; settlement: string | null; evidenceSha256: string | null;
  reconciliationDecisionId: string | null; reconciliationJson: string | null;
  nodeSessionReceiptSha256: string | null; nodeSessionReceiptJson: string | null;
}) {
  return { workId: row.workId, nodeId: row.nodeId, participant: row.participant, ownerId: row.ownerId,
    kind: row.kind, epoch: row.epoch, barrierId: row.barrierId, nodeFqdn: row.nodeFqdn,
    requestSha256: row.requestSha256, operationSha256: row.operationSha256, fence: row.fence?.toString() ?? null,
    deadline: row.deadline?.toISOString() ?? null, state: row.state, createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null, settledAt: row.settledAt?.toISOString() ?? null,
    settlement: row.settlement, evidenceSha256: row.evidenceSha256,
    reconciliationDecisionId: row.reconciliationDecisionId, reconciliationJson: row.reconciliationJson,
    nodeSessionReceiptSha256: row.nodeSessionReceiptSha256, nodeSessionReceiptJson: row.nodeSessionReceiptJson };
}
export async function inspectHistoricalParticipantWork(workId: string) {
  const row = await getDb().resourceParticipantWork.findUnique({ where: { workId } });
  if (!row) throw new HttpError(404, 'RESOURCE_WORK_NOT_FOUND', 'Participant work not found');
  const record = historicalRecord(row);
  return { record, recordSha256: digest(record) };
}

/** Explicitly quarantine a preinstrumentation owner after an independently
 * reviewed quiescence packet. The original outcome stays unknown in the signed
 * assertion and in the settlement label. This cannot be used for v2 work. */
export async function reconcileHistoricalParticipantWork(raw: unknown) {
  const value = historicalParticipantWorkReconciliationSchema.parse(raw);
  const secret = reconciliationSecret();
  const { signature, ...unsigned } = value;
  const expected = createHmac('sha256', secret).update(historicalParticipantWorkSigningPayload(unsigned)).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex')))
    throw new HttpError(403, 'RESOURCE_EVIDENCE_INVALID', 'Historical reconciliation signature is invalid');
  const found = await getDb().resourceParticipantWork.findUnique({ where: { workId: value.workId } });
  if (!found) throw new HttpError(404, 'RESOURCE_WORK_NOT_FOUND', 'Participant work not found');
  return getDb().$transaction(async tx => {
    await lockResourceNode(tx, found.nodeId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`resource-participant-reconciliation:${value.decisionId}`}, 0))`;
    const row = await tx.resourceParticipantWork.findUniqueOrThrow({ where: { workId: value.workId } });
    const serialized = JSON.stringify(value);
    if (row.state === 'released') {
      if (row.reconciliationDecisionId !== value.decisionId || row.reconciliationJson !== serialized)
        fail('RESOURCE_WORK_CONFLICT', 'Participant work already has another terminal settlement');
      return workFields(row);
    }
    const hashes = [value.dashboardObservationSha256, value.nodeObservationSha256, value.operationAuditSha256];
    if (row.nodeId !== value.nodeId || row.participant !== 'dashboard' || row.kind !== 'hermes-http'
      || row.state !== 'unknown' || !row.startedAt || row.settledAt || row.settlement !== 'descendants-unverified'
      || row.nodeFqdn !== null || row.operationSha256 !== null || row.requestSha256 !== null
      || row.fence !== null || row.deadline !== null || row.reconciliationDecisionId !== null
      || row.nodeSessionReceiptSha256 !== null || row.nodeSessionReceiptJson !== null
      || digest(historicalRecord(row)) !== value.recordSha256
      || new Set(hashes).size !== hashes.length
      || value.observedAt < row.startedAt.getTime() || value.observedAt > Date.now() + 60_000
      || value.observedAt < Date.now() - 300_000 || value.expiresAt <= Date.now()
      || value.expiresAt > Date.now() + 300_000)
      fail('RESOURCE_EVIDENCE_INVALID', 'Historical work or fresh quiescence evidence does not match');
    const reused = await tx.resourceParticipantWork.findFirst({ where: { reconciliationDecisionId: value.decisionId }, select: { workId: true } });
    if (reused && reused.workId !== row.workId) fail('RESOURCE_WORK_CONFLICT', 'Reconciliation decision is already bound to other work');
    const updated = await tx.resourceParticipantWork.update({ where: { workId: row.workId }, data: {
      state: 'released', settledAt: new Date(), settlement: 'signed-historical-quiescence:outcome-unknown',
      evidenceSha256: digest(hashes), reconciliationDecisionId: value.decisionId, reconciliationJson: serialized,
    } });
    return workFields(updated);
  });
}
