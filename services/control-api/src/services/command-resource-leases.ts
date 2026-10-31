import type { Prisma } from '../db/generated/prisma/client.js';
import { assertEnrollmentComplete, lockResourceNode } from './resource-enrollment.js';
import { assertArdentScope } from './ardent-scope-enrollment.js';
import { assertNodeAdmissionOpen } from './admission-fence.js';
/** Finite managed-command ownership. This is coordination, never action approval.
 * Default-off until dashboard terminal and SSH lifecycle coverage is complete.
 * A node requires the explicit durable participant drain before its first lease; switching the flag off does
 * not remove held/unknown ownership or permit a legacy bypass on that node.
 */
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';
import { commandRequestDigest, type CommandRequest } from '../security/command-request.js';
import { commandFenceSchema } from '../schemas/node-responses.js';
import type { SignedCommandResult } from '../security/command-result-signature.js';
import { verifyCommandResultSignature } from '../security/command-result-signature.js';
import { RESULT_SIGNING_SECRET, RESULT_SIGNING_PREVIOUS_SECRET } from '../utils/env.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { COMMAND_COMPLETION_REGISTRY, COMMAND_COMPLETION_REGISTRY_SHA256, commandCompletionDescriptor } from '../security/command-completion-registry.js';
import { MANAGED_HTTP_COMMAND } from '../security/managed-http.js';
import { NATIVE_COMPLETION_REGISTRY, NATIVE_COMPLETION_REGISTRY_SHA256, nativeCompletionDescriptor } from '../security/native-completion-registry.js';

const HELD = ['reserved', 'running', 'unknown'];
export class ResourceLeaseConflict extends HttpError {
  constructor() { super(409, 'RESOURCE_LEASE_CONFLICT', 'Node or service has an unsettled command owner; reconcile its evidence before retrying'); }
}
export interface ResourceCommandContext { nodeId: string; actorId: string; baseUrl: string; scope?: 'ardent-managed-http' }
export interface ResourceAdmission { leaseId: string; commandId: string; nodeId: string; nodeFqdn: string; payload: CommandRequest }
export function resourceLeasesRequested(): boolean { return process.env['MAGNUS_RESOURCE_LEASES_ENABLED'] === 'true'; }

function canonicalServiceUnit(value: unknown): string {
  // A narrow scope is granted only to the exact allowlisted immutable runbook.
  // Arbitrary shell syntax, aliases, user units and wrapper commands stay node-wide.
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,100}\.service$/.test(value))
    throw new HttpError(409, 'RESOURCE_SCOPE_INVALID', 'Approved system service identity is invalid');
  return value;
}

async function completionAuthority(tx: Prisma.TransactionClient, payload: CommandRequest,
  command: { id: string; nodeId: string; correlationId: string | null; idempotencyKey: string }, nodeId: string): Promise<{
    completionClass:string; completionRegistryVersion?:number; completionRegistrySha256?:string;
    completionDescriptorId?:string; completionOccurrenceId?:string; completionSpecSha256?:string }> {
  const occurrenceId = payload.commandId.startsWith('cron-') ? payload.commandId.slice('cron-'.length) : '';
  if (/^[a-f0-9]{64}$/.test(occurrenceId) && command.nodeId === nodeId
    && command.idempotencyKey === `managed-cron:${occurrenceId}` && command.correlationId?.startsWith('managed-cron:')) {
    const occurrence = await tx.managedCronOccurrence.findUnique({ where: { commandId: command.id } });
    const definition = occurrence && await tx.managedCronDefinition.findUnique({ where: { cronJobId: occurrence.cronJobId } });
    try {
      const spec = definition ? JSON.parse(definition.specJson) as Record<string, unknown> : null;
      const canonicalSpec = spec && createHash('sha256').update(JSON.stringify(spec)).digest('hex');
      const canonicalOccurrence = occurrence && definition && createHash('sha256')
        .update(JSON.stringify([definition.jobId, occurrence.revision, occurrence.scheduledAt.getTime()])).digest('hex');
      if (occurrence && definition && definition.enabled && definition.acknowledgementProtocolVersion === 1
        && definition.stageCommandSha256 && definition.stageReceiptSha256 && definition.stageAcknowledgedAt
        && definition.activationCommandSha256 && definition.activationReceiptSha256 && definition.activationAcknowledgedAt
        && definition.acknowledgedJobId === definition.jobId && definition.acknowledgedRevision === definition.revision
        && definition.acknowledgedSpecSha256 === definition.specSha256 && definition.acknowledgedSpecJson === definition.specJson
        && occurrence.id === occurrenceId && canonicalOccurrence === occurrenceId
        && occurrence.nodeId === nodeId && occurrence.commandId === payload.commandId && occurrence.state === 'admitting'
        && occurrence.cronJobId === definition.cronJobId && command.correlationId === `managed-cron:${definition.cronJobId}`
        && occurrence.revision === definition.revision && occurrence.specSha256 === definition.specSha256
        && canonicalSpec === definition.specSha256 && occurrence.deadline.getTime() === payload.coordination?.expiresAt
        && spec?.['command'] === payload.command && JSON.stringify(spec?.['args']) === JSON.stringify(payload.args)
        && (spec?.['workingDirectory'] ?? undefined) === payload.workingDirectory
        && JSON.stringify(spec?.['environment'] ?? {}) === JSON.stringify(payload.environment ?? {})
        && spec?.['timeoutSeconds'] === payload.timeoutSeconds)
        return { completionClass: 'managed-scheduler', completionOccurrenceId: occurrence.id,
          completionSpecSha256: occurrence.specSha256 };
    } catch { /* Corrupt or changed scheduler identity remains unverified. */ }
  }
  const descriptor = commandCompletionDescriptor(payload);
  if (descriptor) return { completionClass: 'node-supervised-command', completionRegistryVersion: COMMAND_COMPLETION_REGISTRY.version,
    completionRegistrySha256: COMMAND_COMPLETION_REGISTRY_SHA256, completionDescriptorId: descriptor.id };
  if (payload.command === MANAGED_HTTP_COMMAND && payload.args.length === 3 && /^[a-f0-9]{64}$/.test(payload.args[2]!)) {
    const native = nativeCompletionDescriptor(payload.args[0]!, payload.args[1]!);
    if (native) return { completionClass: 'native-http', completionRegistryVersion: NATIVE_COMPLETION_REGISTRY.version,
      completionRegistrySha256: NATIVE_COMPLETION_REGISTRY_SHA256, completionDescriptorId: native.id };
  }
  return { completionClass: 'unverified' };
}

export async function admitResourceCommand(context: ResourceCommandContext, raw: CommandRequest): Promise<ResourceAdmission | null> {
  const db = getDb();
  const payload = structuredClone(raw);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(payload.commandId)
    || typeof payload.command !== 'string' || !payload.command || !Array.isArray(payload.args)
    || payload.args.some(arg => typeof arg !== 'string') || !Number.isInteger(payload.timeoutSeconds)
    || payload.timeoutSeconds < 1 || payload.timeoutSeconds > 3600)
    throw new HttpError(400, 'INVALID_COMMAND', 'A finite well-formed command is required');
  const scopedArdent = context.scope === 'ardent-managed-http'
    && payload.command === MANAGED_HTTP_COMMAND && payload.args.length === 3
    && payload.args[0] === 'POST' && payload.args[1] === '/ardent/action'
    && /^[a-f0-9]{64}$/.test(payload.args[2]!)
    && payload.timeoutSeconds <= 900 && !payload.workingDirectory
    && Object.keys(payload.environment ?? {}).length === 0 && !payload.coordination;
  if (context.scope && !scopedArdent)
    throw new HttpError(409, 'RESOURCE_SCOPE_INVALID', 'Ardent scope accepts only the reviewed native action');
  return db.$transaction(async tx => {
    // One canonical node lock orders node-wide and service-specific admissions.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`command-resource-node:${context.nodeId}`}, 0))`;
    const node = await tx.node.findUnique({ where: { id: context.nodeId } });
    if (!node || getNodeBaseUrl(node.ipAddress, node.port).replace(/\/$/, '') !== context.baseUrl.replace(/\/$/, ''))
      throw new HttpError(409, 'RESOURCE_TARGET_INVALID', 'Canonical command target differs from inventory');
    await assertNodeAdmissionOpen(tx, node.id);
    const enrollment = await tx.resourceEnrollment.findUnique({ where: { nodeId: node.id } });
    if (!scopedArdent && !resourceLeasesRequested() && (!enrollment || enrollment.state === 'legacy')
      && !await tx.commandResourceLease.findFirst({ where: { nodeId: node.id }, select: { id: true } })) return null;
    if (scopedArdent) await assertArdentScope(tx, node.id, node.hostname);
    else await assertEnrollmentComplete(tx, node.id, node.hostname);
    if (await tx.resourceParticipantWork.findFirst({ where: { nodeId: node.id,
      ...(scopedArdent ? { participant: { in: ['agent', 'api', 'dashboard'] } } : {}), state: { in: HELD } } })) throw new ResourceLeaseConflict();
    if (node.status !== 'ONLINE' || !node.lastHeartbeatAt || Date.now() - node.lastHeartbeatAt.getTime() > 120_000)
      throw new HttpError(409, 'RESOURCE_TARGET_INVALID', 'Canonical command target lacks fresh online health');
    if (await tx.commandResourceLease.findUnique({ where: { commandId: payload.commandId } }))
      throw new HttpError(409, 'COMMAND_ALREADY_OWNED', 'Command already has a durable resource owner; inspect its receipt without replaying');
    let command = await tx.remoteCommand.findUnique({ where: { id: payload.commandId } });
    const directCommand = !command;
    let serviceUnit: string | null = null;
    if (command) {
      if (scopedArdent) throw new HttpError(409, 'RESOURCE_SCOPE_INVALID', 'Ardent scope requires a fresh direct native action');
      const stored: CommandRequest = { commandId: command.id, command: command.command, args: JSON.parse(command.args),
        timeoutSeconds: command.timeoutSeconds, workingDirectory: command.workingDirectory ?? undefined,
        environment: JSON.parse(command.environment),
        ...(command.coordinationJson ? { coordination: commandFenceSchema.parse(JSON.parse(command.coordinationJson)) } : {}) };
      if (command.nodeId !== node.id || command.status !== 'RUNNING' || commandRequestDigest(stored) !== commandRequestDigest(payload))
        throw new HttpError(409, 'COMMAND_OWNER_MISMATCH', 'Durable command differs from its claimed execution');
      if (command.correlationId?.startsWith('remediation_')) {
        const { validateRemediationCommandForDispatch } = await import('./remediation-service.js');
        await validateRemediationCommandForDispatch(command);
        const remediation = await tx.remediationExecution.findUnique({ where: { id: command.correlationId.slice('remediation_'.length) } });
        if (remediation && JSON.parse(remediation.input).runbookVersion === 'restart-service.v1') {
          if (payload.command !== '/usr/bin/systemctl' || payload.args.length !== 2 || payload.args[0] !== 'restart')
            throw new HttpError(409, 'RESOURCE_SCOPE_INVALID', 'Restart plan is not a typed system service action');
          serviceUnit = canonicalServiceUnit(payload.args[1]);
        }
      }
    }
    const resourceKey = scopedArdent ? `node:${node.id}:ardent`
      : serviceUnit ? `node:${node.id}:system-service:${serviceUnit}` : `node:${node.id}:all`;
    const coordinationKey = scopedArdent ? resourceKey : `node:${node.id}`;
    // The node ledger has one execution slot: service metadata never promises parallel fences.
    const conflict = await tx.commandResourceLease.findFirst({ where: { nodeId: node.id, state: { in: HELD } } });
    if (conflict) throw new ResourceLeaseConflict();
    const now = new Date();
    if (payload.coordination) {
      commandFenceSchema.parse(payload.coordination);
      if (payload.coordination.resourceKey !== coordinationKey || !command?.executionDeadline
        || command.executionDeadline.getTime() !== payload.coordination.expiresAt || payload.coordination.expiresAt <= now.getTime())
        throw new HttpError(409, 'RESOURCE_DEADLINE_INVALID', 'Existing approval deadline and node fence must remain exact');
    } else {
      if (command?.executionDeadline) throw new HttpError(409, 'RESOURCE_DEADLINE_INVALID', 'Approved execution is missing its fence');
      const fence = await tx.commandResourceFence.upsert({ where: { resourceKey: coordinationKey },
        create: { resourceKey: coordinationKey, generation: 1n }, update: { generation: { increment: 1n } } });
      payload.coordination = { version: 1, resourceKey: coordinationKey, fence: fence.generation.toString(),
        expiresAt: now.getTime() + (payload.timeoutSeconds + 10) * 1000 };
    }
    const coordinationJson = JSON.stringify(payload.coordination);
    if (!command) {
      command = await tx.remoteCommand.create({ data: { id: payload.commandId, nodeId: node.id,
        command: payload.command, args: JSON.stringify(payload.args), environment: JSON.stringify(payload.environment ?? {}),
        workingDirectory: payload.workingDirectory ?? null, timeoutSeconds: payload.timeoutSeconds,
        idempotencyKey: `resource-direct:${payload.commandId}`, status: 'RUNNING', startedAt: now,
        createdBy: context.actorId, executionDeadline: new Date(payload.coordination.expiresAt), coordinationJson } });
    } else if (!command.coordinationJson) {
      await tx.remoteCommand.update({ where: { id: command.id }, data: {
        executionDeadline: new Date(payload.coordination.expiresAt), coordinationJson } });
    }
    const completion = await completionAuthority(tx, payload, command, node.id);
    const lease = await tx.commandResourceLease.create({ data: { id: nanoid(), nodeId: node.id, resourceKey,
      serviceUnit, commandId: payload.commandId, ownerActor: command.createdBy, directCommand,
      requestSha256: commandRequestDigest(payload), coordinationJson, deadline: new Date(payload.coordination.expiresAt), ...completion } });
    return { leaseId: lease.id, commandId: payload.commandId, nodeId: node.id, nodeFqdn: node.hostname, payload };
  });
}

/** Persist intent immediately before the sole POST; interruption from here is unknown. */
export async function markResourceDispatched(admission: ResourceAdmission, verifyBeforeDispatch?: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  await getDb().$transaction(async tx => {
    await lockResourceNode(tx, admission.nodeId);
    await assertNodeAdmissionOpen(tx, admission.nodeId);
    const lease = await tx.commandResourceLease.findUnique({ where: { id: admission.leaseId } });
    if (lease?.resourceKey === `node:${admission.nodeId}:ardent`
      && lease.commandId === admission.commandId && lease.completionDescriptorId === 'ardent-action')
      await assertArdentScope(tx, admission.nodeId, admission.nodeFqdn);
    else await assertEnrollmentComplete(tx, admission.nodeId, admission.nodeFqdn);
    await verifyBeforeDispatch?.(tx);
    const changed = await tx.commandResourceLease.updateMany({ where: { id: admission.leaseId, commandId: admission.commandId,
      state: 'reserved', deadline: { gt: new Date() } }, data: { state: 'running', dispatchedAt: new Date() } });
    if (changed.count !== 1) throw new HttpError(409, 'RESOURCE_DEADLINE_INVALID', 'Resource admission expired or changed before dispatch');
  });
}

export async function failResourceCommand(admission: ResourceAdmission): Promise<void> {
  const db = getDb();
  await db.$transaction(async tx => {
    const row = await tx.commandResourceLease.findUnique({ where: { id: admission.leaseId } });
    if (!row || row.state === 'released') return;
    const notSent = row.state === 'reserved';
    const changed = await tx.commandResourceLease.updateMany({ where: { id: row.id, state: row.state }, data: notSent
      ? { state: 'released', settledAt: new Date(), settlement: 'not-dispatched',
          evidenceSha256: createHash('sha256').update(`pre-post:${row.commandId}:${row.requestSha256}`).digest('hex') }
      : { state: 'unknown' } });
    if (!changed.count) return;
    if (row.directCommand) {
      await tx.remoteCommand.updateMany({ where: { id: row.commandId, status: 'RUNNING' }, data: { status: 'FAILED', completedAt: new Date() } });
      await tx.commandResult.upsert({ where: { commandId: row.commandId }, update: {}, create: {
        commandId: row.commandId, exitCode: -1, stdout: '', durationMs: 0,
        stderr: notSent ? 'Resource admission ended before dispatch.' : 'Execution outcome unknown; resource ownership retained until verified evidence reconciliation.' } });
    }
  });
}

export async function retainUnknownResourceCommand(commandId: string): Promise<void> {
  await getDb().$transaction(async tx => {
    // Persisted 'reserved' proves the sole POST barrier was never crossed. This
    // CAS also makes a delayed markResourceDispatched fail before any network I/O.
    const row = await tx.commandResourceLease.findUnique({ where: { commandId } });
    if (!row) return;
    const stopped = await tx.commandResourceLease.updateMany({ where: { commandId, state: 'reserved' }, data: {
      state: 'released', settledAt: new Date(), settlement: 'not-dispatched',
      evidenceSha256: createHash('sha256').update(`recovered-pre-post:${commandId}:${row.requestSha256}`).digest('hex') } });
    if (!stopped.count) await tx.commandResourceLease.updateMany({ where: { commandId, state: 'running' }, data: { state: 'unknown' } });
  });
}

/** A signed, digest/fence-bound finite execution result is settlement evidence.
 * Exit != 0 is known completion, not proof of application recovery or rollback. */
export async function settleResourceResult(commandId: string, result: SignedCommandResult): Promise<void> {
  const db = getDb();
  const row = await db.commandResourceLease.findUnique({ where: { commandId } });
  if (!row) return;
  const registered = row.completionClass === 'node-supervised-command'
    && row.completionRegistryVersion === COMMAND_COMPLETION_REGISTRY.version
    && row.completionRegistrySha256 === COMMAND_COMPLETION_REGISTRY_SHA256
    && COMMAND_COMPLETION_REGISTRY.descriptors.some(descriptor => descriptor.id === row.completionDescriptorId);
  const native = row.completionClass === 'native-http'
    && row.completionRegistryVersion === NATIVE_COMPLETION_REGISTRY.version
    && row.completionRegistrySha256 === NATIVE_COMPLETION_REGISTRY_SHA256
    && NATIVE_COMPLETION_REGISTRY.descriptors.some(descriptor => descriptor.id === row.completionDescriptorId);
  const scheduler = row.completionClass === 'managed-scheduler'
    && /^[a-f0-9]{64}$/.test(row.completionOccurrenceId ?? '')
    && /^[a-f0-9]{64}$/.test(row.completionSpecSha256 ?? '')
    && row.completionRegistryVersion === null && row.completionRegistrySha256 === null && row.completionDescriptorId === null;
  const authorityMatches = registered ? result.completion?.registryVersion === row.completionRegistryVersion
      && result.completion.registrySha256 === row.completionRegistrySha256
      && result.completion.descriptorId === row.completionDescriptorId
    : native || scheduler ? result.completion === undefined : false;
  if (!authorityMatches)
    throw new HttpError(409, 'RESOURCE_EVIDENCE_INVALID', 'Command lacks its exact registered whole-effect evidence');
  if (!verifyCommandResultSignature(result, RESULT_SIGNING_SECRET, RESULT_SIGNING_PREVIOUS_SECRET)
    || result.commandId !== commandId || result.coordination?.requestSha256 !== row.requestSha256
    || JSON.stringify(result.coordination && { version: result.coordination.version, resourceKey: result.coordination.resourceKey,
      fence: result.coordination.fence, expiresAt: result.coordination.expiresAt }) !== row.coordinationJson)
    throw new HttpError(409, 'RESOURCE_EVIDENCE_INVALID', 'Signed result does not settle the owned request/fence');
  const evidence = createHash('sha256').update(JSON.stringify(result)).digest('hex');
  await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`command-resource-node:${row.nodeId}`}, 0))`;
    const changed = await tx.commandResourceLease.updateMany({ where: { id: row.id, state: { in: HELD } }, data: {
      state: 'released', settledAt: new Date(), settlement: 'signed-command-result', evidenceSha256: evidence } });
    if (!changed.count) return;
    if (row.directCommand) {
      await tx.remoteCommand.update({ where: { id: commandId }, data: { status: result.exitCode === 0 ? 'COMPLETED' : 'FAILED', completedAt: new Date() } });
      await tx.commandResult.upsert({ where: { commandId }, create: { commandId, exitCode: result.exitCode,
        stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs, truncated: result.truncated },
        update: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs, truncated: result.truncated } });
    }
  });
}

/** Adopt the node's already verified explicit reconciliation receipt. A local
 * timeout, command status, heartbeat or arbitrary evidence URL never releases. */
export async function settleResourceReconciliation(nodeId: string, assertion: import('../sdk/node-api-client.js').CommandReconciliationAssertion): Promise<void> {
  const { createHmac, timingSafeEqual } = await import('node:crypto');
  const { commandReconciliationSigningPayload, commandReconciliationSchema } = await import('../sdk/node-api-client.js');
  const { getNodeManagerSecret } = await import('../utils/env.js');
  const value = commandReconciliationSchema.parse(assertion);
  const secret = process.env['COMMAND_RECONCILIATION_SECRET'] ?? '';
  if (secret.length < 32 || secret === RESULT_SIGNING_SECRET || secret === getNodeManagerSecret()
    || !timingSafeEqual(createHmac('sha256', secret).update(commandReconciliationSigningPayload(value)).digest(), Buffer.from(value.signature, 'hex')))
    throw new HttpError(403, 'RESOURCE_EVIDENCE_INVALID', 'Explicit reconciliation signature is invalid');
  const db = getDb();
  await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`command-resource-node:${nodeId}`}, 0))`;
    const row = await tx.commandResourceLease.findUnique({ where: { commandId: value.commandId } });
    const node = await tx.node.findUnique({ where: { id: nodeId } });
    if (!row || !node || row.nodeId !== nodeId || value.nodeFqdn !== node.hostname
      || value.requestSha256 !== row.requestSha256 || JSON.stringify(value.coordination ?? null) !== row.coordinationJson)
      throw new HttpError(409, 'RESOURCE_EVIDENCE_INVALID', 'Explicit reconciliation does not bind this node, owner, request and fence');
    if (row.state === 'released') return;
    await tx.commandResourceLease.update({ where: { id: row.id }, data: { state: 'released', settledAt: new Date(),
      settlement: `signed-reconciliation:${value.disposition}`, evidenceSha256: value.evidenceSha256 } });
    // Reconciliation does not invent an exit code or promote execution success.
  });
}
