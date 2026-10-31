import { Hono } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { commandRequestDigest } from '../security/command-request.js';
import { commandResultSigningPayload } from '../security/command-result-signature.js';
import { managedCronSchema as apiSchema } from '../schemas/managed-cron.js';
import { cronEnrollmentStageReceiptPayload, schedulerSourceSettlementReceiptPayload,
  schedulerSourceSettlementSigningPayload } from '../schemas/managed-cron.js';
import { makeCronJob, makeOccurrence } from '../../../../packages/agent/src/executors/managed-scheduler.js';
import { NodeApiClient } from '../sdk/node-api-client.js';
const secret = 'managed-cron-result-fixture-at-least-32-characters';
vi.mock('../utils/env.js', async original => ({ ...await original<object>(), RESULT_SIGNING_SECRET: 'managed-cron-result-fixture-at-least-32-characters', RESULT_SIGNING_PREVIOUS_SECRET: '', NODE_MANAGER_SECRET: 'managed-cron-node-fixture-at-least-32-characters', getNodeManagerSecret: () => 'managed-cron-node-fixture-at-least-32-characters' }));
vi.mock('../../../../packages/agent/src/env.js', () => ({ HOST_FQDN: 'managed-cron-fixture.invalid', NODE_MANAGER_SECRET: 'managed-cron-node-fixture-at-least-32-characters', RESULT_SIGNING_SECRET: 'managed-cron-result-fixture-at-least-32-characters', CONTROL_API_URL: 'https://fixture.invalid', MAGNUS_EXECUTION_SUPERVISOR_ENABLED: true }));
const prefix = 'cron-' + randomUUID();
describe.skipIf(!process.env['TEST_DATABASE_URL'])('managed scheduler PostgreSQL authority', () => {
  let credentialDirectory: string;
  let db: ReturnType<typeof import('../db/index.js')['getDb']>;
  let service: typeof import('./managed-cron.js');
  let lease: typeof import('./command-resource-leases.js');
  const ids = [prefix + '-1', prefix + '-2'];
  let evidenceSequence = 0;
  const evidence = (label: string) => ({ commandId: `native-${label}-${++evidenceSequence}`,
    commandSha256: (++evidenceSequence).toString(16).padStart(64, '0'),
    receiptSha256: (++evidenceSequence).toString(16).padStart(64, '0'), acknowledgedAt: new Date() });
  const host = (index: number) => index === 0 ? 'managed-cron-fixture.invalid' : ids[index]! + '.invalid';
  beforeAll(async () => {
    const url = process.env['TEST_DATABASE_URL']!; if (!new URL(url).pathname.startsWith('/magnus_ideas_')) throw new Error('Owned disposable scheduler DB required');
    credentialDirectory = await mkdtemp(join(tmpdir(), 'scheduler-credential-fixture-'));
    vi.stubEnv('CREDENTIAL_ROTATION_KEY', 'scheduler-rotation-fixture-at-least-32-characters');
    vi.stubEnv('CREDENTIAL_ROTATION_STATE_PATH', join(credentialDirectory, 'rotation.json'));
    vi.stubEnv('DATABASE_URL', url); vi.stubEnv('MAGNUS_RESOURCE_LEASES_ENABLED', 'true');
    db = (await import('../db/index.js')).getDb(); service = await import('./managed-cron.js'); lease = await import('./command-resource-leases.js');
    for (const [index, id] of ids.entries()) {
      await db.node.create({ data: { id, name: id, hostname: host(index), ipAddress: '127.0.0.1', port: 39101 + index,
        os: 'fixture', arch: 'fixture', token: randomUUID(), status: 'ONLINE', lastHeartbeatAt: new Date() } });
      // Explicit enrolled fixture is not a claim that public enrollment is supported.
      await db.resourceEnrollment.create({ data: { nodeId: id, nodeFqdn: host(index), state: 'enrolled', epoch: 1, barrierId: randomUUID() } });
      await db.cronJob.create({ data: { id, nodeId: id, name: 'same-name', schedule: '* * * * *', command: '/usr/bin/printf',
        args: '["fixture-ok"]', timeoutSeconds: 3600, createdBy: 'fixture-operator' } });
    }
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.cronJob.updateMany({ where: { id: { in: ids } }, data: { name: 'same-name', status: 'ACTIVE' } });
    await db.managedCronOccurrence.deleteMany({ where: { nodeId: { in: ids } } });
    await db.managedCronDefinition.deleteMany({ where: { nodeId: { in: ids } } });
    await db.commandResourceLease.deleteMany({ where: { nodeId: { in: ids } } });
    await db.remoteCommand.deleteMany({ where: { nodeId: { in: ids } } });
    await db.resourceEnrollment.updateMany({ where: { nodeId: { in: ids } }, data: { state: 'enrolled' } });
  });
  afterAll(async () => {
    if (db) {
      await db.cronJob.deleteMany({ where: { id: { in: ids } } });
      await db.commandResourceFence.deleteMany({ where: { resourceKey: { in: ids.map(id => 'node:' + id) } } });
      await db.resourceEnrollment.deleteMany({ where: { nodeId: { in: ids } } }); await db.node.deleteMany({ where: { id: { in: ids } } });
      await (await import('../db/index.js')).disconnectDb();
    }
    if (credentialDirectory) await rm(credentialDirectory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  async function registered(index = 0) {
    const definition = await service.registerManagedCron(ids[index]!, { revision: 1, timezone: 'UTC', timeoutSeconds: 3600, expiresAt: Date.now() + 3_600_000 });
    const parsed = JSON.parse(definition.specJson); const nodeJob = makeCronJob(parsed);
    expect(apiSchema.parse(parsed)).toEqual(nodeJob.spec); expect(nodeJob.specSha256).toBe(definition.specSha256); expect(nodeJob.jobId).toBe(definition.jobId);
    const identity = service.managedCronIdentity(definition);
    const stageEvidence = evidence('stage'); const activationEvidence = evidence('activation');
    await service.recordManagedCronStage(definition.cronJobId, { ...identity, staged: true, enabled: false }, stageEvidence);
    await service.activateManagedCron(definition.cronJobId, { ...identity, staged: true, enabled: false },
      { ...identity, activated: true, enabled: true }, stageEvidence, activationEvidence);
    const occurrence = makeOccurrence(nodeJob, Math.floor(Date.now() / 60_000) * 60_000);
    const input = { nodeFqdn: host(index), jobId: definition.jobId, revision: definition.revision,
      specSha256: definition.specSha256, occurrenceId: occurrence.occurrenceId, scheduledAt: occurrence.scheduledAt, deadline: occurrence.deadline };
    return { definition, occurrence, input };
  }
  it('does not give legacy records implicit authority', async () => {
    const input = { nodeFqdn: host(0), jobId: 'a'.repeat(64), revision: 1, specSha256: 'b'.repeat(64), occurrenceId: 'c'.repeat(64), scheduledAt: Math.floor(Date.now() / 60_000) * 60_000, deadline: Date.now() + 60_000 };
    await expect(service.admitCronOccurrence(input)).rejects.toThrow('absent or changed');
    expect(await db.remoteCommand.count({ where: { nodeId: ids[0] } })).toBe(0);
  });
  it('enforces acknowledgement v1 at PostgreSQL so an old binary cannot enable authority', async () => {
    const disabled = prefix + '-constraint-disabled'; const rejected = prefix + '-constraint-rejected';
    const complete = prefix + '-constraint-complete';
    const insertBase = (id: string, enabled: boolean) => db.$executeRawUnsafe(
      `INSERT INTO "managed_cron_definitions" ("cronJobId","nodeId","jobId","revision","specSha256","specJson","enabled","expiresAt")
       VALUES ($1,$2,$3,1,$4,'{}',$5,now() + interval '1 hour')`, id, ids[0], createHmac('sha256', secret).update(id).digest('hex'),
      createHmac('sha256', secret).update('spec:' + id).digest('hex'), enabled);
    try {
      await expect(insertBase(disabled, false)).resolves.toBe(1);
      await expect(db.$executeRawUnsafe('UPDATE "managed_cron_definitions" SET "enabled"=true WHERE "cronJobId"=$1', disabled)).rejects.toThrow();
      await expect(insertBase(rejected, true)).rejects.toThrow();
      const digest = 'a'.repeat(64);
      const acknowledgedJobId = createHmac('sha256', secret).update(complete).digest('hex');
      const acknowledgedSpecSha256 = createHmac('sha256', secret).update('spec:' + complete).digest('hex');
      await expect(db.$executeRawUnsafe(
        `INSERT INTO "managed_cron_definitions" ("cronJobId","nodeId","jobId","revision","specSha256","specJson","enabled","acknowledgementProtocolVersion","stageCommandSha256","stageReceiptSha256","stageAcknowledgedAt","activationCommandSha256","activationReceiptSha256","activationAcknowledgedAt","acknowledgedJobId","acknowledgedRevision","acknowledgedSpecSha256","acknowledgedSpecJson","expiresAt")
         VALUES ($1,$2,$3,1,$4,'{}',true,1,$5,$5,now(),$5,$5,now(),$3,1,$4,'{}',now() + interval '1 hour')`,
        complete, ids[0], acknowledgedJobId, acknowledgedSpecSha256, digest)).resolves.toBe(1);
      for (const mutation of [
        ['"jobId"', 'b'.repeat(64)], ['"revision"', 2], ['"specSha256"', 'c'.repeat(64)], ['"specJson"', '{"changed":true}'],
      ] as const) {
        await expect(db.$executeRawUnsafe(`UPDATE "managed_cron_definitions" SET ${mutation[0]}=$2 WHERE "cronJobId"=$1`,
          complete, mutation[1])).rejects.toThrow();
      }
      await expect(db.$executeRawUnsafe('UPDATE "managed_cron_definitions" SET "enabled"=false WHERE "cronJobId"=$1', complete)).resolves.toBe(1);
      expect(await db.managedCronDefinition.findUniqueOrThrow({ where: { cronJobId: complete } })).toMatchObject({ enabled: false,
        acknowledgementProtocolVersion: null, stageCommandSha256: null, stageReceiptSha256: null, stageAcknowledgedAt: null,
        activationCommandSha256: null, activationReceiptSha256: null, activationAcknowledgedAt: null,
        acknowledgedJobId: null, acknowledgedRevision: null, acknowledgedSpecSha256: null, acknowledgedSpecJson: null });
      await expect(db.$executeRawUnsafe('UPDATE "managed_cron_definitions" SET "enabled"=true WHERE "cronJobId"=$1', complete)).rejects.toThrow();
    } finally {
      await db.managedCronDefinition.deleteMany({ where: { cronJobId: { in: [disabled, rejected, complete] } } });
    }
  });
  it('keeps staged definitions disabled until two exact acknowledgements agree', async () => {
    const definition = await service.registerManagedCron(ids[0]!, { revision: 1, timezone: 'UTC', timeoutSeconds: 3600, expiresAt: Date.now() + 3_600_000 });
    const job = makeCronJob(JSON.parse(definition.specJson)); const row = makeOccurrence(job, Math.floor(Date.now() / 60_000) * 60_000);
    const input = { nodeFqdn: host(0), jobId: job.jobId, revision: 1, specSha256: job.specSha256,
      occurrenceId: row.occurrenceId, scheduledAt: row.scheduledAt, deadline: row.deadline };
    expect(definition.enabled).toBe(false);
    await expect(service.admitCronOccurrence(input)).rejects.toThrow('absent or changed');
    await expect(db.managedCronDefinition.update({ where: { cronJobId: definition.cronJobId }, data: { enabled: true } })).rejects.toThrow();
    const identity = service.managedCronIdentity(definition);
    const stageEvidence = evidence('stage'); const activationEvidence = evidence('activation');
    await service.recordManagedCronStage(definition.cronJobId, { ...identity, staged: true, enabled: false }, stageEvidence);
    await expect(service.activateManagedCron(definition.cronJobId, { ...identity, staged: true, enabled: false },
      { ...identity, specSha256: 'a'.repeat(64), activated: true, enabled: true }, stageEvidence, activationEvidence)).rejects.toThrow('disagree');
    expect((await db.managedCronDefinition.findUniqueOrThrow({ where: { cronJobId: definition.cronJobId } })).enabled).toBe(false);
    await service.activateManagedCron(definition.cronJobId, { ...identity, staged: true, enabled: false },
      { ...identity, activated: true, enabled: true }, stageEvidence, activationEvidence);
    expect(await db.managedCronDefinition.findUniqueOrThrow({ where: { cronJobId: definition.cronJobId } })).toMatchObject({
      enabled: true, acknowledgementProtocolVersion: 1, stageCommandSha256: stageEvidence.commandSha256,
      stageReceiptSha256: stageEvidence.receiptSha256, activationCommandSha256: activationEvidence.commandSha256,
      activationReceiptSha256: activationEvidence.receiptSha256,
      acknowledgedJobId: definition.jobId, acknowledgedRevision: definition.revision,
      acknowledgedSpecSha256: definition.specSha256, acknowledgedSpecJson: definition.specJson,
    });
  });
  it('enables only after ordered exact node stage and activation acknowledgements', async () => {
    const definition = await service.registerManagedCron(ids[0]!, { revision: 1, timezone: 'UTC', timeoutSeconds: 3600, expiresAt: Date.now() + 3_600_000 });
    const identity = service.managedCronIdentity(definition); const calls: string[] = [];
    const stageEvidence = evidence('stage'); const activationEvidence = evidence('activation');
    vi.spyOn(NodeApiClient.prototype, 'syncManagedCronJob').mockImplementation(async () => {
      calls.push('stage'); return { response: { success: true, data: { ...identity, staged: true, enabled: false } }, evidence: stageEvidence };
    });
    vi.spyOn(NodeApiClient.prototype, 'activateManagedCronJob').mockImplementation(async () => {
      calls.push('activate'); return { response: { success: true, data: { ...identity, activated: true, enabled: true } }, evidence: activationEvidence };
    });
    expect((await service.installManagedCron(definition.cronJobId, 'fixture-operator')).enabled).toBe(true);
    expect(calls).toEqual(['stage', 'activate']);
  });
  it('requires exact revocation acknowledgement after disabling central authority', async () => {
    const { definition } = await registered();
    const prepared = await service.prepareManagedCronRevocation(definition.cronJobId);
    expect(prepared?.definition.enabled).toBe(false);
    await expect(service.confirmManagedCronRevocation(definition.cronJobId, prepared!.identity,
      { ...prepared!.identity, specSha256: 'a'.repeat(64), revoked: true, enabled: false })).rejects.toThrow('differs');
    await service.confirmManagedCronRevocation(definition.cronJobId, prepared!.identity,
      { ...prepared!.identity, revoked: true, enabled: false });
    await service.finalizeManagedCronRevocation(definition.cronJobId, prepared!.identity, { status: 'PAUSED' });
    expect((await db.managedCronDefinition.findUniqueOrThrow({ where: { cronJobId: definition.cronJobId } })).enabled).toBe(false);
    expect((await db.cronJob.findUniqueOrThrow({ where: { id: definition.cronJobId } })).status).toBe('PAUSED');
  });
  it('clears revoked evidence and requires a fresh stage and activation before reactivation', async () => {
    const { definition } = await registered(); const identity = service.managedCronIdentity(definition);
    const prepared = await service.prepareManagedCronRevocation(definition.cronJobId);
    expect(prepared?.definition).toMatchObject({ enabled: false, acknowledgementProtocolVersion: null,
      stageCommandSha256: null, activationCommandSha256: null, acknowledgedJobId: null });
    await service.confirmManagedCronRevocation(definition.cronJobId, identity,
      { ...identity, revoked: true, enabled: false });
    const restaged = await service.registerManagedCron(definition.cronJobId,
      { revision: definition.revision, timezone: 'UTC', timeoutSeconds: 3600, expiresAt: definition.expiresAt.getTime() });
    const freshIdentity = service.managedCronIdentity(restaged);
    const freshStage = evidence('fresh-stage'); const freshActivation = evidence('fresh-activation');
    await service.recordManagedCronStage(restaged.cronJobId, { ...freshIdentity, staged: true, enabled: false }, freshStage);
    await service.activateManagedCron(restaged.cronJobId, { ...freshIdentity, staged: true, enabled: false },
      { ...freshIdentity, activated: true, enabled: true }, freshStage, freshActivation);
    expect(await db.managedCronDefinition.findUniqueOrThrow({ where: { cronJobId: restaged.cronJobId } })).toMatchObject({
      enabled: true, acknowledgementProtocolVersion: 1, stageCommandSha256: freshStage.commandSha256,
      activationCommandSha256: freshActivation.commandSha256, acknowledgedJobId: freshIdentity.jobId,
    });
  });
  it('persists pending history before pre-drain staging so a racing raw mutation cannot restore the job', async () => {
    const nodeId = prefix + '-legacy'; const cronJobId = nodeId + '-cron';
    vi.stubEnv('MAGNUS_RESOURCE_LEASES_ENABLED', 'false');
    vi.stubEnv('COMMAND_RECONCILIATION_SECRET', 'managed-cron-conversion-fixture-at-least-32-characters');
    try {
      await db.node.create({ data: { id: nodeId, name: nodeId, hostname: nodeId + '.invalid', ipAddress: '127.0.0.1', port: 39109,
        os: 'fixture', arch: 'fixture', token: randomUUID(), status: 'ONLINE', lastHeartbeatAt: new Date() } });
      expect(await service.cronMutationMode(nodeId)).toBe('legacy');
      await db.cronJob.create({ data: { id: cronJobId, nodeId, name: 'legacy', schedule: '* * * * *', command: '/usr/bin/true',
        timeoutSeconds: 60, createdBy: 'fixture' } });
      const admissionApp = new Hono().route('/resource-leases', (await import('../routes/resource-leases.js')).resourceLeasesRouter);
      vi.spyOn(NodeApiClient.prototype, 'stageManagedCronForEnrollment').mockImplementation(async assertion => {
        const pending = await db.managedCronDefinition.findUniqueOrThrow({ where: { cronJobId } });
        expect(pending).toMatchObject({ enabled: false, acknowledgementProtocolVersion: null });
        const racingRawMutation = await admissionApp.request('/resource-leases/legacy-admission', { method: 'POST',
          headers: { 'content-type': 'application/json', 'x-node-token': 'managed-cron-node-fixture-at-least-32-characters' },
          body: JSON.stringify({ nodeFqdn: nodeId + '.invalid', nonce: randomUUID() }) });
        expect(await racingRawMutation.json()).toMatchObject({ data: { enrolled: true, allowedLegacy: false } });
        const job = makeCronJob(assertion.spec); const receipt = { nodeFqdn: assertion.spec.nodeFqdn,
          name: assertion.spec.name, jobId: job.jobId, revision: assertion.spec.revision, specSha256: job.specSha256,
          operationId: assertion.operationId, staged: true as const, enabled: false as const };
        return { success: true, data: { ...receipt, receiptSignature: createHmac('sha256', secret)
          .update(cronEnrollmentStageReceiptPayload(receipt)).digest('hex') } };
      });
      const converted = await service.stageLegacyCronForEnrollment(cronJobId,
        { revision: 1, timezone: 'UTC', timeoutSeconds: 60, expiresAt: Date.now() + 60_000 });
      expect(converted).toMatchObject({ enabled: false, acknowledgementProtocolVersion: null });
      const legacyAdmission = await admissionApp.request('/resource-leases/legacy-admission', { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-node-token': 'managed-cron-node-fixture-at-least-32-characters' },
        body: JSON.stringify({ nodeFqdn: nodeId + '.invalid', nonce: randomUUID() }) });
      expect(await legacyAdmission.json()).toMatchObject({ data: { enrolled: true, allowedLegacy: false } });
      await expect(service.cronMutationMode(nodeId)).rejects.toThrow('enrollment');
    } finally {
      await db.managedCronDefinition.deleteMany({ where: { nodeId } }); await db.cronJob.deleteMany({ where: { nodeId } });
      await db.node.deleteMany({ where: { id: nodeId } }); vi.stubEnv('MAGNUS_RESOURCE_LEASES_ENABLED', 'true');
      vi.stubEnv('COMMAND_RECONCILIATION_SECRET', '');
    }
  });
  it('accepts one fresh barrier-bound foreign-source decision only with an exact signed node receipt', async () => {
    const reconciliationKey = 'scheduler-reconciliation-fixture-at-least-32-characters';
    vi.stubEnv('COMMAND_RECONCILIATION_SECRET', reconciliationKey);
    const enrollment = await db.resourceEnrollment.findUniqueOrThrow({ where: { nodeId: ids[0] } });
    await db.resourceEnrollment.update({ where: { nodeId: ids[0] }, data: { state: 'draining' } });
    const unsigned = { version: 1 as const, sourceIdentityVersion: 2 as const, nodeId: ids[0]!, nodeFqdn: host(0), epoch: enrollment.epoch,
      barrierId: enrollment.barrierId!, kind: 'SYSTEM_CRONTAB', sourceSha256: 'a'.repeat(64), count: 1,
      disposition: 'no_effect_verified' as const, evidenceSha256: 'b'.repeat(64), approvalRef: 'telegram:fixture',
      decisionId: randomUUID(), expiresAt: Date.now() + 60_000 };
    const assertion = { ...unsigned, signature: createHmac('sha256', reconciliationKey)
      .update(schedulerSourceSettlementSigningPayload(unsigned)).digest('hex') };
    const receipt = { ...unsigned, settled: true as const, replayed: false };
    vi.spyOn(NodeApiClient.prototype, 'reconcileSchedulerSource').mockResolvedValue({ success: true, data: { ...receipt,
      receiptSignature: createHmac('sha256', secret).update(schedulerSourceSettlementReceiptPayload(receipt)).digest('hex') } });
    expect(await service.reconcileForeignSchedulerSource(assertion)).toMatchObject({ decisionId: unsigned.decisionId, settled: true, replayed: false });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(unsigned.expiresAt + 1);
    try { expect(await service.reconcileForeignSchedulerSource(assertion)).toMatchObject({ decisionId: unsigned.decisionId, settled: true }); }
    finally { clock.mockRestore(); }
    vi.stubEnv('COMMAND_RECONCILIATION_SECRET', '');
  });
  it('reauthorizes a renamed job under its new canonical identity', async () => {
    const first = await registered();
    await db.cronJob.update({ where: { id: ids[0] }, data: { name: 'renamed' } });
    await db.managedCronDefinition.update({ where: { cronJobId: ids[0] }, data: { enabled: false } });
    const definition = await service.registerManagedCron(ids[0]!, { revision: 2, timezone: 'UTC', timeoutSeconds: 3600, expiresAt: Date.now() + 3_600_000 });
    const job = makeCronJob(JSON.parse(definition.specJson)); expect(definition.jobId).toBe(job.jobId); expect(job.jobId).not.toBe(first.definition.jobId);
    const identity = service.managedCronIdentity(definition); await service.activateManagedCron(definition.cronJobId,
      { ...identity, staged: true, enabled: false }, { ...identity, activated: true, enabled: true },
      await (async () => { const value = evidence('stage'); await service.recordManagedCronStage(definition.cronJobId,
        { ...identity, staged: true, enabled: false }, value); return value; })(), evidence('activation'));
    const row = makeOccurrence(job, Math.floor(Date.now() / 60_000) * 60_000);
    expect((await service.admitCronOccurrence({ nodeFqdn: host(0), jobId: job.jobId, revision: 2, specSha256: job.specSha256,
      occurrenceId: row.occurrenceId, scheduledAt: row.scheduledAt, deadline: row.deadline })).commandId).toBe(row.command.commandId);
  });
  it('admits same-name same-minute jobs on two nodes with distinct durable command identities', async () => {
    const [first, second] = await Promise.all([registered(0), registered(1)]);
    expect(first.input.occurrenceId).not.toBe(second.input.occurrenceId);
    const grants = await Promise.all([service.admitCronOccurrence(first.input), service.admitCronOccurrence(second.input)]);
    expect(new Set(grants.map(grant => grant.commandId)).size).toBe(2);
    expect(grants[0]!.coordination.expiresAt).toBe(first.input.deadline);
    expect(await db.commandResourceLease.count({ where: { nodeId: { in: ids }, state: 'running' } })).toBe(2);
  });
  it('serializes two competing trigger processes and never grants the occurrence twice', async () => {
    const { input } = await registered();
    const attempts = await Promise.allSettled([service.admitCronOccurrence(input), service.admitCronOccurrence(input)]);
    expect(attempts.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(await db.remoteCommand.count({ where: { nodeId: ids[0] } })).toBe(1);
  });
  it('rejects forged timing, revision, digest and cross-node occurrence identity', async () => {
    const { input } = await registered();
    for (const changed of [{ deadline: input.deadline + 1 }, { scheduledAt: input.scheduledAt - 60_000 }, { revision: 2 }, { specSha256: 'a'.repeat(64) }, { nodeFqdn: host(1) }]) {
      await expect(service.admitCronOccurrence({ ...input, ...changed })).rejects.toThrow();
    }
    expect(await db.remoteCommand.count({ where: { nodeId: ids[0] } })).toBe(0);
  });
  it('denies drain-started nodes under the shared node lock', async () => {
    const { input } = await registered(); await db.resourceEnrollment.update({ where: { nodeId: ids[0] }, data: { state: 'draining' } });
    await expect(service.admitCronOccurrence(input)).rejects.toThrow('enrollment');
    expect(await db.remoteCommand.count({ where: { nodeId: ids[0] } })).toBe(0);
  });
  it('rechecks revision revocation in the final dispatch transaction', async () => {
    const { input } = await registered(); const original = lease.markResourceDispatched;
    vi.spyOn(lease, 'markResourceDispatched').mockImplementation(async (admission, guard) => {
      await db.$transaction(async tx => {
        const { lockResourceNode } = await import('./resource-node-lock.js'); await lockResourceNode(tx, ids[0]!);
        await tx.managedCronDefinition.update({ where: { cronJobId: ids[0] }, data: { enabled: false } });
      });
      return original(admission, guard);
    });
    await expect(service.admitCronOccurrence(input)).rejects.toThrow('changed before');
    expect((await db.commandResourceLease.findFirst({ where: { nodeId: ids[0] } }))?.state).toBe('reserved');
    expect((await db.managedCronOccurrence.findUnique({ where: { id: input.occurrenceId } }))?.state).toBe('unknown');
  });
  it('runs a bounded real local process through API grant, node ledger and supervisor, then recovers its lost acknowledgment', async () => {
    const { definition } = await registered();
    const { ManagedScheduler } = await import('../../../../packages/agent/src/executors/managed-scheduler.js');
    const { schedulerAuthority } = await import('../../../../packages/agent/src/executors/scheduler-authority.js');
    const { CommandLedger } = await import('../../../../packages/agent/src/executors/command-ledger.js');
    const { ExecutionSupervisor } = await import('../../../../packages/agent/src/executors/execution-supervisor.js');
    const { readJson, writeJson } = await import('../../../../packages/agent/src/executors/execution-supervisor-state.js');
    const directory = await mkdtemp(join(tmpdir(), 'scheduler-integrated-'));
    let launches = 0; let unit: Record<string, string> | null = null;
    const backend = {
      probe: async () => ({ bootId: 'fixture-boot' }), listUnits: async () => [],
      inspect: async () => unit, empty: async () => true, signal: async () => {},
      launch: async (intent: import('../../../../packages/agent/src/executors/execution-supervisor-state.js').ExecutionIntent, path: string) => {
        launches++;
        const request = (await readJson<import('../../../../packages/agent/src/executors/execution-supervisor-state.js').SupervisorInput>(path, 'request.json'))!;
        await writeJson(path, 'started.json', { version: 1, nonce: intent.nonce, requestSha256: intent.requestSha256, invocationId: 'a'.repeat(32), cgroup: '/fixture/' + intent.unit, startedAt: Date.now() });
        const output = await promisify(execFile)(request.command, request.args, { timeout: 2000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin' } });
        await writeJson(path, 'result.json', { version: 1, nonce: intent.nonce, requestSha256: intent.requestSha256, invocationId: 'a'.repeat(32), exitCode: 0, stdout: output.stdout, stderr: output.stderr, durationMs: 1, truncated: false });
        unit = { LoadState: 'loaded', ActiveState: 'active', SubState: 'exited', InvocationID: 'a'.repeat(32), Description: 'Magnus execution ' + intent.nonce + ' ' + intent.requestSha256,
          ControlGroup: '', ExecMainCode: '1', ExecMainStatus: '0', Result: 'success', KillMode: 'control-group', ExitType: 'cgroup', RemainAfterExit: 'yes', Restart: 'no' };
        throw new Error('Original launch acknowledgment lost');
      },
    };
    try {
      const supervisor = new ExecutionSupervisor({ root: join(directory, 'supervisor'), backend, workerDirectory: resolve('../../packages/agent/dist/executors'), pollMs: 10 });
      const ledger = new CommandLedger(join(directory, 'ledger'), { resultSecret: secret, reconciliationSecret: '', nodeFqdn: host(0) });
      const app = new Hono(); app.route('/resource-leases', (await import('../routes/resource-leases.js')).resourceLeasesRouter);
      const post = async (path: string, body: unknown) => {
        if (path.endsWith('/admit')) return service.admitCronOccurrence(body as import('./managed-cron.js').SchedulerTrigger);
        if (path.endsWith('/settle')) return service.settleCronOccurrence(body as Parameters<typeof service.settleCronOccurrence>[0]);
        const response = await app.request('http://fixture/' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-node-token': 'managed-cron-node-fixture-at-least-32-characters' }, body: JSON.stringify(body) });
        expect(response.status).toBe(200); return (await response.json() as { data: Record<string, unknown> }).data;
      };
      const authority = schedulerAuthority({ ledger, supervisor, post });
      const store = new ManagedScheduler(join(directory, 'scheduler')); const job = makeCronJob(JSON.parse(definition.specJson));
      await store.locked(() => store.saveJob(job));
      const first = await store.trigger(job.jobId, 1, authority); expect(first.state).toBe('unknown');
      expect((await ledger.receipt(first.command.commandId))?.state).toBe('unknown');
      const recovered = await new ManagedScheduler(store.root).recover(first.occurrenceId, authority);
      expect(recovered.state).toBe('completed'); expect(recovered.result?.stdout).toBe('fixture-ok'); expect(recovered.settlementPending).toBe(false);
      expect((await ledger.receipt(first.command.commandId))?.state).toBe('completed');
      expect((await db.commandResourceLease.findUniqueOrThrow({ where: { commandId: first.command.commandId } })).state).toBe('released');
      expect(launches).toBe(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('settles only the original signed command result and retains the same receipt on retries', async () => {
    const { input } = await registered(); const grant = await service.admitCronOccurrence(input);
    const authority = await db.commandResourceLease.findUniqueOrThrow({ where: { commandId: grant.commandId } });
    expect(authority).toMatchObject({ completionClass: 'managed-scheduler', completionOccurrenceId: input.occurrenceId,
      completionSpecSha256: input.specSha256, completionRegistryVersion: null,
      completionRegistrySha256: null, completionDescriptorId: null });
    await expect(db.commandResourceLease.update({ where: { id: authority.id },
      data: { completionSpecSha256: 'f'.repeat(64) } })).rejects.toThrow('command resource authority is immutable');
    const stored = await db.remoteCommand.findUniqueOrThrow({ where: { id: grant.commandId } });
    const command = { commandId: stored.id, command: stored.command, args: JSON.parse(stored.args), timeoutSeconds: stored.timeoutSeconds, environment: JSON.parse(stored.environment), coordination: JSON.parse(stored.coordinationJson!) };
    const value = { commandId: stored.id, exitCode: 0, stdout: 'fixture-ok', stderr: '', durationMs: 1, truncated: false,
      coordination: { ...command.coordination, requestSha256: commandRequestDigest(command) } };
    const result = { ...value, signature: createHmac('sha256', secret).update(commandResultSigningPayload(value)).digest('hex') };
    await expect(service.settleCronOccurrence({ nodeFqdn: input.nodeFqdn, occurrenceId: input.occurrenceId, result: { ...result, signature: '0'.repeat(64) } })).rejects.toThrow('Signed');
    expect((await db.commandResourceLease.findUniqueOrThrow({ where: { commandId: stored.id } })).state).toBe('running');
    const v3Value = { ...value, completion: { registryVersion: 1 as const,
      registrySha256: (await import('../security/command-completion-registry.js')).COMMAND_COMPLETION_REGISTRY_SHA256,
      descriptorId: 'diagnostics-uptime-v1' } };
    const v3Result = { ...v3Value, signature: createHmac('sha256', secret).update(commandResultSigningPayload(v3Value)).digest('hex') };
    await expect(service.settleCronOccurrence({ nodeFqdn: input.nodeFqdn, occurrenceId: input.occurrenceId, result: v3Result }))
      .rejects.toThrow('registered whole-effect evidence');
    expect((await db.commandResourceLease.findUniqueOrThrow({ where: { commandId: stored.id } })).state).toBe('running');
    await db.managedCronOccurrence.update({ where: { id: input.occurrenceId }, data: { specSha256: 'e'.repeat(64) } });
    await expect(service.settleCronOccurrence({ nodeFqdn: input.nodeFqdn, occurrenceId: input.occurrenceId, result }))
      .rejects.toThrow('scheduler completion authority differs');
    expect((await db.commandResourceLease.findUniqueOrThrow({ where: { commandId: stored.id } })).state).toBe('running');
    await db.managedCronOccurrence.update({ where: { id: input.occurrenceId }, data: { specSha256: input.specSha256 } });
    expect((await service.settleCronOccurrence({ nodeFqdn: input.nodeFqdn, occurrenceId: input.occurrenceId, result })).state).toBe('completed');
    expect((await service.settleCronOccurrence({ nodeFqdn: input.nodeFqdn, occurrenceId: input.occurrenceId, result })).state).toBe('completed');
    await expect(service.admitCronOccurrence(input)).rejects.toThrow('already claimed');
    expect((await db.commandResourceLease.findUniqueOrThrow({ where: { commandId: stored.id } })).state).toBe('released');
  });
});
