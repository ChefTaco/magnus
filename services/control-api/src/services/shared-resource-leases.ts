import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { Prisma } from '../db/generated/prisma/client.js';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';
import { assertSharedAdmissionOpen, lockSharedAdmission } from './admission-fence.js';
import {
  sharedResourceLeaseIdentitySchema,
  sharedResourceKeySchema,
  sharedResourceMissionSigningPayload,
  sharedResourceReconciliationSchema,
  sharedResourceReconciliationSigningPayload,
  sharedResourceReserveSchema,
  sharedResourceSettlementRecordSha256,
  sharedResourceTerminalEvidenceSchema,
  sharedResourceTerminalSigningPayload,
  type SharedResourceLeaseIdentity,
  type SharedResourceReconciliation,
  type SharedResourceReserve,
  type SharedResourceTerminalEvidence,
} from '../schemas/shared-resource-lease.js';

const HELD = ['reserved', 'running', 'unknown'] as const;
const MAX_DEADLINE_SECONDS = 24 * 60 * 60;

const resultTrustSchema = z.array(z.object({
  issuer: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  keyId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  publicKeySpkiB64: z.string().min(40).max(4096),
  resourceScopes: z.array(z.string().min(5).max(260)).min(1).max(64),
}).strict()).min(1).max(32);

interface ResultTrust {
  issuer: string;
  keyId: string;
  publicKey: KeyObject;
  resourceScopes: string[];
}

const missionTrustSchema = z.array(z.object({
  issuer: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  keyId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  publicKeySpkiB64: z.string().min(40).max(4096),
  ownerActors: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)).min(1).max(32),
  callerKinds: z.array(z.enum(['direct', 'delegated'])).min(1).max(2),
}).strict()).min(1).max(32);

type LeaseWithResources = Awaited<ReturnType<typeof loadLease>>;

function fail(status: number, code: string, message: string): never {
  throw new HttpError(status, code, message);
}

function seconds(date: Date): number { return Math.floor(date.getTime() / 1000); }

function loadResultTrust(): ResultTrust[] {
  let raw: unknown;
  try { raw = JSON.parse(process.env['SHARED_RESOURCE_RESULT_TRUST_JSON'] ?? ''); }
  catch { fail(503, 'SHARED_RESOURCE_TRUST_UNAVAILABLE', 'Shared resource result trust is unavailable'); }
  const parsed = resultTrustSchema.safeParse(raw);
  if (!parsed.success) fail(503, 'SHARED_RESOURCE_TRUST_UNAVAILABLE', 'Shared resource result trust is unavailable');
  const seen = new Set<string>();
  return parsed.data.map(entry => {
    const identity = `${entry.issuer}\0${entry.keyId}`;
    if (seen.has(identity)) fail(503, 'SHARED_RESOURCE_TRUST_UNAVAILABLE', 'Shared resource result trust contains duplicate identities');
    seen.add(identity);
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey({ key: Buffer.from(entry.publicKeySpkiB64, 'base64'), format: 'der', type: 'spki' });
    } catch { fail(503, 'SHARED_RESOURCE_TRUST_UNAVAILABLE', 'Shared resource result trust contains an invalid key'); }
    if (publicKey.asymmetricKeyType !== 'ed25519')
      fail(503, 'SHARED_RESOURCE_TRUST_UNAVAILABLE', 'Shared resource result trust requires Ed25519 keys');
    const resourceScopes = entry.resourceScopes.map(scope => sharedResourceKeySchema.parse(scope));
    if (new Set(resourceScopes).size !== resourceScopes.length)
      fail(503, 'SHARED_RESOURCE_TRUST_UNAVAILABLE', 'Shared resource result trust contains duplicate scopes');
    return { ...entry, resourceScopes, publicKey };
  });
}

function scopeCovers(scope: string, resourceKey: string): boolean {
  return resourceKey === scope || resourceKey.startsWith(`${scope}:`) || resourceKey.startsWith(`${scope}/`);
}

function verifyMissionAssertion(value: SharedResourceReserve, ownerActor: string): void {
  let raw: unknown;
  try { raw = JSON.parse(process.env['SHARED_RESOURCE_MISSION_TRUST_JSON'] ?? ''); }
  catch { fail(503, 'SHARED_RESOURCE_MISSION_TRUST_UNAVAILABLE', 'Hermes mission authority trust is unavailable'); }
  const parsed = missionTrustSchema.safeParse(raw);
  if (!parsed.success) fail(503, 'SHARED_RESOURCE_MISSION_TRUST_UNAVAILABLE', 'Hermes mission authority trust is unavailable');
  const identities = parsed.data.map(entry => `${entry.issuer}\0${entry.keyId}`);
  if (new Set(identities).size !== identities.length
    || parsed.data.some(entry => new Set(entry.ownerActors).size !== entry.ownerActors.length
      || new Set(entry.callerKinds).size !== entry.callerKinds.length))
    fail(503, 'SHARED_RESOURCE_MISSION_TRUST_UNAVAILABLE', 'Hermes mission authority trust contains duplicate bindings');
  const assertion = value.missionAssertion;
  const trust = parsed.data.find(entry => entry.issuer === assertion.issuer && entry.keyId === assertion.keyId);
  if (!trust || !trust.ownerActors.includes(ownerActor) || !trust.callerKinds.includes(value.caller.kind))
    fail(403, 'SHARED_RESOURCE_MISSION_INVALID', 'Hermes mission authority is not trusted for this actor and caller kind');
  const now = Math.floor(Date.now() / 1000);
  if (assertion.issuedAt > now + 30 || assertion.issuedAt < now - 300
    || assertion.expiresAt <= now || assertion.expiresAt > assertion.issuedAt + 300)
    fail(409, 'SHARED_RESOURCE_MISSION_INVALID', 'Hermes mission authority assertion is stale or too broad');
  const { missionAssertion: _missionAssertion, ...reservation } = value;
  const { signature, ...authority } = assertion;
  let publicKey: KeyObject;
  try { publicKey = createPublicKey({ key: Buffer.from(trust.publicKeySpkiB64, 'base64'), format: 'der', type: 'spki' }); }
  catch { fail(503, 'SHARED_RESOURCE_MISSION_TRUST_UNAVAILABLE', 'Hermes mission authority trust contains an invalid key'); }
  if (publicKey.asymmetricKeyType !== 'ed25519')
    fail(503, 'SHARED_RESOURCE_MISSION_TRUST_UNAVAILABLE', 'Hermes mission authority trust requires Ed25519 keys');
  let valid = false;
  try { valid = verify(null, sharedResourceMissionSigningPayload({ reservation, ownerActor, authority }),
    publicKey, Buffer.from(signature, 'base64')); } catch { valid = false; }
  if (!valid) fail(403, 'SHARED_RESOURCE_MISSION_INVALID', 'Hermes mission authority assertion is invalid');
}

function verifyTerminalEvidence(value: SharedResourceTerminalEvidence): void {
  const trust = loadResultTrust().find(entry => entry.issuer === value.issuer && entry.keyId === value.keyId);
  if (!trust || value.resources.some(resource => !trust.resourceScopes.some(scope => scopeCovers(scope, resource.resourceKey))))
    fail(403, 'SHARED_RESOURCE_EVIDENCE_INVALID', 'Terminal evidence issuer is not trusted for every resource');
  const { signature, ...unsigned } = value;
  let valid = false;
  try { valid = verify(null, sharedResourceTerminalSigningPayload(unsigned), trust.publicKey, Buffer.from(signature, 'base64')); }
  catch { valid = false; }
  if (!valid) fail(403, 'SHARED_RESOURCE_EVIDENCE_INVALID', 'Terminal evidence signature is invalid');
}

function reconciliationSecret(): string {
  const value = process.env['SHARED_RESOURCE_RECONCILIATION_SECRET'] ?? '';
  const conflicting = [
    'API_SECRET', 'JWT_SECRET', 'NODE_MANAGER_SECRET', 'RESULT_SIGNING_SECRET', 'RESULT_SIGNING_PREVIOUS_SECRET',
    'COMMAND_RECONCILIATION_SECRET', 'RESOURCE_PARTICIPANT_RECONCILIATION_SECRET', 'SECURITY_APPROVAL_BRIDGE_TOKEN',
  ];
  if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(value)
    || conflicting.some(name => process.env[name] && process.env[name] === value))
    fail(503, 'SHARED_RESOURCE_RECONCILIATION_UNAVAILABLE', 'Dedicated shared resource reconciliation authority is unavailable');
  return value;
}

function verifyReconciliation(value: SharedResourceReconciliation): void {
  const { signature, ...unsigned } = value;
  const actual = Buffer.from(signature, 'hex');
  const expected = createHmac('sha256', reconciliationSecret())
    .update(sharedResourceReconciliationSigningPayload(unsigned)).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    fail(403, 'SHARED_RESOURCE_EVIDENCE_INVALID', 'Shared resource reconciliation signature is invalid');
}

async function lockOperation(tx: Prisma.TransactionClient, operationId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`shared-resource-operation:${operationId}`}, 0))`;
}

async function lockResources(tx: Prisma.TransactionClient, keys: string[]) {
  for (const key of [...keys].sort())
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`shared-resource:${key}`}, 0))`;
}

async function loadLease(id: string) {
  return getDb().sharedResourceLease.findUnique({ where: { id }, include: { resources: { orderBy: { resourceKey: 'asc' } } } });
}

function leaseIdentity(row: NonNullable<LeaseWithResources>): SharedResourceLeaseIdentity {
  return sharedResourceLeaseIdentitySchema.parse({
    version: 1,
    resources: row.resources.map(resource => ({ resourceKey: resource.resourceKey,
      fenceGeneration: resource.fenceGeneration.toString() })),
    missionRootId: row.missionRootId,
    missionRevision: row.missionRevision,
    taskId: row.taskId,
    operationId: row.operationId,
    requestSha256: row.requestSha256,
    actionClass: row.actionClass,
    deadline: seconds(row.deadline),
    caller: row.callerKind === 'direct'
      ? { kind: 'direct' as const }
      : { kind: 'delegated' as const, delegationId: row.delegationId! },
    ownerActor: row.ownerActor,
  });
}

function suppliedIdentity(value: SharedResourceLeaseIdentity): SharedResourceLeaseIdentity {
  return {
    version: value.version, resources: value.resources, missionRootId: value.missionRootId,
    missionRevision: value.missionRevision, taskId: value.taskId, operationId: value.operationId,
    requestSha256: value.requestSha256, actionClass: value.actionClass, deadline: value.deadline,
    caller: value.caller, ownerActor: value.ownerActor,
  };
}

function exactIdentity(row: NonNullable<LeaseWithResources>, value: SharedResourceLeaseIdentity): boolean {
  return JSON.stringify(leaseIdentity(row)) === JSON.stringify(suppliedIdentity(value));
}

function leaseView(row: NonNullable<LeaseWithResources>) {
  return {
    leaseId: row.id,
    state: row.state,
    ...leaseIdentity(row),
    acquiredAt: seconds(row.acquiredAt),
    startedAt: row.startedAt ? seconds(row.startedAt) : null,
    settledAt: row.settledAt ? seconds(row.settledAt) : null,
    settlement: row.settlement,
    evidenceSha256: row.evidenceSha256,
    settlementRecordSha256: row.settlementRecordSha256,
    terminalEvidence: row.terminalEvidenceJson ? JSON.parse(row.terminalEvidenceJson) : null,
    reconciliationDecisionId: row.reconciliationDecisionId,
    reconciliation: row.reconciliationJson ? JSON.parse(row.reconciliationJson) : null,
  };
}

function exactReserve(row: NonNullable<LeaseWithResources>, value: SharedResourceReserve, actorId: string): boolean {
  return row.ownerActor === actorId
    && row.missionRootId === value.missionRootId && row.missionRevision === value.missionRevision
    && row.taskId === value.taskId && row.operationId === value.operationId
    && row.requestSha256 === value.requestSha256 && row.actionClass === value.actionClass
    && row.missionIssuer === value.missionAssertion.issuer && row.missionKeyId === value.missionAssertion.keyId
    && seconds(row.deadline) === value.deadline && row.callerKind === value.caller.kind
    && row.delegationId === (value.caller.kind === 'delegated' ? value.caller.delegationId : null)
    && JSON.stringify(row.resources.map(resource => resource.resourceKey)) === JSON.stringify(value.resourceKeys);
}

function exactStoredMissionAssertion(row: NonNullable<LeaseWithResources>, value: SharedResourceReserve): boolean {
  const serialized = JSON.stringify(value.missionAssertion);
  return row.missionAssertionJson === serialized
    && row.missionAssertionSha256 === createHash('sha256').update(serialized).digest('hex');
}

function assertLeaseOwner(row: NonNullable<LeaseWithResources>, actorId: string): void {
  if (row.ownerActor !== actorId)
    fail(403, 'SHARED_RESOURCE_OWNER_REQUIRED', 'Only the exact lease owner may perform this lifecycle action');
}

function resourceSetBinding(resources: Array<{ resourceKey: string; fenceGeneration: bigint }>): string {
  return resources.map(resource => `${resource.resourceKey}=${resource.fenceGeneration}`).join('\n');
}

async function assertCurrentFences(tx: Prisma.TransactionClient, row: NonNullable<LeaseWithResources>) {
  const fences = await tx.sharedResourceFence.findMany({ where: { resourceKey: { in: row.resources.map(resource => resource.resourceKey) } } });
  const current = new Map(fences.map(fence => [fence.resourceKey, fence.generation]));
  if (row.resources.some(resource => current.get(resource.resourceKey) !== resource.fenceGeneration))
    fail(409, 'SHARED_RESOURCE_FENCE_STALE', 'A resource fence generation is stale');
}

/** Atomically reserve every key or none. Exact operation replay returns the original durable lease. */
export async function reserveSharedResources(raw: unknown, actorId: string) {
  const value = sharedResourceReserveSchema.parse(raw);
  const db = getDb();
  return db.$transaction(async tx => {
    await lockOperation(tx, value.operationId);
    // Exact replay is durable recovery: assertion freshness and the operation deadline
    // gate only the first acquisition, never retrieval of ownership already recorded.
    const prior = await tx.sharedResourceLease.findUnique({ where: { operationId: value.operationId },
      include: { resources: { orderBy: { resourceKey: 'asc' } } } });
    if (prior) {
      if (!exactReserve(prior, value, actorId))
        fail(409, 'SHARED_RESOURCE_OPERATION_CONFLICT', 'Operation identity already binds different ownership');
      // The exact assertion accepted at acquisition remains valid for durable
      // replay. Any replacement assertion must be freshly verified over the
      // unchanged reservation and actor.
      if (!exactStoredMissionAssertion(prior, value)) verifyMissionAssertion(value, actorId);
      return leaseView(prior);
    }
    await lockSharedAdmission(tx);
    await assertSharedAdmissionOpen(tx);
    verifyMissionAssertion(value, actorId);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (value.deadline <= nowSeconds || value.deadline > nowSeconds + MAX_DEADLINE_SECONDS)
      fail(409, 'SHARED_RESOURCE_DEADLINE_INVALID', 'Shared resource deadline must be future and no more than 24 hours');
    await lockResources(tx, value.resourceKeys);
    const conflict = await tx.sharedResourceLeaseResource.findFirst({ where: {
      resourceKey: { in: value.resourceKeys }, state: { in: [...HELD] },
    }, select: { resourceKey: true, leaseId: true } });
    if (conflict) fail(409, 'SHARED_RESOURCE_BUSY', `Resource ${conflict.resourceKey} retains durable ownership`);

    const resources: Array<{ resourceKey: string; fenceGeneration: bigint }> = [];
    for (const resourceKey of value.resourceKeys) {
      const fence = await tx.sharedResourceFence.upsert({ where: { resourceKey },
        create: { resourceKey, generation: 1n }, update: { generation: { increment: 1n } } });
      resources.push({ resourceKey, fenceGeneration: fence.generation });
    }
    const lease = await tx.sharedResourceLease.create({ data: {
      id: nanoid(), missionRootId: value.missionRootId, missionRevision: value.missionRevision,
      taskId: value.taskId, operationId: value.operationId, requestSha256: value.requestSha256,
      actionClass: value.actionClass, ownerActor: actorId, callerKind: value.caller.kind,
      delegationId: value.caller.kind === 'delegated' ? value.caller.delegationId : null,
      missionIssuer: value.missionAssertion.issuer, missionKeyId: value.missionAssertion.keyId,
      missionAssertionSha256: createHash('sha256').update(JSON.stringify(value.missionAssertion)).digest('hex'),
      missionAssertionJson: JSON.stringify(value.missionAssertion), resourceSetBinding: resourceSetBinding(resources),
      deadline: new Date(value.deadline * 1000), resources: { create: resources },
    }, include: { resources: { orderBy: { resourceKey: 'asc' } } } });
    return leaseView(lease);
  });
}

async function mutateHeldLease(id: string, raw: unknown, actorId: string, action: 'start' | 'unknown') {
  const value = sharedResourceLeaseIdentitySchema.parse(raw);
  const found = await loadLease(id);
  if (!found) fail(404, 'SHARED_RESOURCE_LEASE_NOT_FOUND', 'Shared resource lease not found');
  const db = getDb();
  return db.$transaction(async tx => {
    await lockOperation(tx, found.operationId);
    if (action === 'start') await lockSharedAdmission(tx);
    await lockResources(tx, found.resources.map(resource => resource.resourceKey));
    const row = await tx.sharedResourceLease.findUniqueOrThrow({ where: { id }, include: { resources: { orderBy: { resourceKey: 'asc' } } } });
    assertLeaseOwner(row, actorId);
    if (!exactIdentity(row, value)) fail(409, 'SHARED_RESOURCE_IDENTITY_INVALID', 'Lease identity changed or does not match');
    await assertCurrentFences(tx, row);
    if (action === 'start') {
      await assertSharedAdmissionOpen(tx);
      if (row.state === 'running') return leaseView(row);
      if (row.state !== 'reserved') fail(409, 'SHARED_RESOURCE_STATE_INVALID', 'Only a reserved lease can start');
      if (row.deadline.getTime() <= Date.now())
        fail(409, 'SHARED_RESOURCE_DEADLINE_INVALID', 'Expired ownership is retained and cannot start');
      const startedAt = new Date();
      await tx.sharedResourceLeaseResource.updateMany({ where: { leaseId: id, state: 'reserved' }, data: { state: 'running' } });
      const updated = await tx.sharedResourceLease.update({ where: { id }, data: { state: 'running', startedAt },
        include: { resources: { orderBy: { resourceKey: 'asc' } } } });
      return leaseView(updated);
    }
    if (row.state === 'unknown') return leaseView(row);
    if (row.state !== 'running') fail(409, 'SHARED_RESOURCE_STATE_INVALID', 'Only started work can become unknown');
    await tx.sharedResourceLeaseResource.updateMany({ where: { leaseId: id, state: 'running' }, data: { state: 'unknown' } });
    const updated = await tx.sharedResourceLease.update({ where: { id }, data: { state: 'unknown' },
      include: { resources: { orderBy: { resourceKey: 'asc' } } } });
    return leaseView(updated);
  });
}

export async function startSharedResourceLease(id: string, raw: unknown, actorId: string) { return mutateHeldLease(id, raw, actorId, 'start'); }
export async function retainUnknownSharedResourceLease(id: string, raw: unknown, actorId: string) { return mutateHeldLease(id, raw, actorId, 'unknown'); }

export async function settleSharedResourceLease(id: string, raw: unknown, actorId: string) {
  const value = sharedResourceTerminalEvidenceSchema.parse(raw);
  verifyTerminalEvidence(value);
  const found = await loadLease(id);
  if (!found) fail(404, 'SHARED_RESOURCE_LEASE_NOT_FOUND', 'Shared resource lease not found');
  assertLeaseOwner(found, actorId);
  if (!exactIdentity(found, value)) fail(409, 'SHARED_RESOURCE_EVIDENCE_INVALID', 'Terminal evidence does not bind the exact lease');
  if (value.completedAt < seconds(found.startedAt ?? found.acquiredAt)
    || value.completedAt > Math.floor(Date.now() / 1000) + 30)
    fail(409, 'SHARED_RESOURCE_EVIDENCE_INVALID', 'Terminal evidence completion time is invalid');
  const serialized = JSON.stringify(value);
  const recordSha256 = sharedResourceSettlementRecordSha256(value);
  const db = getDb();
  return db.$transaction(async tx => {
    await lockOperation(tx, found.operationId);
    await lockResources(tx, found.resources.map(resource => resource.resourceKey));
    const row = await tx.sharedResourceLease.findUniqueOrThrow({ where: { id }, include: { resources: { orderBy: { resourceKey: 'asc' } } } });
    if (!exactIdentity(row, value)) fail(409, 'SHARED_RESOURCE_EVIDENCE_INVALID', 'Terminal evidence does not bind the exact lease');
    if (row.state === 'released') {
      if (row.terminalEvidenceJson !== serialized || row.settlementRecordSha256 !== recordSha256)
        fail(409, 'SHARED_RESOURCE_SETTLEMENT_CONFLICT', 'Lease already has different terminal evidence');
      return leaseView(row);
    }
    await assertCurrentFences(tx, row);
    if (row.state !== 'running' && row.state !== 'unknown')
      fail(409, 'SHARED_RESOURCE_STATE_INVALID', 'Only started or unknown work accepts terminal evidence');
    const settledAt = new Date();
    await tx.sharedResourceLeaseResource.updateMany({ where: { leaseId: id, state: { in: ['running', 'unknown'] } }, data: { state: 'released' } });
    const updated = await tx.sharedResourceLease.update({ where: { id }, data: { state: 'released', settledAt,
      settlement: `signed-terminal:${value.outcome}`, evidenceSha256: value.evidenceSha256,
      settlementRecordSha256: recordSha256, terminalEvidenceJson: serialized },
      include: { resources: { orderBy: { resourceKey: 'asc' } } } });
    return leaseView(updated);
  });
}

export async function reconcileSharedResourceLease(id: string, raw: unknown) {
  const value = sharedResourceReconciliationSchema.parse(raw);
  verifyReconciliation(value);
  const found = await loadLease(id);
  if (!found) fail(404, 'SHARED_RESOURCE_LEASE_NOT_FOUND', 'Shared resource lease not found');
  if (!exactIdentity(found, value)) fail(409, 'SHARED_RESOURCE_EVIDENCE_INVALID', 'Reconciliation does not bind the exact lease');
  const serialized = JSON.stringify(value);
  const recordSha256 = sharedResourceSettlementRecordSha256(value);
  const db = getDb();
  return db.$transaction(async tx => {
    await lockOperation(tx, found.operationId);
    await lockResources(tx, found.resources.map(resource => resource.resourceKey));
    const row = await tx.sharedResourceLease.findUniqueOrThrow({ where: { id }, include: { resources: { orderBy: { resourceKey: 'asc' } } } });
    if (!exactIdentity(row, value)) fail(409, 'SHARED_RESOURCE_EVIDENCE_INVALID', 'Reconciliation does not bind the exact lease');
    if (row.state === 'released') {
      if (row.reconciliationDecisionId !== value.decisionId || row.reconciliationJson !== serialized
        || row.settlementRecordSha256 !== recordSha256)
        fail(409, 'SHARED_RESOURCE_SETTLEMENT_CONFLICT', 'Lease already has another terminal settlement');
      return leaseView(row);
    }
    const now = Math.floor(Date.now() / 1000);
    if (value.expiresAt <= now || value.expiresAt > now + 300)
      fail(409, 'SHARED_RESOURCE_EVIDENCE_INVALID', 'Reconciliation validity is stale or too broad');
    await assertCurrentFences(tx, row);
    const reused = await tx.sharedResourceLease.findFirst({ where: { reconciliationDecisionId: value.decisionId }, select: { id: true } });
    if (reused && reused.id !== id)
      fail(409, 'SHARED_RESOURCE_SETTLEMENT_CONFLICT', 'Reconciliation decision is already bound to another lease');
    await tx.sharedResourceLeaseResource.updateMany({ where: { leaseId: id, state: { in: [...HELD] } }, data: { state: 'released' } });
    const updated = await tx.sharedResourceLease.update({ where: { id }, data: { state: 'released', settledAt: new Date(),
      settlement: `signed-reconciliation:${value.disposition}`, evidenceSha256: value.evidenceSha256,
      settlementRecordSha256: recordSha256, reconciliationDecisionId: value.decisionId,
      reconciliationJson: serialized }, include: { resources: { orderBy: { resourceKey: 'asc' } } } });
    return leaseView(updated);
  });
}

export async function inspectSharedResourceLease(id: string, actorId: string, allowAdministrator = false) {
  const row = await loadLease(id);
  if (!row) fail(404, 'SHARED_RESOURCE_LEASE_NOT_FOUND', 'Shared resource lease not found');
  if (!allowAdministrator) assertLeaseOwner(row, actorId);
  return leaseView(row);
}

export async function recoverSharedResourceLease(operationId: string, actorId: string, allowAdministrator = false) {
  const row = await getDb().sharedResourceLease.findUnique({ where: { operationId },
    include: { resources: { orderBy: { resourceKey: 'asc' } } } });
  if (!row) fail(404, 'SHARED_RESOURCE_LEASE_NOT_FOUND', 'Shared resource lease not found');
  if (!allowAdministrator) assertLeaseOwner(row, actorId);
  return leaseView(row);
}

export function sharedResourceResultTrustDigest(): string {
  return createHash('sha256').update(process.env['SHARED_RESOURCE_RESULT_TRUST_JSON'] ?? '').digest('hex');
}
