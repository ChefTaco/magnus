/** Disposable PostgreSQL + real loopback SSH; no fleet commands or credentials. */
import { createHmac, randomUUID, generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Server } from 'ssh2';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
const nodeId = `api-ssh-${randomUUID()}`; const host = `${nodeId}.invalid`;
describe.skipIf(!process.env['TEST_DATABASE_URL'])('API SSH durable participant ownership (PostgreSQL)', () => {
  let db: ReturnType<typeof import('../db/index.js')['getDb']>;
  let work: typeof import('./resource-participant-work.js');
  let enrollment: typeof import('./resource-enrollment.js');
  let admission: typeof import('./managed-ssh-admission.js');
  const input = () => ({ host, workId: randomUUID(), ownerId: randomUUID(), kind: 'ssh-command' as const,
    operationSha256: 'c'.repeat(64), deadline: Date.now() + 600_000 });
  const reconciliationKey = 'participant-reconciliation-fixture-key-at-least-32-characters';
  const resultKey = 'participant-node-result-fixture-key-at-least-32-characters';
  const assertion = async (saved: Awaited<ReturnType<typeof work.apiParticipantWork.reserve>>, patch: Record<string, unknown> = {}) => {
    const schema = await import('../schemas/resource-participant-reconciliation.js');
    const unsigned = schema.participantWorkReconciliationSchema.omit({ signature: true }).parse({
      version: 1, workId: saved.workId, nodeId: saved.nodeId, nodeFqdn: saved.nodeFqdn,
      participant: saved.participant, ownerId: saved.ownerId, kind: saved.kind, epoch: saved.epoch,
      barrierId: saved.barrierId, operationSha256: saved.operationSha256!, fence: saved.fence!, deadline: saved.deadline!,
      requestSha256: saved.requestSha256!, disposition: 'effects_verified' as const,
      evidenceSha256: 'e'.repeat(64), approvalRef: 'telegram:fixture-approved', decisionId: `decision-${randomUUID()}`,
      expiresAt: Date.now() + 60_000, ...patch,
    });
    return { ...unsigned, signature: createHmac('sha256', reconciliationKey)
      .update(schema.participantWorkReconciliationSigningPayload(unsigned)).digest('hex') };
  };
  beforeAll(async () => {
    const url = process.env['TEST_DATABASE_URL']!;
    if (!new URL(url).pathname.startsWith('/magnus_ideas')) throw new Error('Disposable fixture database required');
    vi.stubEnv('DATABASE_URL', url); vi.stubEnv('MAGNUS_RESOURCE_LEASES_ENABLED', 'false');
    vi.stubEnv('RESULT_SIGNING_SECRET', resultKey);
    db = (await import('../db/index.js')).getDb();
    work = await import('./resource-participant-work.js'); enrollment = await import('./resource-enrollment.js');
    admission = await import('./managed-ssh-admission.js');
    await db.node.create({ data: { id: nodeId, hostname: host, name: nodeId, ipAddress: '127.0.0.1', port: 4100,
      os: 'fixture', arch: 'fixture', token: randomUUID(), status: 'ONLINE', lastHeartbeatAt: new Date() } });
  });
  afterEach(async () => {
    vi.stubEnv('MAGNUS_RESOURCE_LEASES_ENABLED', 'false');
    vi.stubEnv('RESOURCE_PARTICIPANT_RECONCILIATION_SECRET', reconciliationKey);
    vi.stubEnv('COMMAND_RECONCILIATION_SECRET', '');
    await db.resourceParticipantWork.deleteMany({ where: { nodeId } });
    await db.resourceDrainParticipant.deleteMany({ where: { nodeId } });
    await db.resourceEnrollment.deleteMany({ where: { nodeId } });
  });
  afterAll(async () => { if (db) { await db.node.delete({ where: { id: nodeId } }); await (await import('../db/index.js')).disconnectDb(); } vi.unstubAllEnvs(); });
  it('records API running before any callback effect and keeps successful results usable', async () => {
    const value = await admission.withApiSshOwnership(host, 'ssh-command', async () => {
      expect(await db.resourceParticipantWork.findFirst({ where: { nodeId, participant: 'api' } })).toMatchObject({ state: 'running', kind: 'ssh-command' });
      return { code: 0, output: 'fixture' };
    });
    expect(value).toEqual({ code: 0, output: 'fixture' });
    expect(await db.resourceParticipantWork.findFirst({ where: { nodeId } })).toMatchObject({ state: 'unknown', settlement: 'descendants-unverified', settledAt: null });
  });
  it('retains ownership on callback loss and does not resubmit or substitute its error', async () => {
    let calls = 0; const lost = new Error('fixture connection reply lost');
    await expect(admission.withApiSshOwnership(host, 'agent-upgrade', async () => { calls++; throw lost; })).rejects.toBe(lost);
    expect(calls).toBe(1); expect(await db.resourceParticipantWork.count({ where: { nodeId, state: 'unknown' } })).toBe(1);
  });
  it('commits a not-dispatched release when drain wins after reservation', async () => {
    const saved = await work.apiParticipantWork.reserve(input()); await enrollment.beginEnrollmentDrain(nodeId, 'fixture');
    await expect(work.apiParticipantWork.start(saved.workId, saved)).rejects.toMatchObject({ code: 'RESOURCE_DRAIN_REQUIRED' });
    expect(await db.resourceParticipantWork.findUnique({ where: { workId: saved.workId } })).toMatchObject({ state: 'released', settlement: 'barrier-before-dispatch' });
  });
  it('serializes concurrent starts into exactly one non-replayable grant', async () => {
    const saved = await work.apiParticipantWork.reserve(input());
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => work.apiParticipantWork.start(saved.workId, saved)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected').every(r => r.status === 'rejected' && r.reason.code === 'RESOURCE_WORK_CONFLICT')).toBe(true);
    await expect(work.apiParticipantWork.reserve({ host, ...saved, kind: 'ssh-command' })).resolves.toMatchObject({ workId: saved.workId, state: 'running' });
    await expect(work.apiParticipantWork.start(saved.workId, saved)).rejects.toMatchObject({ code: 'RESOURCE_WORK_CONFLICT' });
  });
  it('races start versus drain without an unowned dispatch interval', async () => {
    const saved = await work.apiParticipantWork.reserve(input());
    const [started] = await Promise.allSettled([work.apiParticipantWork.start(saved.workId, saved), enrollment.beginEnrollmentDrain(nodeId, 'fixture')]);
    const row = await db.resourceParticipantWork.findUniqueOrThrow({ where: { workId: saved.workId } });
    expect(row.state).toBe(started.status === 'fulfilled' ? 'running' : 'released');
    expect((await enrollment.inspectEnrollment(nodeId)).api.activeCount).toBe(started.status === 'fulfilled' ? 1 : 0);
    const effect = vi.fn(); await expect(admission.withApiSshOwnership(host, 'ssh-command', effect)).rejects.toMatchObject({ code: 'RESOURCE_DRAIN_REQUIRED' });
    expect(effect).not.toHaveBeenCalled();
  });
  it('denies a saved address grant if inventory changes before start', async () => {
    const saved = await work.apiParticipantWork.reserve({ ...input(), host: '127.0.0.1' });
    await db.node.update({ where: { id: nodeId }, data: { ipAddress: '127.0.0.2' } });
    try {
      await expect(work.apiParticipantWork.start(saved.workId, { ...saved, targetHost: '127.0.0.1' })).rejects.toMatchObject({ code: 'RESOURCE_DRAIN_REQUIRED' });
      expect(await db.resourceParticipantWork.findUnique({ where: { workId: saved.workId } })).toMatchObject({ state: 'released' });
    } finally { await db.node.update({ where: { id: nodeId }, data: { ipAddress: '127.0.0.1' } }); }
  });
  it('fixed dashboard principal cannot reserve, start or settle API work', async () => {
    const original = input(); const saved = await work.apiParticipantWork.reserve(original);
    await expect(work.dashboardParticipantWork.reserve(original)).rejects.toMatchObject({ code: 'RESOURCE_WORK_INVALID' });
    await expect(work.dashboardParticipantWork.start(saved.workId, saved)).rejects.toMatchObject({ code: 'RESOURCE_WORK_CONFLICT' });
    await expect(work.dashboardParticipantWork.finish(saved.workId, { ownerId: saved.ownerId, disposition: 'not-started', evidenceSha256: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'RESOURCE_WORK_CONFLICT' });
  });
  it('never releases started work for remote exit, elapsed age, or a later not-started assertion', async () => {
    const saved = await work.apiParticipantWork.reserve(input()); await work.apiParticipantWork.start(saved.workId, saved);
    await db.resourceParticipantWork.update({ where: { workId: saved.workId }, data: { startedAt: new Date(0), createdAt: new Date(0) } });
    for (const disposition of ['remote-ended', 'unknown', 'not-started'] as const) {
      expect(await work.apiParticipantWork.finish(saved.workId, { ownerId: saved.ownerId, disposition, evidenceSha256: 'a'.repeat(64) })).toMatchObject({ state: 'unknown' });
    }
    await enrollment.beginEnrollmentDrain(nodeId, 'fixture');
    expect((await enrollment.inspectEnrollment(nodeId)).api.unknownCount).toBe(1);
    await expect(enrollment.completeEnrollment(nodeId)).rejects.toMatchObject({ code: 'RESOURCE_DRAIN_INCOMPLETE' });
  });
  it('settles once from exact signed supervisor evidence and replays only the same receipt', async () => {
    const saved = await work.apiParticipantWork.reserve(input()); await work.apiParticipantWork.start(saved.workId, saved);
    await expect(work.apiParticipantWork.finish(saved.workId, { ownerId: saved.ownerId, disposition: 'remote-ended',
      evidenceSha256: '0'.repeat(64) })).resolves.toMatchObject({ state: 'unknown' });
    const schema = await import('../schemas/node-session-receipt.js');
    const registry = await import('../security/command-completion-registry.js');
    const now = Date.now();
    const unsigned = schema.nodeSessionReceiptUnsignedSchema.parse({
      version: 1, workId: saved.workId, nodeId: saved.nodeId, nodeFqdn: saved.nodeFqdn,
      participant: saved.participant, ownerId: saved.ownerId, kind: saved.kind,
      operationSha256: saved.operationSha256, requestSha256: saved.requestSha256, fence: saved.fence, deadline: saved.deadline,
      bootId: randomUUID(), unit: `magnus-exec-${'c'.repeat(64)}.service`, invocationId: 'd'.repeat(32),
      cgroup: `/system.slice/magnus-exec-${'c'.repeat(64)}.service`, startedAt: now, terminalAt: now + 1,
      disposition: 'succeeded', resultSha256: 'e'.repeat(64), groupEmpty: true, effectBoundary: 'bounded-node-process',
      completionRegistrySha256: registry.COMMAND_COMPLETION_REGISTRY_SHA256, completionDescriptorId: 'diagnostics-uptime-v1',
    });
    const receipt = { ...unsigned, signature: createHmac('sha256', resultKey).update(schema.nodeSessionReceiptSigningPayload(unsigned)).digest('hex') };
    const unregisteredUnsigned = { ...unsigned, completionRegistrySha256: 'f'.repeat(64) };
    const unregistered = { ...unregisteredUnsigned, signature: createHmac('sha256', resultKey)
      .update(schema.nodeSessionReceiptSigningPayload(unregisteredUnsigned)).digest('hex') };
    await expect(work.settleParticipantWorkFromNodeReceipt(unregistered)).rejects.toMatchObject({ code: 'RESOURCE_EVIDENCE_INVALID' });
    await expect(work.settleParticipantWorkFromNodeReceipt(receipt)).resolves.toMatchObject({ state: 'released' });
    await expect(work.settleParticipantWorkFromNodeReceipt(receipt)).resolves.toMatchObject({ state: 'released' });
    expect(await db.resourceParticipantWork.findUniqueOrThrow({ where: { workId: saved.workId } })).toMatchObject({
      settlement: 'signed-node-session:succeeded', evidenceSha256: 'e'.repeat(64),
    });
    const changed = { ...receipt, disposition: 'failed' as const };
    changed.signature = createHmac('sha256', resultKey).update(schema.nodeSessionReceiptSigningPayload(changed)).digest('hex');
    await expect(work.settleParticipantWorkFromNodeReceipt(changed)).rejects.toMatchObject({ code: 'RESOURCE_WORK_CONFLICT' });
  });
  it.each([
    { participant: 'api' as const, kind: 'agent-deploy' as const },
    { participant: 'dashboard' as const, kind: 'terminal-http' as const },
  ])('keeps $participant/$kind running when presented with the uptime completion descriptor', async ({ participant, kind }) => {
    const manager = participant === 'api' ? work.apiParticipantWork : work.dashboardParticipantWork;
    const saved = await manager.reserve({ ...input(), kind }); await manager.start(saved.workId, saved);
    const schema = await import('../schemas/node-session-receipt.js');
    const registry = await import('../security/command-completion-registry.js'); const now = Date.now();
    const unsigned = schema.nodeSessionReceiptUnsignedSchema.parse({
      version: 1, workId: saved.workId, nodeId: saved.nodeId, nodeFqdn: saved.nodeFqdn,
      participant: saved.participant, ownerId: saved.ownerId, kind: saved.kind,
      operationSha256: saved.operationSha256, requestSha256: saved.requestSha256, fence: saved.fence, deadline: saved.deadline,
      bootId: randomUUID(), unit: `magnus-exec-${'c'.repeat(64)}.service`, invocationId: 'd'.repeat(32),
      cgroup: `/system.slice/magnus-exec-${'c'.repeat(64)}.service`, startedAt: now, terminalAt: now + 1,
      disposition: 'succeeded', resultSha256: 'e'.repeat(64), groupEmpty: true, effectBoundary: 'bounded-node-process',
      completionRegistrySha256: registry.COMMAND_COMPLETION_REGISTRY_SHA256, completionDescriptorId: 'diagnostics-uptime-v1',
    });
    const receipt = { ...unsigned, signature: createHmac('sha256', resultKey)
      .update(schema.nodeSessionReceiptSigningPayload(unsigned)).digest('hex') };
    await expect(work.settleParticipantWorkFromNodeReceipt(receipt)).rejects.toMatchObject({ code: 'RESOURCE_EVIDENCE_INVALID' });
    expect(await db.resourceParticipantWork.findUniqueOrThrow({ where: { workId: saved.workId } }))
      .toMatchObject({ state: 'running', settlement: null, nodeSessionReceiptSha256: null });
  });
  it('rejects stale, successor, unsigned, and external terminal claims without release', async () => {
    const first = await work.apiParticipantWork.reserve(input()); await work.apiParticipantWork.start(first.workId, first);
    const second = await work.apiParticipantWork.reserve({ ...input(), operationSha256: 'd'.repeat(64) }); await work.apiParticipantWork.start(second.workId, second);
    const schema = await import('../schemas/node-session-receipt.js');
    const registry = await import('../security/command-completion-registry.js'); const now = Date.now();
    const unsigned = schema.nodeSessionReceiptUnsignedSchema.parse({
      version: 1, workId: second.workId, nodeId: second.nodeId, nodeFqdn: second.nodeFqdn, participant: second.participant,
      ownerId: second.ownerId, kind: second.kind, operationSha256: first.operationSha256, requestSha256: first.requestSha256,
      fence: first.fence, deadline: first.deadline, bootId: randomUUID(), unit: `magnus-exec-${'a'.repeat(64)}.service`,
      invocationId: 'b'.repeat(32), cgroup: `/system.slice/magnus-exec-${'a'.repeat(64)}.service`, startedAt: now,
      terminalAt: now + 1, disposition: 'no_effect', resultSha256: 'c'.repeat(64), groupEmpty: true, effectBoundary: 'bounded-node-process',
      completionRegistrySha256: registry.COMMAND_COMPLETION_REGISTRY_SHA256, completionDescriptorId: 'diagnostics-uptime-v1',
    });
    const crossBound = { ...unsigned, signature: createHmac('sha256', resultKey).update(schema.nodeSessionReceiptSigningPayload(unsigned)).digest('hex') };
    await expect(work.settleParticipantWorkFromNodeReceipt(crossBound)).rejects.toMatchObject({ code: 'RESOURCE_EVIDENCE_INVALID' });
    await expect(work.settleParticipantWorkFromNodeReceipt({ ...crossBound, operationSha256: second.operationSha256 }))
      .rejects.toMatchObject({ status: 403 });
    expect(await db.resourceParticipantWork.findUniqueOrThrow({ where: { workId: second.workId } })).toMatchObject({ state: 'running' });
  });
  it('releases exact unresolved work once using a signed reviewed reconciliation and replays it idempotently', async () => {
    vi.stubEnv('RESOURCE_PARTICIPANT_RECONCILIATION_SECRET', reconciliationKey);
    const saved = await work.apiParticipantWork.reserve(input()); await work.apiParticipantWork.start(saved.workId, saved);
    await work.apiParticipantWork.finish(saved.workId, { ownerId: saved.ownerId, disposition: 'remote-ended', evidenceSha256: 'a'.repeat(64) });
    const signed = await assertion(saved);
    expect(await work.reconcileParticipantWork(signed)).toMatchObject({ state: 'released', requestSha256: saved.requestSha256 });
    const row = await db.resourceParticipantWork.findUniqueOrThrow({ where: { workId: saved.workId } });
    expect(row).toMatchObject({ state: 'released', settlement: 'signed-reconciliation:effects_verified',
      evidenceSha256: signed.evidenceSha256, reconciliationDecisionId: signed.decisionId });
    vi.spyOn(Date, 'now').mockReturnValue(signed.expiresAt + 1);
    await expect(work.reconcileParticipantWork(signed)).resolves.toMatchObject({ state: 'released' });
    vi.restoreAllMocks();
    await expect(work.reconcileParticipantWork(await assertion(saved, {
      decisionId: signed.decisionId, approvalRef: 'telegram:different-approval',
    }))).rejects.toMatchObject({ code: 'RESOURCE_WORK_CONFLICT' });
  });
  it('uses the same exact reconciliation boundary for dashboard unknown work', async () => {
    vi.stubEnv('RESOURCE_PARTICIPANT_RECONCILIATION_SECRET', reconciliationKey);
    const saved = await work.dashboardParticipantWork.reserve({ host, workId: randomUUID(), ownerId: randomUUID(), kind: 'hermes-http',
      operationSha256: 'd'.repeat(64), deadline: Date.now() + 600_000 });
    await work.dashboardParticipantWork.start(saved.workId, saved);
    await work.dashboardParticipantWork.finish(saved.workId, { ownerId: saved.ownerId,
      disposition: 'remote-ended', evidenceSha256: 'a'.repeat(64) });
    const signed = await assertion(saved, { disposition: 'no_effect_verified' });
    await expect(work.reconcileParticipantWork(signed)).resolves.toMatchObject({ participant: 'dashboard', state: 'released' });
    expect(await db.resourceParticipantWork.findUniqueOrThrow({ where: { workId: saved.workId } })).toMatchObject({
      settlement: 'signed-reconciliation:no_effect_verified', reconciliationDecisionId: signed.decisionId,
    });
  });
  it('quarantines only the exact legacy dashboard row with fresh signed evidence while retaining its unknown outcome', async () => {
    vi.stubEnv('RESOURCE_PARTICIPANT_RECONCILIATION_SECRET', reconciliationKey);
    const workId = randomUUID(); const ownerId = randomUUID();
    await db.resourceParticipantWork.create({ data: { workId, ownerId, nodeId, participant: 'dashboard', kind: 'hermes-http',
      epoch: 0, barrierId: null, state: 'unknown', startedAt: new Date(Date.now() - 60_000),
      settlement: 'descendants-unverified' } });
    const { record, recordSha256 } = await work.inspectHistoricalParticipantWork(workId);
    expect(record).toMatchObject({ state: 'unknown', nodeFqdn: null, requestSha256: null, settlement: 'descendants-unverified' });
    const schema = await import('../schemas/resource-participant-reconciliation.js');
    const unsigned = schema.historicalParticipantWorkReconciliationSchema.omit({ signature: true }).parse({
      version: 2, workId, nodeId, participant: 'dashboard', kind: 'hermes-http', recordSha256,
      dashboardObservationSha256: 'a'.repeat(64), nodeObservationSha256: 'b'.repeat(64),
      operationAuditSha256: 'c'.repeat(64), observedAt: Date.now(),
      disposition: 'historical_descendants_absent_outcome_unknown', approvalRef: 'fixture:reviewed',
      decisionId: `historical-${randomUUID()}`, expiresAt: Date.now() + 60_000,
    });
    const signHistorical = (body: typeof unsigned) => ({ ...body, signature: createHmac('sha256', reconciliationKey)
      .update(schema.historicalParticipantWorkSigningPayload(body)).digest('hex') });
    await expect(work.reconcileHistoricalParticipantWork({ ...signHistorical(unsigned), recordSha256: 'd'.repeat(64) }))
      .rejects.toMatchObject({ status: 403 });
    await expect(work.reconcileHistoricalParticipantWork(signHistorical({ ...unsigned, recordSha256: 'd'.repeat(64) })))
      .rejects.toMatchObject({ code: 'RESOURCE_EVIDENCE_INVALID' });
    await expect(work.reconcileHistoricalParticipantWork(signHistorical({ ...unsigned, nodeObservationSha256: 'a'.repeat(64) })))
      .rejects.toMatchObject({ code: 'RESOURCE_EVIDENCE_INVALID' });
    const signed = signHistorical(unsigned);
    await expect(work.reconcileHistoricalParticipantWork(signed)).resolves.toMatchObject({ state: 'released' });
    await expect(work.reconcileHistoricalParticipantWork(signed)).resolves.toMatchObject({ state: 'released' });
    expect(await db.resourceParticipantWork.findUniqueOrThrow({ where: { workId } })).toMatchObject({
      settlement: 'signed-historical-quiescence:outcome-unknown', reconciliationDecisionId: unsigned.decisionId,
      reconciliationJson: JSON.stringify(signed), nodeFqdn: null, requestSha256: null,
    });
    await expect(work.reconcileHistoricalParticipantWork(signHistorical({ ...unsigned, decisionId: `other-${randomUUID()}` })))
      .rejects.toMatchObject({ code: 'RESOURCE_WORK_CONFLICT' });
  });
  it('binds reconciliation to the immutable reservation FQDN across inventory hostname drift', async () => {
    const reservation = { ...input(), host: '127.0.0.1' };
    const saved = await work.apiParticipantWork.reserve(reservation);
    const driftedFqdn = `drifted-${randomUUID()}.invalid`;
    await db.node.update({ where: { id: nodeId }, data: { hostname: driftedFqdn } });
    try {
      await expect(work.apiParticipantWork.reserve(reservation)).resolves.toMatchObject({
        workId: saved.workId, nodeFqdn: host, requestSha256: saved.requestSha256,
      });
      await expect(work.apiParticipantWork.start(saved.workId, saved))
        .resolves.toMatchObject({ state: 'running', nodeFqdn: host, requestSha256: saved.requestSha256 });
      await expect(work.apiParticipantWork.finish(saved.workId, {
        ownerId: saved.ownerId, disposition: 'remote-ended', evidenceSha256: 'a'.repeat(64),
      })).resolves.toMatchObject({ state: 'unknown', nodeFqdn: host });
      await expect(work.reconcileParticipantWork(await assertion(saved, { nodeFqdn: driftedFqdn })))
        .rejects.toMatchObject({ code: 'RESOURCE_EVIDENCE_INVALID' });
      await expect(work.reconcileParticipantWork(await assertion(saved)))
        .resolves.toMatchObject({ state: 'released', nodeFqdn: host });
      expect(await db.resourceParticipantWork.findUniqueOrThrow({ where: { workId: saved.workId } }))
        .toMatchObject({ nodeFqdn: host });
      await expect(db.resourceParticipantWork.update({ where: { workId: saved.workId }, data: { nodeFqdn: driftedFqdn } }))
        .rejects.toThrow(/reservation identity is immutable/);
    } finally {
      await db.node.update({ where: { id: nodeId }, data: { hostname: host } });
    }
  });
  it('keeps historical work without a reservation FQDN ineligible for reconciliation', async () => {
    const historical = { workId: randomUUID(), nodeId, nodeFqdn: host, participant: 'api' as const, ownerId: randomUUID(),
      kind: 'ssh-command' as const, epoch: 0, barrierId: null, operationSha256: 'c'.repeat(64), fence: '1',
      deadline: Date.now() + 600_000, requestSha256: 'a'.repeat(64), state: 'unknown' };
    await db.resourceParticipantWork.create({ data: { workId: historical.workId, nodeId, participant: historical.participant,
      ownerId: historical.ownerId, kind: historical.kind, epoch: historical.epoch, barrierId: historical.barrierId,
      state: historical.state, startedAt: new Date(), settlement: 'descendants-unverified' } });
    await expect(work.reconcileParticipantWork(await assertion(historical)))
      .rejects.toMatchObject({ code: 'RESOURCE_EVIDENCE_INVALID' });
    expect(await db.resourceParticipantWork.findUniqueOrThrow({ where: { workId: historical.workId } }))
      .toMatchObject({ state: 'unknown', nodeFqdn: null, requestSha256: null });
  });
  it('does not let the node-distributed command reconciliation key release participant work', async () => {
    const saved = await work.apiParticipantWork.reserve(input()); await work.apiParticipantWork.start(saved.workId, saved);
    await work.apiParticipantWork.finish(saved.workId, {
      ownerId: saved.ownerId, disposition: 'remote-ended', evidenceSha256: 'a'.repeat(64),
    });
    const signed = await assertion(saved);
    vi.stubEnv('RESOURCE_PARTICIPANT_RECONCILIATION_SECRET', '');
    vi.stubEnv('COMMAND_RECONCILIATION_SECRET', reconciliationKey);
    await expect(work.reconcileParticipantWork(signed)).rejects.toMatchObject({ code: 'RESOURCE_RECONCILIATION_UNAVAILABLE' });
    vi.stubEnv('RESOURCE_PARTICIPANT_RECONCILIATION_SECRET', reconciliationKey);
    await expect(work.reconcileParticipantWork(signed)).rejects.toMatchObject({ code: 'RESOURCE_RECONCILIATION_UNAVAILABLE' });
    expect(await db.resourceParticipantWork.findUniqueOrThrow({ where: { workId: saved.workId } })).toMatchObject({ state: 'unknown' });
  });
  it('rejects forged, retargeted, reserved, and reused participant reconciliation decisions', async () => {
    vi.stubEnv('RESOURCE_PARTICIPANT_RECONCILIATION_SECRET', reconciliationKey);
    const first = await work.apiParticipantWork.reserve(input());
    const reserved = await assertion(first);
    await expect(work.reconcileParticipantWork(reserved)).rejects.toMatchObject({ code: 'RESOURCE_WORK_CONFLICT' });
    await work.apiParticipantWork.start(first.workId, first); await work.apiParticipantWork.finish(first.workId, {
      ownerId: first.ownerId, disposition: 'unknown', evidenceSha256: 'a'.repeat(64) });
    await expect(work.reconcileParticipantWork({ ...await assertion(first), signature: '0'.repeat(64) }))
      .rejects.toMatchObject({ code: 'RESOURCE_EVIDENCE_INVALID' });
    await expect(work.reconcileParticipantWork(await assertion(first, { kind: 'agent-upgrade' })))
      .rejects.toMatchObject({ code: 'RESOURCE_EVIDENCE_INVALID' });
    const accepted = await assertion(first); await work.reconcileParticipantWork(accepted);

    const second = await work.apiParticipantWork.reserve(input()); await work.apiParticipantWork.start(second.workId, second);
    await work.apiParticipantWork.finish(second.workId, { ownerId: second.ownerId, disposition: 'unknown', evidenceSha256: 'b'.repeat(64) });
    await expect(work.reconcileParticipantWork(await assertion(second, { decisionId: accepted.decisionId })))
      .rejects.toMatchObject({ code: 'RESOURCE_WORK_CONFLICT' });
    expect(await db.resourceParticipantWork.findUniqueOrThrow({ where: { workId: second.workId } })).toMatchObject({ state: 'unknown' });
  });
  it('releases only never-started work and preserves its terminal receipt', async () => {
    const saved = await work.apiParticipantWork.reserve(input());
    await work.apiParticipantWork.finish(saved.workId, { ownerId: saved.ownerId, disposition: 'not-started', evidenceSha256: 'a'.repeat(64) });
    await work.apiParticipantWork.finish(saved.workId, { ownerId: saved.ownerId, disposition: 'unknown', evidenceSha256: 'b'.repeat(64) });
    expect(await db.resourceParticipantWork.findUnique({ where: { workId: saved.workId } })).toMatchObject({ state: 'released', evidenceSha256: 'a'.repeat(64) });
  });
  it('keeps preinstrumentation, bootstrap and local self-update blockers despite a zero snapshot', async () => {
    const status = await enrollment.inspectEnrollment(nodeId);
    expect(status.api).toMatchObject({ activeCount: 0, unknownCount: 0 });
    expect(status.apiBlockers).toContain('preinstrumentation-work-unverified'); expect(status.apiBlockers).toContain('local-descendants-unverified');
    expect(status.unsupportedParticipants).toEqual([]);
  });
  it('limits unidentified legacy bootstrap to explicit installs and never fabricates a node owner', async () => {
    const unknown = `${randomUUID()}.invalid`; const effect = vi.fn(async () => 'bootstrap');
    await expect(admission.withApiSshOwnership(unknown, 'ssh-command', effect)).rejects.toMatchObject({ code: 'RESOURCE_TARGET_INVALID' });
    expect(await admission.withApiSshOwnership(unknown, 'agent-deploy', effect)).toBe('bootstrap');
    expect(await db.resourceParticipantWork.count({ where: { nodeId } })).toBe(0);
    await enrollment.beginEnrollmentDrain(nodeId, 'fixture');
    await expect(admission.withApiSshOwnership(unknown, 'control-deploy', effect)).rejects.toMatchObject({ code: 'MANAGED_SSH_UNAVAILABLE' });
    expect(effect).toHaveBeenCalledTimes(1);
  });
  it('blocks a first API session while the global gate is enabled', async () => {
    vi.stubEnv('MAGNUS_RESOURCE_LEASES_ENABLED', 'true'); const effect = vi.fn();
    await expect(admission.withApiSshOwnership(host, 'ssh-command', effect)).rejects.toMatchObject({ code: 'RESOURCE_DRAIN_REQUIRED' }); expect(effect).not.toHaveBeenCalled();
  });
  it('survives a separate process dying after committed start without TTL or replay recovery', async () => {
    const reserved = await work.apiParticipantWork.reserve(input());
    const url = new URL('./resource-participant-work.ts', import.meta.url).href;
    const program = `import { apiParticipantWork } from ${JSON.stringify(url)}; await apiParticipantWork.start(${JSON.stringify(reserved.workId)},${JSON.stringify(reserved)}); process.stdout.write('STARTED\\n'); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), env: { ...process.env, DATABASE_URL: process.env['TEST_DATABASE_URL']!, MAGNUS_RESOURCE_LEASES_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    child.stderr.resume(); const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already closed */ } } };
    try {
      await new Promise<void>((resolve, reject) => { let output = ''; const timer = setTimeout(() => reject(new Error('Bounded child start deadline')), 15_000);
        child.stdout.on('data', data => { output += String(data); if (output.length > 1024) { clearTimeout(timer); reject(new Error('Unexpected child output')); }
          if (output.includes('STARTED\n')) { clearTimeout(timer); resolve(); } });
        child.once('error', () => { clearTimeout(timer); reject(new Error('Child startup failed')); });
        child.once('close', () => { clearTimeout(timer); if (!output.includes('STARTED\n')) reject(new Error('Child ended before start proof')); }); });
      kill(); await closed;
      expect(await db.resourceParticipantWork.findUnique({ where: { workId: reserved.workId } })).toMatchObject({ state: 'running', ownerId: reserved.ownerId });
      await expect(work.apiParticipantWork.start(reserved.workId, reserved)).rejects.toMatchObject({ code: 'RESOURCE_WORK_CONFLICT' });
      await enrollment.beginEnrollmentDrain(nodeId, 'fixture'); expect((await enrollment.inspectEnrollment(nodeId)).api.activeCount).toBe(1);
    } finally { kill(); await closed; }
  }, 30_000);
  it('uses real SSH transport only after persisted ownership and retains successful shell descendants', async () => {
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
    let connectionCount = 0; let observedRunning = false;
    const clients = new Set<{ end(): void }>();
    const server = new Server({ hostKeys: [key] }, client => {
      clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', () => undefined);
      client.on('authentication', context => { void (async () => {
        connectionCount++; observedRunning = (await db.resourceParticipantWork.count({ where: { nodeId, participant: 'api', state: 'running' } })) === 1; context.accept();
      })(); });
      client.on('ready', () => client.on('session', accept => accept().on('exec', acceptExec => { const stream = acceptExec(); stream.write('fixture'); stream.exit(0); stream.end(); })));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const { runRemoteCommand } = await import('./ssh-exec-service.js');
      const target = { hostname: '127.0.0.1', port: server.address().port, username: 'fixture' };
      expect((await runRemoteCommand(target, 'fixture', { readyTimeoutMs: 2000 })).code).toBe(0);
      expect(observedRunning).toBe(true); expect(connectionCount).toBe(1);
      await enrollment.beginEnrollmentDrain(nodeId, 'fixture');
      await expect(runRemoteCommand(target, 'must-never-run')).rejects.toMatchObject({ code: 'RESOURCE_DRAIN_REQUIRED' });
      expect(connectionCount).toBe(1); expect((await enrollment.inspectEnrollment(nodeId)).api.unknownCount).toBe(1);
    } finally { for (const client of clients) client.end(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
