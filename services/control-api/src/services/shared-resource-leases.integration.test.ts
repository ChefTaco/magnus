/** Focused disposable PostgreSQL coverage; no fleet/provider calls or live credentials. */
import { createHash, createHmac, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const prefix = `shared-${randomUUID()}`;
const actor = 'service:specialist-fixture';
const reconciliationKey = 'shared-resource-reviewed-reconciliation-fixture-key-32';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');

describe.skipIf(!process.env['TEST_DATABASE_URL'])('global shared-resource ownership (PostgreSQL)', () => {
  let db: ReturnType<typeof import('../db/index.js')['getDb']>;
  let leases: typeof import('./shared-resource-leases.js');
  let schemas: typeof import('../schemas/shared-resource-lease.js');

  const operation = (resourceKeys = [`repo:${prefix}/${randomUUID()}`], patch: Record<string, unknown> = {}) => {
    const unsigned = {
    version: 1 as const,
    resourceKeys,
    missionRootId: `mission:${prefix}`,
    missionRevision: 1,
    taskId: `task:${prefix}`,
    operationId: `operation:${randomUUID()}`,
    requestSha256: 'a'.repeat(64),
    actionClass: 'create_artifact' as const,
    deadline: Math.floor(Date.now() / 1000) + 60,
    caller: { kind: 'direct' as const },
    ...patch,
    };
    const now = Math.floor(Date.now() / 1000);
    const authority = { issuer: 'coordinator-fixture', keyId: 'mission-key-1', issuedAt: now, expiresAt: now + 60 };
    return { ...unsigned, missionAssertion: { ...authority, signature: sign(null,
      schemas.sharedResourceMissionSigningPayload({ reservation: unsigned, ownerActor: actor, authority }), privateKey).toString('base64') } };
  };
  const reassert = (request: ReturnType<typeof operation>, patch: Record<string, unknown> = {}) => {
    const { missionAssertion: prior, ...reservation } = request;
    const { signature: _signature, ...storedAuthority } = prior;
    const authority = { ...storedAuthority, ...patch };
    return { ...request, missionAssertion: { ...authority, signature: sign(null,
      schemas.sharedResourceMissionSigningPayload({ reservation, ownerActor: actor, authority }), privateKey).toString('base64') } };
  };

  const identity = (view: unknown) => {
    const value = view as Record<string, unknown>;
    return schemas.sharedResourceLeaseIdentitySchema.parse({
      version: value.version, resources: value.resources, missionRootId: value.missionRootId,
      missionRevision: value.missionRevision, taskId: value.taskId, operationId: value.operationId,
      requestSha256: value.requestSha256, actionClass: value.actionClass, deadline: value.deadline,
      caller: value.caller, ownerActor: value.ownerActor,
    });
  };
  const terminal = (view: unknown, patch: Record<string, unknown> = {}) => {
    const unsigned = schemas.sharedResourceTerminalEvidenceSchema.omit({ signature: true }).parse({
      ...identity(view), outcome: 'succeeded', evidenceSha256: 'e'.repeat(64),
      completedAt: Math.floor(Date.now() / 1000), issuer: 'specialist-fixture', keyId: 'key-1', ...patch,
    });
    return { ...unsigned, signature: sign(null, schemas.sharedResourceTerminalSigningPayload(unsigned), privateKey).toString('base64') };
  };
  const reconciliation = (view: unknown, patch: Record<string, unknown> = {}) => {
    const unsigned = schemas.sharedResourceReconciliationSchema.omit({ signature: true }).parse({
      ...identity(view), disposition: 'no_effect_verified', evidenceSha256: 'f'.repeat(64),
      approvalRef: 'review:fixture', decisionId: `decision:${randomUUID()}`,
      expiresAt: Math.floor(Date.now() / 1000) + 60, ...patch,
    });
    return { ...unsigned, signature: createHmac('sha256', reconciliationKey)
      .update(schemas.sharedResourceReconciliationSigningPayload(unsigned)).digest('hex') };
  };

  beforeAll(async () => {
    const url = process.env['TEST_DATABASE_URL']!;
    if (!new URL(url).pathname.startsWith('/magnus_ideas')) throw new Error('Disposable magnus_ideas database required');
    vi.stubEnv('DATABASE_URL', url);
    vi.stubEnv('SHARED_RESOURCE_RECONCILIATION_SECRET', reconciliationKey);
    vi.stubEnv('SHARED_RESOURCE_MISSION_TRUST_JSON', JSON.stringify([{
      issuer: 'coordinator-fixture', keyId: 'mission-key-1',
      publicKeySpkiB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      ownerActors: [actor], callerKinds: ['direct', 'delegated'],
    }]));
    vi.stubEnv('SHARED_RESOURCE_RESULT_TRUST_JSON', JSON.stringify([{
      issuer: 'specialist-fixture', keyId: 'key-1',
      publicKeySpkiB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      resourceScopes: [`gpu:${prefix}`, 'provider:workflow-maps', `repo:${prefix}`],
    }]));
    db = (await import('../db/index.js')).getDb();
    leases = await import('./shared-resource-leases.js');
    schemas = await import('../schemas/shared-resource-lease.js');
  });

  afterAll(async () => {
    if (db) await (await import('../db/index.js')).disconnectDb();
    vi.unstubAllEnvs();
  });

  it('accepts only canonical keys and canonical-sorted unique atomic sets', () => {
    expect(schemas.sharedResourceReserveSchema.parse(operation([
      `gpu:${prefix}`, `provider:new:workflow-maps`, `provider:workflow-maps:${prefix}`, `repo:${prefix}`,
    ])).resourceKeys).toHaveLength(4);
    for (const resourceKeys of [
      [`provider:Workflow:${prefix}`], [`provider:workflow:${prefix}`, `gpu:${prefix}`],
      [`gpu:${prefix}`, `gpu:${prefix}`], ['provider:'], ['repo:bad//path'],
    ]) expect(schemas.sharedResourceReserveSchema.safeParse(operation(resourceKeys)).success).toBe(false);
  });

  it('pauses shared reserve and start while a admission fence is closed without erasing prior ownership', async () => {
    const nodeId = `release-shared-${randomUUID()}`;
    const nodeFqdn = `${nodeId}.invalid`;
    const releaseId = randomUUID();
    const fence = await import('./admission-fence.js');
    await db.node.create({ data: { id: nodeId, name: nodeId, hostname: nodeFqdn, ipAddress: '127.0.0.1',
      os: 'fixture', arch: 'fixture', token: randomUUID(), status: 'ONLINE', lastHeartbeatAt: new Date() } });
    const priorRequest = operation();
    const prior = await leases.reserveSharedResources(priorRequest, actor);
    try {
      await fence.closeNodeAdmission(nodeId, nodeFqdn, releaseId);
      await expect(leases.reserveSharedResources(operation(), actor))
        .rejects.toMatchObject({ code: 'ADMISSION_FENCED' });
      await expect(leases.startSharedResourceLease(prior.leaseId, identity(prior), actor))
        .rejects.toMatchObject({ code: 'ADMISSION_FENCED' });
      expect(await leases.reserveSharedResources(priorRequest, actor)).toEqual(prior);
      expect((await leases.inspectSharedResourceLease(prior.leaseId, actor)).state).toBe('reserved');
      await expect(fence.releaseNodeAdmission(nodeId, nodeFqdn, releaseId))
        .rejects.toMatchObject({ code: 'ADMISSION_WORK_UNSETTLED' });
    } finally {
      await db.admissionFence.deleteMany({ where: { nodeId } });
      await db.node.delete({ where: { id: nodeId } });
    }
  });

  it('atomically serializes overlapping multi-resource reservations without partial claims', async () => {
    const shared = `gpu:${prefix}`;
    const first = operation([shared, `provider:workflow-maps:${prefix}-one`].sort());
    const second = operation([shared, `repo:${prefix}/two`].sort());
    const results = await Promise.allSettled([
      leases.reserveSharedResources(first, actor), leases.reserveSharedResources(second, actor),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await db.sharedResourceLease.count({ where: { operationId: { in: [first.operationId, second.operationId] } } })).toBe(1);
    expect(await db.sharedResourceLeaseResource.count({ where: { resourceKey: { in: [...new Set([...first.resourceKeys, ...second.resourceKeys])] } } })).toBe(2);
  });

  it('returns exact operation replay and rejects identity, caller or resource drift', async () => {
    const request = operation();
    const first = await leases.reserveSharedResources(request, actor);
    expect(await leases.reserveSharedResources(request, actor)).toEqual(first);
    await expect(leases.reserveSharedResources(operation(request.resourceKeys, {
      operationId: request.operationId, requestSha256: 'b'.repeat(64),
    }), actor))
      .rejects.toMatchObject({ code: 'SHARED_RESOURCE_OPERATION_CONFLICT' });
    await expect(leases.reserveSharedResources(request, 'service:other'))
      .rejects.toMatchObject({ code: 'SHARED_RESOURCE_OPERATION_CONFLICT' });
    await expect(leases.reserveSharedResources(operation([`gpu:${prefix}`], {
      operationId: request.operationId,
    }), actor))
      .rejects.toMatchObject({ code: 'SHARED_RESOURCE_OPERATION_CONFLICT' });
  });

  it('accepts the exact stored assertion after expiry but fully verifies every changed assertion', async () => {
    const request = operation();
    const first = await leases.reserveSharedResources(request, actor);
    const forged = { ...request, missionAssertion: { ...request.missionAssertion,
      expiresAt: request.missionAssertion.expiresAt - 1 } };
    await expect(leases.reserveSharedResources(forged, actor))
      .rejects.toMatchObject({ code: 'SHARED_RESOURCE_MISSION_INVALID' });
    const renewed = reassert(request, { expiresAt: request.missionAssertion.expiresAt - 1 });
    expect(await leases.reserveSharedResources(renewed, actor)).toEqual(first);
    const clock = vi.spyOn(Date, 'now').mockReturnValue((request.missionAssertion.expiresAt + 1) * 1000);
    try {
      expect(await leases.reserveSharedResources(request, actor)).toEqual(first);
      await expect(leases.reserveSharedResources(renewed, actor))
        .rejects.toMatchObject({ code: 'SHARED_RESOURCE_MISSION_INVALID' });
    }
    finally { clock.mockRestore(); }
  });

  it('fails closed when the Hermes mission-source assertion is missing or forged', async () => {
    const request = operation();
    const { missionAssertion: _missionAssertion, ...unsigned } = request;
    expect(schemas.sharedResourceReserveSchema.safeParse(unsigned).success).toBe(false);
    await expect(leases.reserveSharedResources({ ...request,
      missionAssertion: { ...request.missionAssertion, signature: Buffer.alloc(64).toString('base64') } }, actor))
      .rejects.toMatchObject({ code: 'SHARED_RESOURCE_MISSION_INVALID' });
  });

  it('retains expired ownership and refuses to start or admit a successor', async () => {
    const now = Math.floor(Date.now() / 1000);
    const key = `repo:${prefix}/expired`;
    const request = operation([key], { deadline: now + 1 });
    const lease = await leases.reserveSharedResources(request, actor);
    const clock = vi.spyOn(Date, 'now').mockReturnValue((now + 2) * 1000);
    await expect(leases.startSharedResourceLease(lease.leaseId, identity(lease), actor))
      .rejects.toMatchObject({ code: 'SHARED_RESOURCE_DEADLINE_INVALID' });
    await expect(leases.reserveSharedResources(operation([key]), actor))
      .rejects.toMatchObject({ code: 'SHARED_RESOURCE_BUSY' });
    expect((await leases.inspectSharedResourceLease(lease.leaseId, actor)).state).toBe('reserved');
    clock.mockRestore();
  });

  it('returns exact running start replay and operation recovery after the deadline', async () => {
    const now = Math.floor(Date.now() / 1000);
    const request = operation([`repo:${prefix}/late-start`], { deadline: now + 1 });
    const reserved = await leases.reserveSharedResources(request, actor);
    const running = await leases.startSharedResourceLease(reserved.leaseId, identity(reserved), actor);
    const clock = vi.spyOn(Date, 'now').mockReturnValue((now + 2) * 1000);
    try {
      expect(await leases.startSharedResourceLease(running.leaseId, identity(running), actor)).toEqual(running);
      expect(await leases.recoverSharedResourceLease(request.operationId, actor)).toEqual(running);
    } finally { clock.mockRestore(); }
  });

  it('returns exact reserve replay after assertion and operation deadlines without admitting new work', async () => {
    const now = Math.floor(Date.now() / 1000);
    const request = operation([`repo:${prefix}/late-reserve-replay`], { deadline: now + 1 });
    const first = await leases.reserveSharedResources(request, actor);
    const neverAdmitted = operation([`repo:${prefix}/late-new-reserve`], { deadline: now + 1 });
    const clock = vi.spyOn(Date, 'now').mockReturnValue((now + 2) * 1000);
    try {
      await expect(leases.reserveSharedResources(neverAdmitted, actor))
        .rejects.toMatchObject({ code: 'SHARED_RESOURCE_DEADLINE_INVALID' });
      expect(await db.sharedResourceLease.findUnique({ where: { operationId: neverAdmitted.operationId } })).toBeNull();
      clock.mockReturnValue((now + 301) * 1000);
      expect(await leases.reserveSharedResources(request, actor)).toEqual(first);
      expect(await leases.recoverSharedResourceLease(request.operationId, actor)).toEqual(first);
      await expect(leases.reserveSharedResources(operation(request.resourceKeys, {
        operationId: request.operationId, requestSha256: 'b'.repeat(64),
      }), actor)).rejects.toMatchObject({ code: 'SHARED_RESOURCE_OPERATION_CONFLICT' });
    } finally { clock.mockRestore(); }
  });

  it('rejects a stale generation at authority start without releasing ownership', async () => {
    const key = `repo:${prefix}/stale`;
    const lease = await leases.reserveSharedResources(operation([key]), actor);
    await db.sharedResourceFence.update({ where: { resourceKey: key }, data: { generation: { increment: 1n } } });
    await expect(leases.startSharedResourceLease(lease.leaseId, identity(lease), actor))
      .rejects.toMatchObject({ code: 'SHARED_RESOURCE_FENCE_STALE' });
    expect((await leases.inspectSharedResourceLease(lease.leaseId, actor)).state).toBe('reserved');
  });

  it('allows only a valid reserved lease birth without preloaded execution or settlement evidence', async () => {
    const source = await leases.reserveSharedResources(operation(), actor);
    const insertClone = (state: 'reserved' | 'running' | 'unknown' | 'released', fakeSettlement = false) =>
      db.$executeRawUnsafe(`
        INSERT INTO "shared_resource_leases" (
          "id","missionRootId","missionRevision","taskId","operationId","requestSha256","actionClass",
          "ownerActor","callerKind","delegationId","missionIssuer","missionKeyId","missionAssertionSha256",
          "missionAssertionJson","resourceSetBinding","state","deadline","acquiredAt","startedAt","settledAt",
          "settlement","evidenceSha256","settlementRecordSha256","terminalEvidenceJson",
          "reconciliationDecisionId","reconciliationJson"
        ) SELECT $1,"missionRootId","missionRevision","taskId",$2,"requestSha256","actionClass",
          "ownerActor","callerKind","delegationId","missionIssuer","missionKeyId","missionAssertionSha256",
          "missionAssertionJson","resourceSetBinding",$4,"deadline","acquiredAt",
          CASE WHEN $4 IN ('running','unknown','released') THEN "acquiredAt" ELSE NULL END,
          CASE WHEN $4 = 'released' OR $5 THEN "acquiredAt" ELSE NULL END,
          CASE WHEN $4 = 'released' OR $5 THEN 'signed-terminal:succeeded' ELSE NULL END,
          CASE WHEN $4 = 'released' OR $5 THEN repeat('e',64) ELSE NULL END,
          CASE WHEN $4 = 'released' OR $5 THEN repeat('d',64) ELSE NULL END,
          CASE WHEN $4 = 'released' OR $5 THEN '{}' ELSE NULL END,
          NULL,NULL
        FROM "shared_resource_leases" WHERE "id"=$3`,
      `lease-clone-${randomUUID()}`, `operation:${randomUUID()}`, source.leaseId, state, fakeSettlement);
    for (const state of ['running', 'unknown', 'released'] as const) {
      await expect(insertClone(state)).rejects.toThrow(/must be born reserved/u);
    }
    await expect(insertClone('reserved', true)).rejects.toThrow(/must be born reserved/u);
    await expect(db.$executeRawUnsafe(`
      INSERT INTO "shared_resource_leases" (
        "id","missionRootId","missionRevision","taskId","operationId","requestSha256","actionClass",
        "ownerActor","callerKind","delegationId","missionIssuer","missionKeyId","missionAssertionSha256",
        "missionAssertionJson","resourceSetBinding","state","deadline","acquiredAt"
      ) SELECT $1,"missionRootId","missionRevision","taskId",$2,"requestSha256",'invalid-action',
        "ownerActor","callerKind","delegationId","missionIssuer","missionKeyId","missionAssertionSha256",
        "missionAssertionJson","resourceSetBinding",'reserved',"deadline","acquiredAt"
      FROM "shared_resource_leases" WHERE "id"=$3`,
    `lease-clone-${randomUUID()}`, `operation:${randomUUID()}`, source.leaseId))
      .rejects.toThrow(/initial identity is invalid/u);
    await expect(db.$executeRawUnsafe(`
      INSERT INTO "shared_resource_leases" (
        "id","missionRootId","missionRevision","taskId","operationId","requestSha256","actionClass",
        "ownerActor","callerKind","delegationId","missionIssuer","missionKeyId","missionAssertionSha256",
        "missionAssertionJson","resourceSetBinding","state","deadline","acquiredAt"
      ) SELECT $1,"missionRootId","missionRevision","taskId",$2,"requestSha256","actionClass",
        "ownerActor","callerKind","delegationId","missionIssuer","missionKeyId",repeat('0',64),
        "missionAssertionJson","resourceSetBinding",'reserved',"deadline","acquiredAt"
      FROM "shared_resource_leases" WHERE "id"=$3`,
    `lease-clone-${randomUUID()}`, `operation:${randomUUID()}`, source.leaseId))
      .rejects.toThrow(/initial mission assertion is invalid/u);
  });

  it('requires exact JSON scalar types in the immutable mission assertion', async () => {
    const request = operation();
    const source = await leases.reserveSharedResources(request, actor);
    const insertWithAssertion = (assertion: Record<string, unknown>) => {
      const encoded = JSON.stringify(assertion);
      return db.$executeRawUnsafe(`
        INSERT INTO "shared_resource_leases" (
          "id","missionRootId","missionRevision","taskId","operationId","requestSha256","actionClass",
          "ownerActor","callerKind","delegationId","missionIssuer","missionKeyId","missionAssertionSha256",
          "missionAssertionJson","resourceSetBinding","state","deadline","acquiredAt"
        ) SELECT $1,"missionRootId","missionRevision","taskId",$2,"requestSha256","actionClass",
          "ownerActor","callerKind","delegationId","missionIssuer","missionKeyId",$3,$4,
          "resourceSetBinding",'reserved',"deadline","acquiredAt"
        FROM "shared_resource_leases" WHERE "id"=$5`,
      `lease-clone-${randomUUID()}`, `operation:${randomUUID()}`,
      createHash('sha256').update(encoded).digest('hex'), encoded, source.leaseId);
    };
    const authority = request.missionAssertion;
    for (const assertion of [
      { ...authority, issuedAt: String(authority.issuedAt), expiresAt: String(authority.expiresAt) },
      { ...authority, issuer: 7 },
      { ...authority, keyId: true },
      { ...authority, signature: 123 },
    ]) {
      await expect(insertWithAssertion(assertion)).rejects.toThrow(/initial mission assertion is invalid/u);
    }
  });

  it('allows claims to be born only reserved at the exact authoritative fence generation', async () => {
    const lease = await leases.reserveSharedResources(operation(), actor);
    const key = `repo:${prefix}/claim-birth-${randomUUID()}`;
    await db.sharedResourceFence.create({ data: { resourceKey: key, generation: 1n } });
    await db.sharedResourceFence.update({ where: { resourceKey: key }, data: { generation: { increment: 1n } } });
    for (const generation of [1n, 3n]) {
      await expect(db.$executeRawUnsafe(
        'INSERT INTO "shared_resource_lease_resources" ("leaseId","resourceKey","fenceGeneration","state") VALUES ($1,$2,$3,\'reserved\')',
        lease.leaseId, key, generation,
      )).rejects.toThrow(/current authoritative fence generation/u);
    }
    await expect(db.$executeRawUnsafe(
      'INSERT INTO "shared_resource_lease_resources" ("leaseId","resourceKey","fenceGeneration","state") VALUES ($1,$2,$3,\'running\')',
      lease.leaseId, key, 2n,
    )).rejects.toThrow(/must be born reserved/u);
  });

  it('prevents fence deletion/reset and claim deletion or later claim insertion in PostgreSQL', async () => {
    const key = `repo:${prefix}/immutable-${randomUUID()}`;
    const lease = await leases.reserveSharedResources(operation([key]), actor);
    await expect(db.sharedResourceFence.delete({ where: { resourceKey: key } })).rejects.toThrow(/cannot be deleted or reset/);
    await expect(db.sharedResourceFence.update({ where: { resourceKey: key }, data: { generation: 0n } }))
      .rejects.toThrow(/must increase/);
    await expect(db.$executeRawUnsafe('TRUNCATE TABLE "shared_resource_fences"'))
      .rejects.toThrow(/cannot be deleted or reset/);
    await expect(db.sharedResourceLeaseResource.delete({ where: {
      leaseId_resourceKey: { leaseId: lease.leaseId, resourceKey: key },
    } })).rejects.toThrow(/cannot be deleted or rewritten/);
    await expect(db.$executeRawUnsafe('TRUNCATE TABLE "shared_resource_lease_resources"'))
      .rejects.toThrow(/cannot be deleted or rewritten/);
    await expect(db.$executeRawUnsafe(
      'INSERT INTO "shared_resource_fences" ("resourceKey","generation","updatedAt") VALUES ($1,0,NOW())',
      `repo:${prefix}/zero-${randomUUID()}`,
    )).rejects.toThrow(/begin at generation one|shared_resource_fences_generation_check|check constraint/u);
    await expect(db.$executeRawUnsafe(
      'INSERT INTO "shared_resource_fences" ("resourceKey","generation","updatedAt") VALUES ($1,2,NOW())',
      `repo:${prefix}/future-${randomUUID()}`,
    )).rejects.toThrow(/begin at generation one/u);
    await expect(db.$transaction(async tx => {
      await tx.sharedResourceLeaseResource.create({ data: { leaseId: lease.leaseId,
        resourceKey: `repo:${prefix}/injected-${randomUUID()}`, fenceGeneration: 999999n } });
    })).rejects.toThrow(/current authoritative fence generation/u);
  });

  it('requires a durable immutable start time for running and unknown ownership', async () => {
    const lease = await leases.reserveSharedResources(operation(), actor);
    await expect(db.$transaction(async tx => {
      await tx.sharedResourceLeaseResource.updateMany({ where: { leaseId: lease.leaseId }, data: { state: 'running' } });
      await tx.sharedResourceLease.update({ where: { id: lease.leaseId }, data: { state: 'running' } });
    })).rejects.toThrow(/shared_resource_leases_started_check|check constraint/u);
    const running = await leases.startSharedResourceLease(lease.leaseId, identity(lease), actor);
    await expect(db.sharedResourceLease.update({ where: { id: lease.leaseId },
      data: { startedAt: new Date((running.startedAt + 1) * 1000) } }))
      .rejects.toThrow(/start time is immutable/u);
  });

  it('rejects raw-SQL release without an exact authenticated evidence envelope', async () => {
    const lease = await leases.reserveSharedResources(operation(), actor);
    await leases.startSharedResourceLease(lease.leaseId, identity(lease), actor);
    await expect(db.$transaction(async tx => {
      await tx.sharedResourceLeaseResource.updateMany({ where: { leaseId: lease.leaseId }, data: { state: 'released' } });
      await tx.sharedResourceLease.update({ where: { id: lease.leaseId }, data: { state: 'released', settledAt: new Date(),
        settlement: 'signed-terminal:succeeded', evidenceSha256: 'e'.repeat(64),
        settlementRecordSha256: 'd'.repeat(64) } });
    })).rejects.toThrow(/authenticated terminal evidence/);
    expect((await leases.inspectSharedResourceLease(lease.leaseId, actor)).state).toBe('running');
  });

  it('binds lifecycle and operation recovery to the exact owner', async () => {
    const request = operation();
    const lease = await leases.reserveSharedResources(request, actor);
    expect(await leases.recoverSharedResourceLease(request.operationId, actor)).toEqual(lease);
    await expect(leases.inspectSharedResourceLease(lease.leaseId, 'service:other'))
      .rejects.toMatchObject({ code: 'SHARED_RESOURCE_OWNER_REQUIRED' });
    await expect(leases.recoverSharedResourceLease(request.operationId, 'service:other'))
      .rejects.toMatchObject({ code: 'SHARED_RESOURCE_OWNER_REQUIRED' });
    await expect(leases.startSharedResourceLease(lease.leaseId, identity(lease), 'service:other'))
      .rejects.toMatchObject({ code: 'SHARED_RESOURCE_OWNER_REQUIRED' });
    const running = await leases.startSharedResourceLease(lease.leaseId, identity(lease), actor);
    await expect(leases.retainUnknownSharedResourceLease(lease.leaseId, identity(running), 'service:other'))
      .rejects.toMatchObject({ code: 'SHARED_RESOURCE_OWNER_REQUIRED' });
    await expect(leases.settleSharedResourceLease(lease.leaseId, terminal(running), 'service:other'))
      .rejects.toMatchObject({ code: 'SHARED_RESOURCE_OWNER_REQUIRED' });
  });

  it('releases only exact trusted terminal evidence and rejects its stale replay after successor fencing', async () => {
    const request = operation();
    const first = await leases.reserveSharedResources(request, actor);
    const running = await leases.startSharedResourceLease(first.leaseId, identity(first), actor);
    const unknown = await leases.retainUnknownSharedResourceLease(first.leaseId, identity(running), actor);
    const good = terminal(unknown);
    await expect(leases.settleSharedResourceLease(first.leaseId, { ...good, evidenceSha256: '0'.repeat(64) }, actor))
      .rejects.toMatchObject({ code: 'SHARED_RESOURCE_EVIDENCE_INVALID' });
    expect(await leases.settleSharedResourceLease(first.leaseId, good, actor)).toMatchObject({ state: 'released', settlement: 'signed-terminal:succeeded' });
    expect(await leases.settleSharedResourceLease(first.leaseId, good, actor)).toMatchObject({ state: 'released' });
    const successor = await leases.reserveSharedResources(operation(request.resourceKeys), actor);
    expect(successor.resources.every((resource, index) => BigInt(resource.fenceGeneration) > BigInt(first.resources[index]!.fenceGeneration))).toBe(true);
    expect(await leases.settleSharedResourceLease(first.leaseId, good, actor))
      .toMatchObject({ state: 'released', settlementRecordSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        terminalEvidence: good, reconciliationDecisionId: null, reconciliation: null });
    expect(await leases.recoverSharedResourceLease(request.operationId, actor))
      .toMatchObject({ terminalEvidence: good, settlementRecordSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  });

  it('accepts provider-signed no_effect as terminal evidence without confusing it with reviewed reconciliation', async () => {
    const request = operation([`provider:workflow-maps:${prefix}-no-effect`]);
    const reserved = await leases.reserveSharedResources(request, actor);
    const running = await leases.startSharedResourceLease(reserved.leaseId, identity(reserved), actor);
    const evidence = terminal(running, { outcome: 'no_effect', evidenceSha256: 'a'.repeat(64) });
    const released = await leases.settleSharedResourceLease(running.leaseId, evidence, actor);
    expect(released).toMatchObject({ state: 'released', settlement: 'signed-terminal:no_effect',
      evidenceSha256: 'a'.repeat(64) });
    expect(released.settlement).not.toBe('signed-reconciliation:no_effect_verified');
    const successor = await leases.reserveSharedResources(operation(request.resourceKeys), actor);
    expect(BigInt(successor.resources[0]!.fenceGeneration)).toBeGreaterThan(
      BigInt(running.resources[0]!.fenceGeneration));
  });

  it('uses a separate reviewed assertion to release reserved or unknown work and rejects decision replay', async () => {
    const first = await leases.reserveSharedResources(operation([`repo:${prefix}/reconcile`]), actor);
    const reviewed = reconciliation(first);
    await expect(leases.reconcileSharedResourceLease(first.leaseId, { ...reviewed, signature: '0'.repeat(64) }))
      .rejects.toMatchObject({ code: 'SHARED_RESOURCE_EVIDENCE_INVALID' });
    expect(await leases.reconcileSharedResourceLease(first.leaseId, reviewed))
      .toMatchObject({ state: 'released', settlement: 'signed-reconciliation:no_effect_verified' });
    const clock = vi.spyOn(Date, 'now').mockReturnValue((reviewed.expiresAt + 1) * 1000);
    try {
      await leases.reserveSharedResources(operation(first.resources.map(resource => resource.resourceKey)), actor);
      expect(await leases.reconcileSharedResourceLease(first.leaseId, reviewed)).toMatchObject({ state: 'released',
        reconciliationDecisionId: reviewed.decisionId, reconciliation: reviewed,
        settlementRecordSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      expect(await leases.recoverSharedResourceLease(first.operationId, actor)).toMatchObject({
        reconciliationDecisionId: reviewed.decisionId, reconciliation: reviewed });
    } finally { clock.mockRestore(); }
    const second = await leases.reserveSharedResources(operation([`repo:${prefix}/reconcile-second`]), actor);
    const reused = reconciliation(second, { decisionId: reviewed.decisionId });
    await expect(leases.reconcileSharedResourceLease(second.leaseId, reused))
      .rejects.toMatchObject({ code: 'SHARED_RESOURCE_SETTLEMENT_CONFLICT' });
  });
});
