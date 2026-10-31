/** Authoritative one-way drain barrier. Coordination never grants action approval.
 * Public callers can request a drain, but cannot supply participant evidence.
 * Only receipts pulled from fixed authenticated participants are accepted.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { lockResourceNode, resourceNodeIdentity as identity } from './resource-node-lock.js';
export { lockResourceNode } from './resource-node-lock.js';
import { dashboardParticipantWork, reconciliationSecret } from './resource-participant-work.js';
import { getDb } from '../db/index.js';
import type { Prisma } from '../db/generated/prisma/client.js';
import { HttpError } from '../middleware/error-handler.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { getNodeManagerSecret, RESULT_SIGNING_SECRET } from '../utils/env.js';

export const PARTICIPANTS = ['agent', 'api', 'dashboard', 'scheduler'] as const;
type Participant = typeof PARTICIPANTS[number];
type Tx = Prisma.TransactionClient;
const HELD = ['reserved', 'running', 'unknown'];
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
}
export function enrollmentSigningPayload(value: unknown): string { return 'magnus.resource-enrollment.v1\n' + canonical(value); }
function fail(code: string, message: string): never { throw new HttpError(409, code, message); }
export async function assertEnrollmentComplete(tx: Tx, nodeId: string, nodeFqdn: string): Promise<void> {
  const row = await tx.resourceEnrollment.findUnique({ where: { nodeId } });
  if (!row || row.state !== 'enrolled' || row.nodeFqdn !== nodeFqdn)
    fail('RESOURCE_ENROLLMENT_REQUIRED', 'Verified participant drain enrollment is required before resource execution');
}
export function dashboardEnrollmentSecret(): string {
  const key = process.env['RESOURCE_ENROLLMENT_DASHBOARD_SECRET'] ?? '';
  const other = ['API_SECRET', 'NODE_MANAGER_SECRET', 'RESULT_SIGNING_SECRET', 'JWT_SECRET', 'MAGNUS_SECRET',
    'SECURITY_APPROVAL_BRIDGE_TOKEN', 'COMMAND_RECONCILIATION_SECRET', 'RESOURCE_PARTICIPANT_RECONCILIATION_SECRET',
    'CREDENTIAL_ROTATION_KEY', 'AGENT_DISCOVERY_SECRET',
    'SESSION_SECRET', 'AUDIT_HMAC_SECRET', 'LOG_INGEST_SIGNING_SECRET', 'RESOURCE_LEASE_RESULT_SECRET',
    'RESOURCE_ENROLLMENT_NODE_SECRET', 'RESOURCE_LEASE_ADAPTER_SECRET', 'RESULT_SIGNING_PREVIOUS_SECRET',
    'LOG_INGEST_PREVIOUS_SIGNING_SECRET', 'SECURITY_FUSION_RECEIPT_SIGNING_KEY', 'METRICS_TOKEN', 'WEBHOOK_ENCRYPTION_KEY'];
  if (key.length < 32 || other.some(name => process.env[name] === key))
    throw new HttpError(503, 'RESOURCE_PARTICIPANT_UNCONFIGURED', 'Dedicated dashboard participant credential is required');
  return key;
}
export function verifyDashboardCredential(token: string): void {
  const expected = dashboardEnrollmentSecret();
  const received = Buffer.from(token); const required = Buffer.from(expected);
  if (received.byteLength !== required.byteLength || !timingSafeEqual(received, required))
    throw new HttpError(401, 'UNAUTHORIZED', 'Dashboard participant credential required');
}
function statusFields(node: { id: string; hostname: string }, row: { state: string; epoch: number; barrierId: string | null } | null) {
  return { version: 1 as const, nodeId: node.id, nodeFqdn: node.hostname,
    state: row?.state ?? 'legacy', epoch: row?.epoch ?? 0, barrierId: row?.barrierId ?? null };
}
async function participantSnapshot(tx: Tx, nodeId: string, participant: Participant) {
  const rows = await tx.resourceParticipantWork.findMany({ where: { nodeId, participant, state: { in: HELD } },
    orderBy: { workId: 'asc' }, select: { workId: true, ownerId: true, state: true, epoch: true, barrierId: true } });
  return { activeCount: rows.filter(row => row.state !== 'unknown').length,
    unknownCount: rows.filter(row => row.state === 'unknown').length, evidenceSha256: digest(rows) };
}
export async function enrollmentStatus(nodeId: string, nonce: string, participant: 'agent' | 'dashboard' | 'scheduler') {
  return getDb().$transaction(async tx => {
    await lockResourceNode(tx, nodeId);
    const { node, row } = await identity(tx, nodeId);
    const ack = await tx.resourceDrainParticipant.findUnique({ where: { nodeId_participant: { nodeId, participant } } });
    const challenge = row?.state === 'draining' && ack?.epoch === row.epoch && ack.barrierId === row.barrierId
      && ack.challengeExpiresAt.getTime() > Date.now()
      ? { challengeId: ack.challengeId, expiresAt: ack.challengeExpiresAt.getTime() } : null;
    const status = { ...statusFields(node, row), nonce };
    return participant === 'agent' ? { ...status, agentChallenge: challenge }
      : participant === 'scheduler' ? { ...status, schedulerChallenge: challenge }
      : { ...status, challenge, ...await participantSnapshot(tx, nodeId, participant) };
  });
}
export async function nodeEnrollmentStatus(nodeFqdn: string, nonce: string, participant: 'agent' | 'scheduler' = 'agent') {
  const nodes = await getDb().node.findMany({ where: { hostname: nodeFqdn }, select: { id: true }, take: 2 });
  if (nodes.length !== 1) fail('RESOURCE_TARGET_INVALID', 'Canonical inventory identity required');
  return enrollmentStatus(nodes[0]!.id, nonce, participant);
}
export async function beginEnrollmentDrain(nodeId: string, actor: string) {
  return getDb().$transaction(async tx => {
    await lockResourceNode(tx, nodeId);
    const { node, row } = await identity(tx, nodeId);
    if (row && row.state !== 'legacy') return statusFields(node, row);
    const data = { nodeFqdn: node.hostname, state: 'draining', epoch: (row?.epoch ?? 0) + 1,
      barrierId: randomUUID(), startedBy: actor, startedAt: new Date() };
    const saved = await tx.resourceEnrollment.upsert({ where: { nodeId }, create: { nodeId, ...data }, update: data });
    return statusFields(node, saved);
  });
}
export async function inspectEnrollment(nodeId: string) {
  return getDb().$transaction(async tx => {
    await lockResourceNode(tx, nodeId);
    const { node, row } = await identity(tx, nodeId);
    const participants = await tx.resourceDrainParticipant.findMany({ where: { nodeId }, select: {
      participant: true, status: true, epoch: true, challengeExpiresAt: true, evidenceSha256: true, verifiedAt: true } });
    return { ...statusFields(node, row), participants, requiredParticipants: PARTICIPANTS,
      unsupportedParticipants: [],
      schedulerUnsettled: await tx.managedCronOccurrence.count({ where: { nodeId, state: { not: 'completed' } } }),
      commandOwners: await tx.commandResourceLease.count({ where: { nodeId, state: { in: HELD } } }),
      api: await participantSnapshot(tx, nodeId, 'api'),
      apiBlockers: row?.state === 'enrolled' || participants.some(p => p.participant === 'api' && p.status === 'verified' && p.epoch === row?.epoch
        && p.challengeExpiresAt.getTime() > Date.now()) ? [] :
        ['preinstrumentation-work-unverified', 'local-descendants-unverified', 'noninventory-bootstrap-unsupported', 'ssh-descendants-unverified'],
      dashboard: await participantSnapshot(tx, nodeId, 'dashboard') };
  });
}
export const drainDescriptorSchema = z.object({ version: z.literal(1), participant: z.enum(PARTICIPANTS),
  nodeId: z.string().min(1).max(128), nodeFqdn: z.string().min(1).max(253), epoch: z.number().int().positive(),
  barrierId: z.string().guid(), challengeId: z.string().guid(), expiresAt: z.number().int().positive() }).strict();
export const drainReceiptSchema = drainDescriptorSchema.extend({ status: z.enum(['drained', 'pending']),
  activeCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), unknownCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/), signature: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const schedulerExternalSourceSchema = z.object({ identityVersion: z.literal(2), kind: z.string().regex(/^[A-Z_]{1,80}$/),
  sourceSha256: hex, count: z.number().int().positive().max(1_000_000) }).strict();
const EXTERNAL_SCHEDULER_KINDS = new Set(['LEGACY_OR_UNSUPPORTED_CRONTAB', 'SYSTEM_ANACRON', 'SYSTEM_CRONTAB',
  'SYSTEM_CRON_SOURCE', 'SYSTEM_TIMER_DEFINITION', 'USER_TIMER_DEFINITION', 'USER_TIMER_OFFLINE_ENABLED',
  'NATIVE_HERMES_RUNTIME_UNINSTRUMENTED', 'NATIVE_HERMES_SCHEDULES', 'NATIVE_HERMES_UNSETTLED_CLAIMS', 'NATIVE_AT_QUEUE']);
export const schedulerBoundaryReceiptSchema = drainDescriptorSchema.extend({ participant: z.literal('scheduler'),
  scope: z.literal('magnus-managed-scheduler-only'), status: z.enum(['managed-drained', 'pending']),
  activeCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), unknownCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  externalBlockers: z.array(schedulerExternalSourceSchema).max(1024), evidenceSha256: hex, signature: hex }).strict();
export const schedulerBoundaryAttestationSchema = z.object({ version: z.literal(1), scope: z.literal('magnus-managed-scheduler-only'),
  nodeId: z.string().min(1).max(128), nodeFqdn: z.string().min(1).max(253), epoch: z.number().int().positive(),
  barrierId: z.string().guid(), challengeId: z.string().guid(), receiptSha256: hex, externalBlockersSha256: hex,
  reviewSha256: hex, observedAt: z.number().int().positive(),
  approvalRef: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,199}$/), signature: hex }).strict();
export function schedulerBoundaryAttestationSigningPayload(value: Omit<z.infer<typeof schedulerBoundaryAttestationSchema>, 'signature'>): string {
  return 'magnus.scheduler-boundary-attestation.v1\n' + canonical(value);
}
export const apiDrainAttestationSchema = drainDescriptorSchema.extend({
  participant: z.literal('api'), status: z.literal('drained'), activeCount: z.literal(0), unknownCount: z.literal(0),
  evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  preinstrumentationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  localDescendantsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sshDescendantsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  observedAt: z.number().int().positive(),
  approvalRef: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,199}$/),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export function apiDrainAttestationSigningPayload(value: Omit<z.infer<typeof apiDrainAttestationSchema>, 'signature'>): string {
  return 'magnus.resource-enrollment-api-attestation.v1\n' + canonical(value);
}
/** Bounded response consumption, including dishonest or absent content-length. */
async function readReceipt(response: Response): Promise<unknown> {
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => undefined); throw new Error('Participant response unavailable');
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 16_384) throw new Error('Participant response exceeded bound'); chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { await reader.cancel().catch(() => undefined); }
}
export async function refreshEnrollmentParticipant(nodeId: string, participant: Participant) {
  // Fixed inventories and origins only: operator input cannot choose an endpoint or key.
  const prepared = await getDb().$transaction(async tx => {
    await lockResourceNode(tx, nodeId);
    const { node, row } = await identity(tx, nodeId);
    if (row?.state !== 'draining' || !row.barrierId) fail('RESOURCE_DRAIN_REQUIRED', 'Node must be draining');
    const descriptor = { version: 1 as const, participant, nodeId, nodeFqdn: node.hostname, epoch: row.epoch,
      barrierId: row.barrierId, challengeId: randomUUID(), expiresAt: Date.now() + (participant === 'api' ? 300_000 : 30_000) };
    await tx.resourceDrainParticipant.upsert({ where: { nodeId_participant: { nodeId, participant } },
      create: { nodeId, participant, epoch: row.epoch, barrierId: row.barrierId, challengeId: descriptor.challengeId,
        challengeExpiresAt: new Date(descriptor.expiresAt) }, update: { epoch: row.epoch, barrierId: row.barrierId,
        challengeId: descriptor.challengeId, challengeExpiresAt: new Date(descriptor.expiresAt), status: 'pending',
        evidenceSha256: null, receiptJson: null, verifiedAt: null } });
    return { descriptor, baseUrl: getNodeBaseUrl(node.ipAddress, node.port) };
  });
  if (participant === 'api') return { participant, status: 'pending', reason: 'signed-reviewed-evidence-required',
    descriptor: prepared.descriptor };
  let receipt: z.infer<typeof drainReceiptSchema> | z.infer<typeof schedulerBoundaryReceiptSchema>;
  try {
    let url: string; let headers: Record<string, string>; let key: string;
    if (participant === 'agent' || participant === 'scheduler') {
      key = RESULT_SIGNING_SECRET;
      if (key.length < 32) throw new Error('Agent receipt credential unavailable');
      if (new URL(prepared.baseUrl).protocol !== 'https:') throw new Error('Verified HTTPS agent endpoint required');
      url = prepared.baseUrl.replace(/\/$/, '') + (participant === 'scheduler'
        ? '/api/v1/cron/enrollment-drain' : '/api/v1/commands/enrollment-drain');
      headers = { 'x-node-token': getNodeManagerSecret() };
    } else {
      key = dashboardEnrollmentSecret(); const origin = new URL(process.env['DASHBOARD_PUBLIC_ORIGIN'] ?? '');
      if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
        throw new Error('Fixed HTTPS dashboard origin unavailable');
      url = origin.origin + '/api/internal/resource-enrollment/drain'; headers = { 'x-resource-drain-key': key };
    }
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(participant !== 'dashboard' ? 25_000 : 5_000),
      headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(prepared.descriptor) });
    const raw = await readReceipt(response);
    receipt = participant === 'scheduler' ? schedulerBoundaryReceiptSchema.parse(raw) : drainReceiptSchema.parse(raw);
    const { signature, ...unsigned } = receipt;
    const { status: _status, activeCount: _active, unknownCount: _unknown, evidenceSha256: _evidence,
      ...remaining } = unsigned;
    const descriptor = participant === 'scheduler'
      ? (({ scope: _scope, externalBlockers: _externalBlockers, ...value }) => value)(remaining as typeof remaining & { scope: string; externalBlockers: unknown })
      : remaining;
    if (canonical(descriptor) !== canonical(prepared.descriptor) || receipt.expiresAt <= Date.now()
      || !timingSafeEqual(Buffer.from(signature, 'hex'), createHmac('sha256', key).update(enrollmentSigningPayload(unsigned)).digest()))
      throw new Error('Participant receipt failed exact challenge authentication');
  } catch {
    // No raw provider error/body is exposed. Outstanding challenge remains pending.
    return { participant, status: 'pending', reason: 'participant-evidence-unavailable' };
  }
  return getDb().$transaction(async tx => {
    await lockResourceNode(tx, nodeId);
    const { row } = await identity(tx, nodeId);
    const ack = await tx.resourceDrainParticipant.findUnique({ where: { nodeId_participant: { nodeId, participant } } });
    if (row?.state !== 'draining' || row.epoch !== receipt.epoch || row.barrierId !== receipt.barrierId
      || ack?.challengeId !== receipt.challengeId || receipt.expiresAt <= Date.now())
      fail('RESOURCE_DRAIN_STALE', 'Participant evidence no longer matches the current drain');
    const central = await participantSnapshot(tx, nodeId, participant);
    const schedulerUnsettled = participant === 'scheduler'
      ? await tx.managedCronOccurrence.count({ where: { nodeId, state: { not: 'completed' } } }) : 0;
    const verified = participant !== 'scheduler' && schedulerUnsettled === 0 && receipt.status === 'drained'
      && receipt.activeCount === 0 && receipt.unknownCount === 0
      && central.activeCount === 0 && central.unknownCount === 0
      && (participant !== 'dashboard' || central.evidenceSha256 === receipt.evidenceSha256);
    await tx.resourceDrainParticipant.update({ where: { nodeId_participant: { nodeId, participant } }, data: {
      status: verified ? 'verified' : 'pending', evidenceSha256: receipt.evidenceSha256,
      receiptJson: JSON.stringify(receipt), verifiedAt: verified ? new Date() : null } });
    return { participant, status: verified ? 'verified' : 'pending', reason: verified ? 'signed-current-drain'
      : participant === 'scheduler' && receipt.status === 'managed-drained' && !receipt.activeCount && !receipt.unknownCount
        && !schedulerUnsettled && !central.activeCount && !central.unknownCount ? 'reviewed-boundary-required' : 'unsettled-work' };
  });
}
export async function acceptSchedulerBoundaryAttestation(nodeId: string, raw: unknown) {
  const assertion = schedulerBoundaryAttestationSchema.parse(raw);
  const { signature, ...unsigned } = assertion;
  const expected = createHmac('sha256', reconciliationSecret()).update(schedulerBoundaryAttestationSigningPayload(unsigned)).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex')))
    throw new HttpError(403, 'SCHEDULER_BOUNDARY_EVIDENCE_INVALID', 'Scheduler boundary review signature is invalid');
  return getDb().$transaction(async tx => {
    await lockResourceNode(tx, nodeId);
    const { node, row } = await identity(tx, nodeId);
    const ack = await tx.resourceDrainParticipant.findUnique({ where: { nodeId_participant: { nodeId, participant: 'scheduler' } } });
    let receipt: z.infer<typeof schedulerBoundaryReceiptSchema>;
    try { receipt = schedulerBoundaryReceiptSchema.parse(JSON.parse(ack?.receiptJson ?? 'null')); }
    catch { fail('SCHEDULER_BOUNDARY_EVIDENCE_INVALID', 'Current signed scheduler receipt is required'); }
    const { signature: receiptSignature, ...receiptUnsigned } = receipt;
    const signed = createHmac('sha256', RESULT_SIGNING_SECRET).update(enrollmentSigningPayload(receiptUnsigned)).digest();
    const central = await participantSnapshot(tx, nodeId, 'scheduler');
    const externalKeys = receipt.externalBlockers.map(source => source.kind + ':' + source.sourceSha256);
    if (row?.state !== 'draining' || !row.barrierId || nodeId !== assertion.nodeId || node.hostname !== assertion.nodeFqdn
      || row.epoch !== assertion.epoch || row.barrierId !== assertion.barrierId || ack?.epoch !== row.epoch
      || ack.barrierId !== row.barrierId || ack.challengeId !== assertion.challengeId
      || ack.challengeExpiresAt.getTime() <= Date.now() || receipt.expiresAt !== ack.challengeExpiresAt.getTime()
      || receipt.nodeId !== nodeId || receipt.nodeFqdn !== node.hostname || receipt.epoch !== row.epoch
      || receipt.barrierId !== row.barrierId || receipt.challengeId !== ack.challengeId
      || receipt.status !== 'managed-drained' || receipt.activeCount !== 0 || receipt.unknownCount !== 0
      || !receipt.externalBlockers.every(source => EXTERNAL_SCHEDULER_KINDS.has(source.kind))
      || new Set(externalKeys).size !== externalKeys.length
      || assertion.receiptSha256 !== createHash('sha256').update(ack.receiptJson!).digest('hex')
      || assertion.externalBlockersSha256 !== digest(receipt.externalBlockers)
      || assertion.observedAt < row.startedAt!.getTime() || assertion.observedAt < Date.now() - 300_000
      || assertion.observedAt > Date.now() + 60_000 || !timingSafeEqual(signed, Buffer.from(receiptSignature, 'hex'))
      || central.activeCount !== 0 || central.unknownCount !== 0
      || await tx.managedCronOccurrence.count({ where: { nodeId, state: { not: 'completed' } } }))
      fail('SCHEDULER_BOUNDARY_EVIDENCE_INVALID', 'Scheduler review does not bind current fenced work and observed external sources');
    await tx.resourceDrainParticipant.update({ where: { nodeId_participant: { nodeId, participant: 'scheduler' } }, data: {
      status: 'verified', receiptJson: JSON.stringify({ receipt, assertion }), verifiedAt: new Date() } });
    return { participant: 'scheduler' as const, status: 'verified' as const, reason: 'signed-reviewed-scheduler-boundary' as const };
  });
}
export async function acceptApiDrainAttestation(nodeId: string, raw: unknown) {
  const value = apiDrainAttestationSchema.parse(raw);
  const { signature, ...unsigned } = value;
  const expected = createHmac('sha256', reconciliationSecret()).update(apiDrainAttestationSigningPayload(unsigned)).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex')))
    throw new HttpError(403, 'RESOURCE_EVIDENCE_INVALID', 'API drain attestation signature is invalid');
  return getDb().$transaction(async tx => {
    await lockResourceNode(tx, nodeId);
    const { node, row } = await identity(tx, nodeId);
    const ack = await tx.resourceDrainParticipant.findUnique({ where: { nodeId_participant: { nodeId, participant: 'api' } } });
    const snapshot = await participantSnapshot(tx, nodeId, 'api');
    const hashes = [value.preinstrumentationSha256, value.localDescendantsSha256, value.sshDescendantsSha256];
    const expectedEvidence = digest({ nodeId, nodeFqdn: node.hostname, epoch: value.epoch, barrierId: value.barrierId,
      preinstrumentationSha256: hashes[0], localDescendantsSha256: hashes[1], sshDescendantsSha256: hashes[2] });
    if (row?.state !== 'draining' || !row.barrierId || node.id !== value.nodeId || node.hostname !== value.nodeFqdn
      || row.epoch !== value.epoch || row.barrierId !== value.barrierId
      || ack?.challengeId !== value.challengeId || ack.epoch !== value.epoch || ack.barrierId !== value.barrierId
      || ack.challengeExpiresAt.getTime() !== value.expiresAt || value.expiresAt <= Date.now()
      || !row.startedAt || value.observedAt < row.startedAt.getTime() || value.observedAt < Date.now() - 300_000
      || value.observedAt > Date.now() + 60_000 || new Set(hashes).size !== hashes.length
      || value.evidenceSha256 !== expectedEvidence || snapshot.activeCount !== 0 || snapshot.unknownCount !== 0)
      fail('RESOURCE_EVIDENCE_INVALID', 'API drain evidence does not bind the current barrier and zero work');
    if (ack.status === 'verified') {
      if (ack.receiptJson !== JSON.stringify(value)) fail('RESOURCE_WORK_CONFLICT', 'API drain challenge already has different evidence');
      return { participant: 'api' as const, status: 'verified' as const, reason: 'signed-reviewed-current-drain' as const };
    }
    await tx.resourceDrainParticipant.update({ where: { nodeId_participant: { nodeId, participant: 'api' } }, data: {
      status: 'verified', evidenceSha256: value.evidenceSha256, receiptJson: JSON.stringify(value), verifiedAt: new Date(),
    } });
    return { participant: 'api' as const, status: 'verified' as const, reason: 'signed-reviewed-current-drain' as const };
  });
}
export async function completeEnrollment(nodeId: string) {
  return getDb().$transaction(async tx => {
    await lockResourceNode(tx, nodeId);
    const { node, row } = await identity(tx, nodeId);
    if (row?.state === 'enrolled') return statusFields(node, row);
    if (row?.state !== 'draining') fail('RESOURCE_DRAIN_REQUIRED', 'Node must be draining');
    const acks = await tx.resourceDrainParticipant.findMany({ where: { nodeId } });
    const missing = PARTICIPANTS.filter(p => !acks.some(a => a.participant === p && a.status === 'verified'
      && a.epoch === row.epoch && a.barrierId === row.barrierId && a.challengeExpiresAt.getTime() > Date.now()));
    if (missing.length)
      fail('RESOURCE_DRAIN_INCOMPLETE', 'Enrollment pending authoritative agent, API, dashboard and scheduler drain integrations');
    for (const participant of PARTICIPANTS) {
      const ack = acks.find(a => a.participant === participant)!;
      if (participant === 'scheduler') {
        let reviewed: { receipt: z.infer<typeof schedulerBoundaryReceiptSchema>; assertion: z.infer<typeof schedulerBoundaryAttestationSchema> };
        try { reviewed = z.object({ receipt: schedulerBoundaryReceiptSchema, assertion: schedulerBoundaryAttestationSchema }).strict()
          .parse(JSON.parse(ack.receiptJson ?? 'null')); }
        catch { fail('RESOURCE_DRAIN_INCOMPLETE', 'Reviewed scheduler receipt is unavailable'); }
        const { receipt, assertion } = reviewed;
        const { signature: nodeSignature, ...nodeUnsigned } = receipt;
        const { signature: reviewSignature, ...reviewUnsigned } = assertion;
        const nodeSigned = createHmac('sha256', RESULT_SIGNING_SECRET).update(enrollmentSigningPayload(nodeUnsigned)).digest();
        const reviewSigned = createHmac('sha256', reconciliationSecret()).update(schedulerBoundaryAttestationSigningPayload(reviewUnsigned)).digest();
        const rawReceipt = JSON.stringify(receipt);
        if (receipt.nodeId !== nodeId || receipt.nodeFqdn !== node.hostname || receipt.epoch !== row.epoch
          || receipt.barrierId !== row.barrierId || receipt.challengeId !== ack.challengeId
          || receipt.expiresAt !== ack.challengeExpiresAt.getTime() || receipt.status !== 'managed-drained'
          || receipt.activeCount !== 0 || receipt.unknownCount !== 0 || receipt.evidenceSha256 !== ack.evidenceSha256
          || !receipt.externalBlockers.every(source => EXTERNAL_SCHEDULER_KINDS.has(source.kind))
          || assertion.nodeId !== nodeId || assertion.nodeFqdn !== node.hostname || assertion.epoch !== row.epoch
          || assertion.barrierId !== row.barrierId || assertion.challengeId !== ack.challengeId
          || assertion.receiptSha256 !== createHash('sha256').update(rawReceipt).digest('hex')
          || assertion.externalBlockersSha256 !== digest(receipt.externalBlockers)
          || !timingSafeEqual(nodeSigned, Buffer.from(nodeSignature, 'hex'))
          || !timingSafeEqual(reviewSigned, Buffer.from(reviewSignature, 'hex')))
          fail('RESOURCE_DRAIN_INCOMPLETE', 'Stored scheduler boundary failed current reviewed verification');
        continue;
      }
      let receipt: z.infer<typeof drainReceiptSchema> | z.infer<typeof apiDrainAttestationSchema>;
      try { receipt = participant === 'api'
        ? apiDrainAttestationSchema.parse(JSON.parse(ack.receiptJson ?? 'null'))
        : drainReceiptSchema.parse(JSON.parse(ack.receiptJson ?? 'null')); }
      catch { fail('RESOURCE_DRAIN_INCOMPLETE', 'Stored participant receipt is unavailable'); }
      const { signature, ...unsigned } = receipt;
      const key = participant === 'dashboard' ? dashboardEnrollmentSecret()
        : participant === 'api' ? reconciliationSecret() : RESULT_SIGNING_SECRET;
      const payload = participant === 'api'
        ? apiDrainAttestationSigningPayload(unsigned as Omit<z.infer<typeof apiDrainAttestationSchema>, 'signature'>)
        : enrollmentSigningPayload(unsigned);
      const signed = createHmac('sha256', key).update(payload).digest();
      if (receipt.participant !== participant || receipt.nodeId !== nodeId || receipt.nodeFqdn !== node.hostname
        || receipt.epoch !== row.epoch || receipt.barrierId !== row.barrierId
        || receipt.challengeId !== ack.challengeId || receipt.expiresAt !== ack.challengeExpiresAt.getTime()
        || receipt.status !== 'drained' || receipt.activeCount !== 0 || receipt.unknownCount !== 0
        || receipt.evidenceSha256 !== ack.evidenceSha256
        || !timingSafeEqual(signed, Buffer.from(signature, 'hex')))
        fail('RESOURCE_DRAIN_INCOMPLETE', 'Stored participant receipt failed exact current drain verification');
    }
    if (await tx.commandResourceLease.count({ where: { nodeId, state: { in: HELD } } })
      || await tx.resourceParticipantWork.count({ where: { nodeId, state: { in: HELD } } })
      || await tx.managedCronOccurrence.count({ where: { nodeId, state: { not: 'completed' } } }))
      fail('RESOURCE_DRAIN_INCOMPLETE', 'Owned or unknown work remains');
    const saved = await tx.resourceEnrollment.update({ where: { nodeId }, data: { state: 'enrolled', enrolledAt: new Date() } });
    return statusFields(node, saved);
  });
}
export const dashboardReserveSchema = z.object({ host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$/),
  workId: z.string().guid(), ownerId: z.string().guid(), kind: z.enum(['terminal-http', 'terminal-ws', 'hermes-http', 'hermes-ws']),
  operationSha256: z.string().regex(/^[a-f0-9]{64}$/), deadline: z.number().int().positive() }).strict();
export const dashboardStartSchema = z.object({ ownerId: z.string().guid(), epoch: z.number().int().nonnegative(), barrierId: z.string().guid().nullable(),
  operationSha256: z.string().regex(/^[a-f0-9]{64}$/), fence: z.string().regex(/^[1-9][0-9]{0,19}$/),
  deadline: z.number().int().positive(), requestSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const dashboardFinishSchema = z.object({ ownerId: z.string().guid(), disposition: z.enum(['not-started', 'remote-ended', 'unknown']),
  evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
// Fixed dashboard facade preserves the existing authenticated wire contract.
export const reserveDashboardWork = (input: z.infer<typeof dashboardReserveSchema>) => dashboardParticipantWork.reserve(input);
export const startDashboardWork = (workId: string, input: z.infer<typeof dashboardStartSchema>) => dashboardParticipantWork.start(workId, input);
export const finishDashboardWork = (workId: string, input: z.infer<typeof dashboardFinishSchema>) => dashboardParticipantWork.finish(workId, input);

/** Deployment preflight only: no enrollment, proof creation, or work admission. */
export async function dashboardParticipantReadiness() {
  try {
    await getDb().$transaction(async tx => {
      await tx.resourceEnrollment.findFirst({ select: { nodeId: true } });
      await tx.resourceDrainParticipant.findFirst({ select: { nodeId: true } });
      await tx.resourceParticipantWork.findFirst({ select: { workId: true } });
    }, { maxWait: 2_000, timeout: 3_000 });
  } catch {
    throw new HttpError(503, 'RESOURCE_PARTICIPANT_UNAVAILABLE', 'Durable participant schema is not ready');
  }
  return { version: 1 as const, participant: 'dashboard' as const, protocol: 'resource-enrollment-v1' as const, ready: true as const };
}
