/** Only authenticated cron administration creates scope; triggers consume immutable authority. */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';
import { managedCronSchema, managedCronRegistrationSchema, managedCronStageAckSchema,
  managedCronActivationAckSchema, managedCronRevocationAckSchema, cronDue,
  schedulerSourceSettlementSchema, schedulerSourceSettlementAckSchema,
  schedulerSourceSettlementSigningPayload, schedulerSourceSettlementReceiptPayload,
  cronEnrollmentStageSigningPayload, cronEnrollmentStageReceiptPayload, cronEnrollmentStageReceiptSchema,
  type ManagedCronIdentity, type SchedulerSourceSettlement } from '../schemas/managed-cron.js';
import { lockResourceNode } from './resource-node-lock.js';
import { assertNodeAdmissionOpen } from './admission-fence.js';
import { assertEnrollmentComplete } from './resource-enrollment.js';
import { admitResourceCommand, markResourceDispatched, settleResourceResult, resourceLeasesRequested, type ResourceAdmission } from './command-resource-leases.js';
import { commandRequestDigest, type CommandRequest } from '../security/command-request.js';
import { verifyCommandResultSignature, type SignedCommandResult } from '../security/command-result-signature.js';
import { RESULT_SIGNING_SECRET, RESULT_SIGNING_PREVIOUS_SECRET, getNodeManagerSecret } from '../utils/env.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { commandResultSchema } from '../schemas/node-responses.js';
import { NodeApiClient } from '../sdk/node-api-client.js';
import type { ManagedMutationEvidence } from '../sdk/node-api-client.js';
import type { Prisma } from '../db/generated/prisma/client.js';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const fail = (message: string): never => { throw new HttpError(409, 'SCHEDULER_AUTHORITY_CONFLICT', message); };
export { managedCronRegistrationSchema } from '../schemas/managed-cron.js';
export const schedulerTriggerSchema = z.object({ nodeFqdn: z.string().min(1).max(253),
  jobId: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().positive().max(2147483647),
  specSha256: z.string().regex(/^[a-f0-9]{64}$/), occurrenceId: z.string().regex(/^[a-f0-9]{64}$/),
  scheduledAt: z.number().int().nonnegative(), deadline: z.number().int().positive() }).strict();
export const schedulerSettleSchema = z.object({ nodeFqdn: z.string().min(1).max(253),
  occurrenceId: z.string().regex(/^[a-f0-9]{64}$/), result: commandResultSchema }).strict();
export type SchedulerTrigger = z.infer<typeof schedulerTriggerSchema>;

/** Raw cron remains a compatibility path only before activation and before the
 * node has any durable ownership history. Once either exists, mutations must
 * use the acknowledged managed lifecycle and an enrolled resource owner. */
export async function cronMutationMode(nodeId: string): Promise<'legacy' | 'managed'> {
  const db = getDb();
  return db.$transaction(async tx => {
    await lockResourceNode(tx, nodeId);
    const node = await tx.node.findUnique({ where: { id: nodeId } });
    if (!node) throw new HttpError(404, 'NODE_NOT_FOUND', 'Inventory node not found');
    const [enrollment, leaseHistory, definitionHistory, participantHistory] = await Promise.all([
      tx.resourceEnrollment.findUnique({ where: { nodeId }, select: { state: true } }),
      tx.commandResourceLease.findFirst({ where: { nodeId }, select: { id: true } }),
      tx.managedCronDefinition.findFirst({ where: { nodeId }, select: { cronJobId: true } }),
      tx.resourceParticipantWork.findFirst({ where: { nodeId }, select: { workId: true } }),
    ]);
    const managed = resourceLeasesRequested() || Boolean(enrollment && enrollment.state !== 'legacy')
      || Boolean(leaseHistory || definitionHistory || participantHistory);
    if (managed) await assertEnrollmentComplete(tx, nodeId, node.hostname);
    return managed ? 'managed' : 'legacy';
  });
}

async function stageManagedCronTx(tx: Prisma.TransactionClient, cronJobId: string,
  input: z.infer<typeof managedCronRegistrationSchema>, lock = true) {
    const initial = await tx.cronJob.findUnique({ where: { id: cronJobId } });
    if (!initial) throw new HttpError(404, 'NOT_FOUND', 'Cron job not found');
    if (lock) await lockResourceNode(tx, initial.nodeId);
    const job = await tx.cronJob.findUnique({ where: { id: cronJobId } });
    if (!job || job.status !== 'ACTIVE' || input.expiresAt <= Date.now()) return fail('Active job and explicit future expiry required');
    if (job.timeoutSeconds !== input.timeoutSeconds) return fail('Managed timeout must match the stored cron definition');
    // Explicit registration authorizes the supplied finite budget and UTC schedule.
    const node = await tx.node.findUniqueOrThrow({ where: { id: job.nodeId } });
    const spec = managedCronSchema.parse({ nodeFqdn: node.hostname, name: job.name, revision: input.revision, schedule: job.schedule,
      timezone: input.timezone, workingDirectory: job.workingDirectory ?? undefined,
      environment: JSON.parse(job.environment), command: job.command, args: JSON.parse(job.args),
      timeoutSeconds: input.timeoutSeconds, expiresAt: input.expiresAt });
    const specJson = JSON.stringify(spec); const specSha256 = hash(specJson); const jobId = hash(JSON.stringify([spec.nodeFqdn, spec.name]));
    const previous = await tx.managedCronDefinition.findUnique({ where: { cronJobId } });
    if (previous && (input.revision < previous.revision || input.revision === previous.revision && previous.specSha256 !== specSha256))
      return fail('A changed job requires an increased revision');
    const collision = await tx.managedCronDefinition.findUnique({ where: { nodeId_jobId: { nodeId: job.nodeId, jobId } } });
    if (collision && collision.cronJobId !== cronJobId) {
      if (collision.enabled || input.revision <= collision.revision) return fail('Managed scheduler identity is active or its revision was not advanced');
      return tx.managedCronDefinition.update({ where: { cronJobId: collision.cronJobId }, data: {
        cronJobId, revision: input.revision, specSha256, specJson, enabled: false,
        acknowledgementProtocolVersion: null, stageCommandSha256: null, stageReceiptSha256: null,
        stageAcknowledgedAt: null, activationCommandSha256: null, activationReceiptSha256: null,
        activationAcknowledgedAt: null, acknowledgedJobId: null, acknowledgedRevision: null,
        acknowledgedSpecSha256: null, acknowledgedSpecJson: null, expiresAt: new Date(input.expiresAt),
      } });
    }
    return tx.managedCronDefinition.upsert({ where: { cronJobId }, create: {
      cronJobId, nodeId: job.nodeId, jobId, revision: input.revision, specSha256, specJson, enabled: false, expiresAt: new Date(input.expiresAt),
    }, update: { jobId, revision: input.revision, specSha256, specJson, enabled: false,
      acknowledgementProtocolVersion: null, stageCommandSha256: null, stageReceiptSha256: null,
      stageAcknowledgedAt: null, activationCommandSha256: null, activationReceiptSha256: null,
      activationAcknowledgedAt: null, acknowledgedJobId: null, acknowledgedRevision: null,
      acknowledgedSpecSha256: null, acknowledgedSpecJson: null, expiresAt: new Date(input.expiresAt) } });
}

export async function registerManagedCron(cronJobId: string, input: z.infer<typeof managedCronRegistrationSchema>) {
  return getDb().$transaction(tx => stageManagedCronTx(tx, cronJobId, input));
}

export async function canStageLegacyCronForEnrollment(cronJobId: string): Promise<boolean> {
  if (resourceLeasesRequested()) return false;
  return getDb().$transaction(async tx => {
    const job = await tx.cronJob.findUnique({ where: { id: cronJobId } }); if (!job) return false;
    await lockResourceNode(tx, job.nodeId);
    const [enrollment, lease, definitions, participant] = await Promise.all([
      tx.resourceEnrollment.findUnique({ where: { nodeId: job.nodeId } }),
      tx.commandResourceLease.findFirst({ where: { nodeId: job.nodeId }, select: { id: true } }),
      tx.managedCronDefinition.findMany({ where: { nodeId: job.nodeId }, take: 2 }),
      tx.resourceParticipantWork.findFirst({ where: { nodeId: job.nodeId }, select: { workId: true } }),
    ]);
    if (enrollment && enrollment.state !== 'legacy' || lease || participant || definitions.length > 1) return false;
    const pending = definitions[0];
    return !pending || pending.cronJobId === cronJobId && !pending.enabled
      && pending.acknowledgementProtocolVersion === null && pending.stageCommandSha256 === null
      && pending.activationCommandSha256 === null;
  });
}

/** Persist disabled pending history before contacting the node. The exact
 * signed control message can only remove the same-name wake-up and store a
 * disabled local definition, so no raw mutation can reopen the race window. */
export async function stageLegacyCronForEnrollment(cronJobId: string,
  input: z.infer<typeof managedCronRegistrationSchema>) {
  if (!await canStageLegacyCronForEnrollment(cronJobId))
    return fail('Legacy scheduler conversion must finish before enrollment or other ownership history');
  const db = getDb();
  const candidate = await db.$transaction(async tx => {
    const job = await tx.cronJob.findUnique({ where: { id: cronJobId } });
    if (!job) throw new HttpError(404, 'NOT_FOUND', 'Cron job not found');
    await lockResourceNode(tx, job.nodeId);
    const [enrollment, lease, definitions, participant] = await Promise.all([
      tx.resourceEnrollment.findUnique({ where: { nodeId: job.nodeId } }),
      tx.commandResourceLease.findFirst({ where: { nodeId: job.nodeId }, select: { id: true } }),
      tx.managedCronDefinition.findMany({ where: { nodeId: job.nodeId }, take: 2 }),
      tx.resourceParticipantWork.findFirst({ where: { nodeId: job.nodeId }, select: { workId: true } }),
    ]);
    const pending = definitions[0];
    if (enrollment && enrollment.state !== 'legacy' || lease || participant || definitions.length > 1
      || pending && (pending.cronJobId !== cronJobId || pending.enabled
        || pending.acknowledgementProtocolVersion !== null || pending.stageCommandSha256 !== null
        || pending.activationCommandSha256 !== null))
      return fail('Enrollment or ownership changed during legacy scheduler conversion');
    const node = await tx.node.findUniqueOrThrow({ where: { id: job.nodeId } });
    const definition = await stageManagedCronTx(tx, cronJobId, input, false);
    return { node, definition, spec: managedCronSchema.parse(JSON.parse(definition.specJson)) };
  });
  const secret = process.env['COMMAND_RECONCILIATION_SECRET'] ?? '';
  const conflicts = [getNodeManagerSecret(), RESULT_SIGNING_SECRET, RESULT_SIGNING_PREVIOUS_SECRET,
    process.env['NODE_MANAGER_SECRET_PREVIOUS'] ?? '', process.env['RESOURCE_PARTICIPANT_RECONCILIATION_SECRET'] ?? ''];
  if (secret.length < 32 || conflicts.some(value => value && value === secret))
    return fail('Independent scheduler conversion authority is required');
  const unsigned = { version: 1 as const, nodeId: candidate.node.id, nodeFqdn: candidate.node.hostname,
    spec: candidate.spec, operationId: randomUUID(), expiresAt: Date.now() + 60_000 };
  const assertion = { ...unsigned, signature: createHmac('sha256', secret)
    .update(cronEnrollmentStageSigningPayload(unsigned)).digest('hex') };
  const client = new NodeApiClient({ baseUrl: getNodeBaseUrl(candidate.node.ipAddress, candidate.node.port),
    nodeToken: getNodeManagerSecret() });
  const staged = await client.stageManagedCronForEnrollment(assertion);
  if (!staged.success) return fail('Node did not acknowledge disabled legacy scheduler conversion');
  const ack = cronEnrollmentStageReceiptSchema.parse(staged.data);
  const { receiptSignature, ...receipt } = ack;
  if (ack.operationId !== unsigned.operationId
    || JSON.stringify(managedCronIdentity(candidate.definition)) !== JSON.stringify(managedCronIdentitySchemaValue(ack)))
    return fail('Node staged a different disabled legacy scheduler definition');
  const signatures = [RESULT_SIGNING_SECRET, RESULT_SIGNING_PREVIOUS_SECRET].filter(value => value.length >= 32)
    .map(value => createHmac('sha256', value).update(cronEnrollmentStageReceiptPayload(receipt)).digest());
  if (!signatures.some(value => timingSafeEqual(value, Buffer.from(receiptSignature, 'hex'))))
    return fail('Node scheduler conversion receipt signature is invalid');
  return candidate.definition;
}

export async function updateAndRegisterManagedCron(cronJobId: string, data: Prisma.CronJobUpdateInput,
  input: z.infer<typeof managedCronRegistrationSchema>) {
  return getDb().$transaction(async tx => {
    const initial = await tx.cronJob.findUnique({ where: { id: cronJobId } });
    if (!initial) throw new HttpError(404, 'NOT_FOUND', 'Cron job not found');
    await lockResourceNode(tx, initial.nodeId);
    const job = await tx.cronJob.update({ where: { id: cronJobId }, data, include: { node: true } });
    const definition = await stageManagedCronTx(tx, cronJobId, input, false);
    return { job, definition };
  });
}

export async function upsertAndRegisterManagedCron(nodeId: string, name: string,
  data: Omit<Prisma.CronJobUncheckedCreateInput, 'id' | 'nodeId' | 'name' | 'createdAt' | 'updatedAt'>,
  input: z.infer<typeof managedCronRegistrationSchema>) {
  return getDb().$transaction(async tx => {
    await lockResourceNode(tx, nodeId);
    const existing = await tx.cronJob.findUnique({ where: { nodeId_name: { nodeId, name } } });
    const job = existing ? await tx.cronJob.update({ where: { id: existing.id }, data })
      : await tx.cronJob.create({ data: { ...data, nodeId, name } });
    const definition = await stageManagedCronTx(tx, job.id, input, false);
    return { job, definition };
  });
}

export function managedCronIdentity(definition: { jobId: string; revision: number; specSha256: string; specJson: string }): ManagedCronIdentity {
  const spec = managedCronSchema.parse(JSON.parse(definition.specJson));
  return { nodeFqdn: spec.nodeFqdn, name: spec.name, jobId: definition.jobId,
    revision: definition.revision, specSha256: definition.specSha256 };
}

function exactManagedEvidence(raw: ManagedMutationEvidence): ManagedMutationEvidence {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(raw.commandId)
    || !/^[a-f0-9]{64}$/.test(raw.commandSha256) || !/^[a-f0-9]{64}$/.test(raw.receiptSha256)
    || !(raw.acknowledgedAt instanceof Date) || !Number.isFinite(raw.acknowledgedAt.getTime()))
    return fail('Managed scheduler receipt evidence is invalid');
  return raw;
}

export async function recordManagedCronStage(cronJobId: string, rawStage: unknown, rawEvidence: ManagedMutationEvidence) {
  const stage = managedCronStageAckSchema.parse(rawStage); const evidence = exactManagedEvidence(rawEvidence);
  return getDb().$transaction(async tx => {
    const initial = await tx.managedCronDefinition.findUnique({ where: { cronJobId } });
    if (!initial) return fail('Managed scheduler definition is absent');
    await lockResourceNode(tx, initial.nodeId);
    const current = await tx.managedCronDefinition.findUnique({ where: { cronJobId } });
    const job = await tx.cronJob.findUnique({ where: { id: cronJobId } });
    if (!current || current.enabled || !job || job.status !== 'ACTIVE'
      || JSON.stringify(managedCronIdentity(current)) !== JSON.stringify(managedCronIdentitySchemaValue(stage)))
      return fail('Managed scheduler definition changed before stage acknowledgement');
    return tx.managedCronDefinition.update({ where: { cronJobId }, data: {
      acknowledgementProtocolVersion: 1, stageCommandSha256: evidence.commandSha256,
      stageReceiptSha256: evidence.receiptSha256, stageAcknowledgedAt: evidence.acknowledgedAt,
      activationCommandSha256: null, activationReceiptSha256: null, activationAcknowledgedAt: null,
      acknowledgedJobId: null, acknowledgedRevision: null, acknowledgedSpecSha256: null, acknowledgedSpecJson: null,
    } });
  });
}

export async function activateManagedCron(cronJobId: string, rawStage: unknown, rawActivation: unknown,
  rawStageEvidence: ManagedMutationEvidence, rawActivationEvidence: ManagedMutationEvidence) {
  const stage = managedCronStageAckSchema.parse(rawStage);
  const activation = managedCronActivationAckSchema.parse(rawActivation);
  const stageEvidence = exactManagedEvidence(rawStageEvidence); const activationEvidence = exactManagedEvidence(rawActivationEvidence);
  if (JSON.stringify(managedCronIdentitySchemaValue(stage)) !== JSON.stringify(managedCronIdentitySchemaValue(activation)))
    return fail('Managed scheduler acknowledgements disagree');
  const db = getDb();
  return db.$transaction(async tx => {
    const definition = await tx.managedCronDefinition.findUnique({ where: { cronJobId } });
    if (!definition) return fail('Managed scheduler definition is absent');
    await lockResourceNode(tx, definition.nodeId);
    const current = await tx.managedCronDefinition.findUnique({ where: { cronJobId } });
    const job = await tx.cronJob.findUnique({ where: { id: cronJobId } });
    const expected = current && managedCronIdentity(current);
    if (!current || current.enabled || !job || job.status !== 'ACTIVE'
      || current.acknowledgementProtocolVersion !== 1
      || current.stageCommandSha256 !== stageEvidence.commandSha256
      || current.stageReceiptSha256 !== stageEvidence.receiptSha256
      || current.stageAcknowledgedAt?.getTime() !== stageEvidence.acknowledgedAt.getTime()
      || JSON.stringify(expected) !== JSON.stringify(managedCronIdentitySchemaValue(stage)))
      return fail('Managed scheduler definition changed before acknowledgement');
    return tx.managedCronDefinition.update({ where: { cronJobId }, data: { enabled: true,
      activationCommandSha256: activationEvidence.commandSha256,
      activationReceiptSha256: activationEvidence.receiptSha256,
      activationAcknowledgedAt: activationEvidence.acknowledgedAt,
      acknowledgedJobId: current.jobId, acknowledgedRevision: current.revision,
      acknowledgedSpecSha256: current.specSha256, acknowledgedSpecJson: current.specJson } });
  });
}

function managedCronIdentitySchemaValue(value: ManagedCronIdentity) {
  return { nodeFqdn: value.nodeFqdn, name: value.name, jobId: value.jobId, revision: value.revision, specSha256: value.specSha256 };
}

export async function prepareManagedCronRevocation(cronJobId: string) {
  const db = getDb();
  return db.$transaction(async tx => {
    const initial = await tx.managedCronDefinition.findUnique({ where: { cronJobId } });
    if (!initial) return null;
    await lockResourceNode(tx, initial.nodeId);
    const definition = await tx.managedCronDefinition.update({ where: { cronJobId }, data: { enabled: false,
      acknowledgementProtocolVersion: null, stageCommandSha256: null, stageReceiptSha256: null,
      stageAcknowledgedAt: null, activationCommandSha256: null, activationReceiptSha256: null,
      activationAcknowledgedAt: null, acknowledgedJobId: null, acknowledgedRevision: null,
      acknowledgedSpecSha256: null, acknowledgedSpecJson: null } });
    return { definition, identity: managedCronIdentity(definition) };
  });
}

export async function confirmManagedCronRevocation(cronJobId: string, expected: ManagedCronIdentity, raw: unknown) {
  const ack = managedCronRevocationAckSchema.parse(raw);
  if (JSON.stringify(expected) !== JSON.stringify({ nodeFqdn: ack.nodeFqdn, name: ack.name, jobId: ack.jobId,
    revision: ack.revision, specSha256: ack.specSha256 })) return fail('Managed scheduler revocation acknowledgement differs');
  const definition = await getDb().managedCronDefinition.findUnique({ where: { cronJobId } });
  if (!definition || definition.enabled || JSON.stringify(managedCronIdentity(definition)) !== JSON.stringify(expected))
    return fail('Managed scheduler definition changed during revocation');
  return definition;
}

export async function finalizeManagedCronRevocation(cronJobId: string, expected: ManagedCronIdentity,
  data: Prisma.CronJobUpdateInput | null) {
  return getDb().$transaction(async tx => {
    const initial = await tx.managedCronDefinition.findUnique({ where: { cronJobId } });
    if (!initial) return fail('Managed scheduler revocation history is absent');
    await lockResourceNode(tx, initial.nodeId);
    const definition = await tx.managedCronDefinition.findUnique({ where: { cronJobId } });
    if (!definition || definition.enabled || JSON.stringify(managedCronIdentity(definition)) !== JSON.stringify(expected))
      return fail('Managed scheduler authority changed after revocation acknowledgement');
    if (data === null) {
      await tx.cronJob.delete({ where: { id: cronJobId } });
      return null;
    }
    return tx.cronJob.update({ where: { id: cronJobId }, data, include: { node: true } });
  });
}

export async function installManagedCron(cronJobId: string, actorId: string) {
  const db = getDb();
  const definition = await db.managedCronDefinition.findUnique({ where: { cronJobId } });
  if (!definition || definition.enabled) return fail('A staged managed scheduler definition is required');
  const node = await db.node.findUnique({ where: { id: definition.nodeId } });
  if (!node) throw new HttpError(404, 'NODE_NOT_FOUND', 'Inventory node not found');
  const spec = managedCronSchema.parse(JSON.parse(definition.specJson));
  const client = new NodeApiClient({ baseUrl: getNodeBaseUrl(node.ipAddress, node.port), resourceNodeId: node.id,
    resourceActorId: actorId, nodeToken: getNodeManagerSecret() });
  const staged = await client.syncManagedCronJob(spec);
  if (!staged.response.success) return fail('Node did not acknowledge managed scheduler staging');
  const stageAck = managedCronStageAckSchema.parse(staged.response.data);
  if (JSON.stringify(managedCronIdentity(definition)) !== JSON.stringify(managedCronIdentitySchemaValue(stageAck)))
    return fail('Node staged a different managed scheduler definition');
  await recordManagedCronStage(cronJobId, stageAck, staged.evidence);
  const activated = await client.activateManagedCronJob(managedCronIdentity(definition));
  if (!activated.response.success) return fail('Node did not acknowledge managed scheduler activation');
  return activateManagedCron(cronJobId, stageAck, activated.response.data, staged.evidence, activated.evidence);
}

export async function revokeManagedCron(cronJobId: string, actorId: string) {
  const prepared = await prepareManagedCronRevocation(cronJobId);
  if (!prepared) return null;
  const node = await getDb().node.findUnique({ where: { id: prepared.definition.nodeId } });
  if (!node) throw new HttpError(404, 'NODE_NOT_FOUND', 'Inventory node not found');
  const client = new NodeApiClient({ baseUrl: getNodeBaseUrl(node.ipAddress, node.port), resourceNodeId: node.id,
    resourceActorId: actorId, nodeToken: getNodeManagerSecret() });
  const response = await client.revokeManagedCronJob(prepared.identity);
  if (!response.response.success) return fail('Node did not acknowledge managed scheduler revocation');
  await confirmManagedCronRevocation(cronJobId, prepared.identity, response.response.data);
  return prepared;
}

export async function reconcileForeignSchedulerSource(raw: SchedulerSourceSettlement) {
  const assertion = schedulerSourceSettlementSchema.parse(raw);
  const secret = process.env['COMMAND_RECONCILIATION_SECRET'] ?? '';
  const conflicting = [RESULT_SIGNING_SECRET, RESULT_SIGNING_PREVIOUS_SECRET, getNodeManagerSecret(), process.env['NODE_MANAGER_SECRET_PREVIOUS'] ?? '', process.env['API_SECRET'] ?? '',
    process.env['RESOURCE_PARTICIPANT_RECONCILIATION_SECRET'] ?? ''];
  // An expired, still-valid exact assertion may retrieve its retained terminal
  // receipt. The agent will never apply an expired decision that is absent.
  if (secret.length < 32 || conflicting.some(value => value && value === secret)
    || assertion.expiresAt > Date.now() + 300_000)
    throw new HttpError(403, 'SCHEDULER_RECONCILIATION_INVALID', 'Fresh independent scheduler reconciliation authority is required');
  const { signature, ...unsigned } = assertion;
  const expected = createHmac('sha256', secret).update(schedulerSourceSettlementSigningPayload(unsigned)).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex')))
    throw new HttpError(403, 'SCHEDULER_RECONCILIATION_INVALID', 'Scheduler reconciliation signature is invalid');
  const db = getDb();
  const node = await db.$transaction(async tx => {
    await lockResourceNode(tx, assertion.nodeId);
    const node = await tx.node.findUnique({ where: { id: assertion.nodeId } });
    const enrollment = await tx.resourceEnrollment.findUnique({ where: { nodeId: assertion.nodeId } });
    if (!node) throw new HttpError(404, 'NODE_NOT_FOUND', 'Inventory node not found');
    if (node.hostname !== assertion.nodeFqdn || !enrollment || enrollment.state !== 'draining'
      || enrollment.epoch !== assertion.epoch || enrollment.barrierId !== assertion.barrierId)
      fail('Scheduler reconciliation target or drain barrier differs');
    return node;
  });
  const client = new NodeApiClient({ baseUrl: getNodeBaseUrl(node.ipAddress, node.port), nodeToken: getNodeManagerSecret() });
  const response = await client.reconcileSchedulerSource(assertion);
  if (!response.success) return fail('Node rejected scheduler source reconciliation');
  const ack = schedulerSourceSettlementAckSchema.parse(response.data);
  const { receiptSignature, settled: _settled, replayed: _replayed, ...ackUnsigned } = ack;
  if (JSON.stringify(ackUnsigned) !== JSON.stringify(unsigned)) return fail('Node acknowledged a different scheduler source decision');
  const receipt = schedulerSourceSettlementReceiptPayload({ ...ackUnsigned, settled: true, replayed: ack.replayed });
  const signatures = [RESULT_SIGNING_SECRET, RESULT_SIGNING_PREVIOUS_SECRET].filter(value => value.length >= 32)
    .map(value => createHmac('sha256', value).update(receipt).digest());
  const received = Buffer.from(receiptSignature, 'hex');
  if (!signatures.some(value => timingSafeEqual(value, received))) return fail('Scheduler source receipt signature is invalid');
  return ack;
}

export async function admitCronOccurrence(raw: SchedulerTrigger) {
  const input = schedulerTriggerSchema.parse(raw); const db = getDb();
  const matches = await db.node.findMany({ where: { hostname: input.nodeFqdn }, take: 2 });
  const node = matches.length === 1 ? matches[0] : undefined;
  if (!node) return fail('Canonical node identity required');
  const prepared = await db.$transaction(async tx => {
    await lockResourceNode(tx, node.id);
    await assertNodeAdmissionOpen(tx, node.id);
    await assertEnrollmentComplete(tx, node.id, node.hostname);
    const definition = await tx.managedCronDefinition.findUnique({ where: { nodeId_jobId: { nodeId: node.id, jobId: input.jobId } } });
    if (!definition || !definition.enabled || definition.acknowledgementProtocolVersion !== 1
      || !definition.stageCommandSha256 || !definition.stageReceiptSha256 || !definition.stageAcknowledgedAt
      || !definition.activationCommandSha256 || !definition.activationReceiptSha256 || !definition.activationAcknowledgedAt
      || definition.acknowledgedJobId !== definition.jobId || definition.acknowledgedRevision !== definition.revision
      || definition.acknowledgedSpecSha256 !== definition.specSha256 || definition.acknowledgedSpecJson !== definition.specJson
      || definition.revision !== input.revision || definition.specSha256 !== input.specSha256)
      return fail('Job authority or exact acknowledgement evidence is absent or changed');
    const job = await tx.cronJob.findUnique({ where: { id: definition.cronJobId } });
    if (!job || job.status !== 'ACTIVE' || job.nodeId !== node.id) return fail('Cron job is no longer active');
    const spec = managedCronSchema.parse(JSON.parse(definition.specJson));
    if (hash(JSON.stringify(spec)) !== definition.specSha256 || hash(JSON.stringify([spec.nodeFqdn, spec.name])) !== input.jobId || spec.nodeFqdn !== node.hostname) return fail('Stored job binding differs');
    // Preserve exact authorized definition even if a legacy update escaped resync.
    if (job.name !== spec.name || job.command !== spec.command || job.schedule !== spec.schedule
      || JSON.stringify(JSON.parse(job.args)) !== JSON.stringify(spec.args)
      || (job.workingDirectory ?? undefined) !== spec.workingDirectory
      || JSON.stringify(JSON.parse(job.environment)) !== JSON.stringify(spec.environment)) return fail('Cron definition changed; explicit managed revision required');
    const now = Date.now();
    const deadline = Math.min(spec.expiresAt, input.scheduledAt + spec.timeoutSeconds * 1000);
    const occurrenceId = hash(JSON.stringify([input.jobId, input.revision, input.scheduledAt]));
    if (input.scheduledAt % 60_000 !== 0 || input.scheduledAt > now || now - input.scheduledAt >= 60_000
      || !cronDue(spec.schedule, input.scheduledAt) || input.deadline !== deadline || deadline <= now || input.occurrenceId !== occurrenceId)
      return fail('Occurrence timing, schedule or finite deadline differs');
    if (await tx.managedCronOccurrence.findUnique({ where: { id: occurrenceId } })) return fail('Occurrence already claimed; inspect its receipt without replay');
    const fence = await tx.commandResourceFence.upsert({ where: { resourceKey: `node:${node.id}` },
      create: { resourceKey: `node:${node.id}`, generation: 1n }, update: { generation: { increment: 1n } } });
    const coordination = { version: 1 as const, resourceKey: `node:${node.id}`, fence: fence.generation.toString(), expiresAt: deadline };
    const payload: CommandRequest = { commandId: 'cron-' + occurrenceId, command: spec.command, args: spec.args,
      workingDirectory: spec.workingDirectory, environment: spec.environment, timeoutSeconds: spec.timeoutSeconds, coordination };
    await tx.remoteCommand.create({ data: { id: payload.commandId, nodeId: node.id, command: payload.command,
      args: JSON.stringify(payload.args), environment: JSON.stringify(payload.environment ?? {}), workingDirectory: payload.workingDirectory,
      timeoutSeconds: payload.timeoutSeconds, status: 'RUNNING', createdBy: job.createdBy,
      idempotencyKey: 'managed-cron:' + occurrenceId, correlationId: 'managed-cron:' + definition.cronJobId,
      startedAt: new Date(), executionDeadline: new Date(deadline), coordinationJson: JSON.stringify(coordination) } });
    await tx.managedCronOccurrence.create({ data: { id: occurrenceId, cronJobId: definition.cronJobId, nodeId: node.id,
      revision: input.revision, specSha256: input.specSha256, scheduledAt: new Date(input.scheduledAt), deadline: new Date(deadline), commandId: payload.commandId } });
    return { payload, actorId: job.createdBy };
  });
  // Existing admission owns the same node lock in its own transaction. A crash at
  // any boundary keeps the immutable occurrence; callers cannot materialize it twice.
  try {
    const admission = await admitResourceCommand({ nodeId: node.id, actorId: prepared.actorId, baseUrl: getNodeBaseUrl(node.ipAddress, node.port) }, prepared.payload);
    if (!admission) return fail('Managed scheduler requires durable resource admission');
    await markResourceDispatched(admission, async tx => {
      const current = await tx.managedCronDefinition.findUnique({ where: { nodeId_jobId: { nodeId: node.id, jobId: input.jobId } } });
      const currentJob = current && await tx.cronJob.findUnique({ where: { id: current.cronJobId } });
      if (!current?.enabled || current.revision !== input.revision || current.specSha256 !== input.specSha256
        || !currentJob || currentJob.status !== 'ACTIVE') return fail('Job authority changed before occurrence dispatch');
    });
    await db.managedCronOccurrence.update({ where: { id: input.occurrenceId }, data: { state: 'running', admissionJson: JSON.stringify(admission) } });
    return { occurrenceId: input.occurrenceId, specSha256: input.specSha256, commandId: prepared.payload.commandId,
      coordination: admission.payload.coordination!, claim: { leaseId: admission.leaseId, nodeId: node.id, nodeFqdn: node.hostname },
      requestSha256: commandRequestDigest(admission.payload) };
  } catch (error) {
    await db.managedCronOccurrence.updateMany({ where: { id: input.occurrenceId, state: { in: ['admitting', 'running'] } }, data: { state: 'unknown' } });
    throw error;
  }
}

export async function cronOccurrenceStatus(nodeFqdn: string, occurrenceId: string) {
  const db = getDb(); const row = await db.managedCronOccurrence.findUnique({ where: { id: occurrenceId } });
  const node = row && await db.node.findUnique({ where: { id: row.nodeId } });
  if (!row || !node || node.hostname !== nodeFqdn) throw new HttpError(404, 'NOT_FOUND', 'Occurrence not found');
  const command = await db.remoteCommand.findUnique({ where: { id: row.commandId } });
  return { occurrenceId: row.id, state: row.state, commandId: row.commandId, revision: row.revision,
    specSha256: row.specSha256, deadline: row.deadline.getTime(), commandStatus: command?.status ?? 'unknown' };
}

export async function settleCronOccurrence(raw: z.infer<typeof schedulerSettleSchema>) {
  const input = schedulerSettleSchema.parse(raw); const db = getDb();
  const status = await cronOccurrenceStatus(input.nodeFqdn, input.occurrenceId);
  const row = await db.managedCronOccurrence.findUniqueOrThrow({ where: { id: input.occurrenceId } });
  const admission = row.admissionJson ? JSON.parse(row.admissionJson) as ResourceAdmission : null;
  const result = input.result as SignedCommandResult;
  if (!admission || result.commandId !== status.commandId || result.coordination?.requestSha256 !== commandRequestDigest(admission.payload)
    || !verifyCommandResultSignature(result, RESULT_SIGNING_SECRET, RESULT_SIGNING_PREVIOUS_SECRET)) return fail('Signed original supervisor completion is required');
  const authority = await db.commandResourceLease.findUnique({ where: { commandId: status.commandId } });
  if (authority?.completionClass !== 'managed-scheduler' || authority.completionOccurrenceId !== row.id
    || authority.completionSpecSha256 !== row.specSha256) return fail('Immutable scheduler completion authority differs');
  await settleResourceResult(status.commandId, result);
  return db.$transaction(async tx => {
    await lockResourceNode(tx, row.nodeId);
    const lease = await tx.commandResourceLease.findUnique({ where: { commandId: row.commandId } });
    if (lease?.state !== 'released' || lease.settlement !== 'signed-command-result' || lease.evidenceSha256 !== hash(JSON.stringify(result))) return fail('Resource completion is not proven');
    await tx.remoteCommand.update({ where: { id: row.commandId }, data: { status: result.exitCode === 0 ? 'COMPLETED' : 'FAILED', completedAt: new Date() } });
    await tx.commandResult.upsert({ where: { commandId: row.commandId }, update: {}, create: {
      commandId: row.commandId, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs, truncated: result.truncated } });
    await tx.managedCronOccurrence.update({ where: { id: row.id }, data: { state: 'completed' } });
    return { occurrenceId: row.id, state: 'completed' as const };
  });
}
