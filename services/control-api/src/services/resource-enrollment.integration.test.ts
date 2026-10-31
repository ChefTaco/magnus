import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../middleware/error-handler.js';
import { commandRequestDigest } from '../security/command-request.js';
import { httpIdentity } from '../security/managed-http.js';
const nodeKey = 'enrollment-node-fixture-at-least-32-characters';
const resultKey = 'enrollment-result-fixture-at-least-32-characters';
const dashboardKey = 'enrollment-dashboard-fixture-at-least-32-characters';
const reconciliationKey = 'enrollment-api-review-fixture-at-least-32-characters';
vi.mock('../utils/env.js', async original => ({ ...await original<object>(),
  NODE_MANAGER_SECRET: 'enrollment-node-fixture-at-least-32-characters', RESULT_SIGNING_SECRET: 'enrollment-result-fixture-at-least-32-characters',
  getNodeManagerSecret: () => 'enrollment-node-fixture-at-least-32-characters' }));
const nodeId = `enroll-${randomUUID()}`; const nodeFqdn = `${nodeId}.invalid`;
describe.skipIf(!process.env['TEST_DATABASE_URL'])('durable enrollment and participant work (PostgreSQL)', () => {
  let db: ReturnType<typeof import('../db/index.js')['getDb']>;
  let service: typeof import('./resource-enrollment.js');
  let leases: typeof import('./command-resource-leases.js');
  let app: Hono;
  let temporary: string;
  const context = { nodeId, actorId: 'fixture', baseUrl: 'https://127.0.0.1:39092' };
  const work = () => ({ host: nodeFqdn, workId: randomUUID(), ownerId: randomUUID(), kind: 'terminal-http' as const,
    operationSha256: 'd'.repeat(64), deadline: Date.now() + 600_000 });
  const command = () => ({ commandId: `cmd-${randomUUID()}`, command: '/usr/bin/true', args: [], timeoutSeconds: 5 });
  const post = (path: string, body: unknown, key = dashboardKey, header = 'x-resource-drain-key') => app.request('/resource-leases' + path,
    { method: 'POST', headers: { 'content-type': 'application/json', [header]: key }, body: JSON.stringify(body) });
  const sign = (value: object, key = resultKey) => ({ ...value, signature: createHmac('sha256', key).update(service.enrollmentSigningPayload(value)).digest('hex') });
  function agentResponder(change?: (v: Record<string, unknown>) => void) {
    return vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(context.baseUrl + '/api/v1/commands/enrollment-drain'); expect(init.redirect).toBe('error');
      expect(init.headers).toMatchObject({ 'x-node-token': nodeKey });
      const descriptor = JSON.parse(String(init.body)) as Record<string, unknown>;
      const status = await service.nodeEnrollmentStatus(nodeFqdn, randomUUID());
      expect(status).toMatchObject({ state: 'draining', epoch: descriptor.epoch,
        agentChallenge: { challengeId: descriptor.challengeId, expiresAt: descriptor.expiresAt } });
      const value = { ...descriptor, status: 'drained', activeCount: 0, unknownCount: 0, evidenceSha256: 'a'.repeat(64) };
      change?.(value); return new Response(JSON.stringify(sign(value)));
    });
  }
  beforeAll(async () => {
    const url = process.env['TEST_DATABASE_URL']!;
    if (!new URL(url).pathname.startsWith('/magnus_ideas')) throw new Error('Disposable fixture database required');
    vi.stubEnv('DATABASE_URL', url); vi.stubEnv('TLS_CERT_PATH', 'fixture'); vi.stubEnv('TLS_KEY_PATH', 'fixture');
    temporary = await mkdtemp(join(tmpdir(), 'magnus-enrollment-test-'));
    vi.stubEnv('CREDENTIAL_ROTATION_STATE_PATH', join(temporary, 'rotation.json'));
    vi.stubEnv('CREDENTIAL_ROTATION_KEY', 'enrollment-rotation-fixture-at-least-32-characters');
    vi.stubEnv('RESOURCE_ENROLLMENT_DASHBOARD_SECRET', dashboardKey); vi.stubEnv('DASHBOARD_PUBLIC_ORIGIN', 'https://dashboard.invalid');
    service = await import('./resource-enrollment.js'); leases = await import('./command-resource-leases.js');
    db = (await import('../db/index.js')).getDb();
    app = new Hono().onError(errorHandler).route('/resource-leases', (await import('../routes/resource-leases.js')).resourceLeasesRouter);
    await db.node.create({ data: { id: nodeId, name: nodeId, hostname: nodeFqdn, ipAddress: '127.0.0.1', port: 39092,
      os: 'fixture', arch: 'fixture', token: randomUUID(), status: 'ONLINE', lastHeartbeatAt: new Date() } });
  });
  beforeEach(() => { vi.stubEnv('MAGNUS_RESOURCE_LEASES_ENABLED', 'false');
    vi.stubEnv('RESOURCE_PARTICIPANT_RECONCILIATION_SECRET', reconciliationKey);
    vi.stubEnv('TLS_CERT_PATH', 'fixture'); vi.stubEnv('TLS_KEY_PATH', 'fixture'); });
  afterEach(async () => {
    vi.unstubAllGlobals(); vi.restoreAllMocks();
    await db.resourceDrainParticipant.deleteMany({ where: { nodeId } });
    await db.resourceParticipantWork.deleteMany({ where: { nodeId } });
    await db.commandResourceLease.deleteMany({ where: { nodeId } });
    await db.remoteCommand.deleteMany({ where: { nodeId } });
    await db.ardentScopeEnrollment.deleteMany({ where: { nodeId } });
    await db.resourceEnrollment.deleteMany({ where: { nodeId } });
  });
  afterAll(async () => {
    if (db) { await db.commandResourceFence.deleteMany({ where: { resourceKey: { in: [`node:${nodeId}`, `node:${nodeId}:ardent`, `participant:dashboard:${nodeId}`, `participant:api:${nodeId}`] } } });
      await db.node.delete({ where: { id: nodeId } }); await (await import('../db/index.js')).disconnectDb(); }
    if (temporary) await rm(temporary, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  it('requires node authentication and preserves exact legacy response fields', async () => {
    const request = { nodeFqdn, nonce: randomUUID() };
    expect((await post('/enrollment/node-status', request, '', 'x-node-token')).status).toBe(401);
    const response = await post('/enrollment/node-status', request, nodeKey, 'x-node-token');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).data).toEqual({ ...request, version: 1, nodeId, state: 'legacy', epoch: 0, barrierId: null, agentChallenge: null });
    await service.beginEnrollmentDrain(nodeId, 'fixture');
    const legacy = await post('/legacy-admission', request, nodeKey, 'x-node-token');
    expect((await legacy.json()).data).toEqual({ ...request, nodeId, enrolled: true, gateEnabled: false, allowedLegacy: false });
  });
  it('authenticates scheduler status independently and never accepts caller-created challenges', async () => {
    const request = { nodeFqdn, nonce: randomUUID() };
    expect((await post('/enrollment/scheduler-status', request, '', 'x-node-token')).status).toBe(401);
    const response = await post('/enrollment/scheduler-status', request, nodeKey, 'x-node-token');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).data).toEqual({ ...request, version: 1, nodeId, state: 'legacy', epoch: 0, barrierId: null, schedulerChallenge: null });
    expect((await post('/enrollment/scheduler-status', { ...request, schedulerChallenge: { challengeId: randomUUID() } }, nodeKey, 'x-node-token')).status).toBe(400);
  });
  it('orders concurrent begin calls into one durable epoch and never cancels back to legacy', async () => {
    const rows = await Promise.all(Array.from({ length: 12 }, () => service.beginEnrollmentDrain(nodeId, 'fixture')));
    expect(new Set(rows.map(r => r.barrierId)).size).toBe(1); expect(rows.every(r => r.epoch === 1)).toBe(true);
    expect((await service.inspectEnrollment(nodeId)).state).toBe('draining');
  });
  it('global enable and sticky history cannot mint first owners without verified enrollment', async () => {
    expect(await leases.admitResourceCommand(context, command())).toBeNull();
    vi.stubEnv('MAGNUS_RESOURCE_LEASES_ENABLED', 'true');
    await expect(leases.admitResourceCommand(context, command())).rejects.toMatchObject({ code: 'RESOURCE_ENROLLMENT_REQUIRED' });
    await service.beginEnrollmentDrain(nodeId, 'fixture'); vi.stubEnv('MAGNUS_RESOURCE_LEASES_ENABLED', 'false');
    await expect(leases.admitResourceCommand(context, command())).rejects.toMatchObject({ code: 'RESOURCE_ENROLLMENT_REQUIRED' });
    expect(await db.commandResourceLease.count({ where: { nodeId } })).toBe(0);
  });
  it('reserves before connection and gives one execution grant even under concurrent start callers', async () => {
    const input = work(); const reserved = await service.reserveDashboardWork(input);
    expect(reserved).toEqual({ workId: input.workId, ownerId: input.ownerId, kind: input.kind, participant: 'dashboard',
      nodeId, nodeFqdn, state: 'reserved', epoch: 0, barrierId: null, requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      operationSha256: input.operationSha256, fence: expect.stringMatching(/^[1-9][0-9]*$/), deadline: input.deadline });
    expect(await service.reserveDashboardWork(input)).toEqual(reserved);
    await expect(service.reserveDashboardWork({ ...input, ownerId: randomUUID() })).rejects.toMatchObject({ code: 'RESOURCE_WORK_CONFLICT' });
  });
  it('commits not-dispatched release if drain starts after reserve but before start', async () => {
    const input = work(); const row = await service.reserveDashboardWork(input);
    await service.beginEnrollmentDrain(nodeId, 'fixture');
    await expect(service.startDashboardWork(input.workId, row)).rejects.toMatchObject({ code: 'RESOURCE_DRAIN_REQUIRED' });
    expect(await db.resourceParticipantWork.findUnique({ where: { workId: input.workId } })).toMatchObject({ state: 'released', settlement: 'barrier-before-dispatch' });
    await expect(service.reserveDashboardWork(work())).rejects.toMatchObject({ code: 'RESOURCE_DRAIN_REQUIRED' });
  });
  it('keeps running and disconnected descendant uncertainty durable across client loss', async () => {
    const input = work(); const row = await service.reserveDashboardWork(input);
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => service.startDashboardWork(input.workId, row)));
    expect(attempts.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await service.finishDashboardWork(input.workId, { ownerId: input.ownerId, disposition: 'remote-ended', evidenceSha256: 'b'.repeat(64) })).toMatchObject({ state: 'unknown' });
    expect(await service.finishDashboardWork(input.workId, { ownerId: input.ownerId, disposition: 'not-started', evidenceSha256: 'c'.repeat(64) })).toMatchObject({ state: 'unknown' });
    await service.beginEnrollmentDrain(nodeId, 'fixture');
    const status = await service.enrollmentStatus(nodeId, randomUUID(), 'dashboard');
    expect(status).toMatchObject({ activeCount: 0, unknownCount: 1 });
    await expect(service.completeEnrollment(nodeId)).rejects.toMatchObject({ code: 'RESOURCE_DRAIN_INCOMPLETE' });
  });
  it('only releases reserved not-started work; released evidence remains immutable', async () => {
    const input = work(); await service.reserveDashboardWork(input);
    await service.finishDashboardWork(input.workId, { ownerId: input.ownerId, disposition: 'not-started', evidenceSha256: 'b'.repeat(64) });
    await service.finishDashboardWork(input.workId, { ownerId: input.ownerId, disposition: 'unknown', evidenceSha256: 'c'.repeat(64) });
    expect(await db.resourceParticipantWork.findUnique({ where: { workId: input.workId } })).toMatchObject({ state: 'released', evidenceSha256: 'b'.repeat(64) });
  });
  it('requires dedicated dashboard credentials, rejects caller supplied proof/counts', async () => {
    expect((await post('/enrollment/dashboard/work/reserve', work(), nodeKey)).status).toBe(401);
    expect((await post('/enrollment/dashboard/work/reserve', { ...work(), activeCount: 0 })).status).toBe(400);
    expect((await post('/enrollment/dashboard/status', { nodeId, nonce: randomUUID(), unknownCount: 0 })).status).toBe(400);
    expect((await post('/enrollment/dashboard/work/reserve', work())).status).toBe(200);
    expect((await post(`/enrollment/${nodeId}/begin`, {})).status).toBe(401);
  });
  it('accepts only fixed node-pulled signed current challenge evidence', async () => {
    await service.beginEnrollmentDrain(nodeId, 'fixture'); const fetch = agentResponder(); vi.stubGlobal('fetch', fetch);
    expect(await service.refreshEnrollmentParticipant(nodeId, 'agent')).toMatchObject({ status: 'verified' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await service.inspectEnrollment(nodeId)).participants[0]).toMatchObject({ participant: 'agent', status: 'verified' });
    await expect(service.completeEnrollment(nodeId)).rejects.toMatchObject({ code: 'RESOURCE_DRAIN_INCOMPLETE' });
  });
  it.each(['epoch', 'nodeId', 'challengeId', 'signature', 'envelope', 'extra'])('rejects %s drift rather than trusting a signed declaration', async field => {
    await service.beginEnrollmentDrain(nodeId, 'fixture');
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const value = { ...JSON.parse(init.body), status: 'drained', activeCount: 0, unknownCount: 0, evidenceSha256: 'a'.repeat(64) };
      if (field === 'epoch') value.epoch += 1;
      if (field === 'nodeId') value.nodeId = 'other';
      if (field === 'challengeId') value.challengeId = randomUUID();
      if (field === 'extra') value.extra = true;
      let signed: unknown = sign(value, field === 'signature' ? dashboardKey : resultKey);
      if (field === 'envelope') signed = { success: true, data: signed };
      return new Response(JSON.stringify(signed));
    }));
    expect(await service.refreshEnrollmentParticipant(nodeId, 'agent')).toMatchObject({ status: 'pending' });
  });
  it('does not treat signed nonzero counts as a drained participant', async () => {
    await service.beginEnrollmentDrain(nodeId, 'fixture'); vi.stubGlobal('fetch', agentResponder(v => { v.activeCount = 1; }));
    expect(await service.refreshEnrollmentParticipant(nodeId, 'agent')).toMatchObject({ status: 'pending', reason: 'unsettled-work' });
  });
  it('dashboard receipt binds independently queried authoritative counts and canonical signing', async () => {
    await service.beginEnrollmentDrain(nodeId, 'fixture');
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      expect(url).toBe('https://dashboard.invalid/api/internal/resource-enrollment/drain');
      const descriptor = JSON.parse(init.body); const snapshot = await service.enrollmentStatus(nodeId, randomUUID(), 'dashboard');
      const value = { ...descriptor, status: 'drained', activeCount: 0, unknownCount: 0, evidenceSha256: snapshot.evidenceSha256 };
      return new Response(JSON.stringify(sign(value, dashboardKey)));
    }));
    expect(await service.refreshEnrollmentParticipant(nodeId, 'dashboard')).toMatchObject({ status: 'verified' });
    await expect(service.completeEnrollment(nodeId)).rejects.toMatchObject({ code: 'RESOURCE_DRAIN_INCOMPLETE' });
  });
  it('rejects zero-count dashboard claims contradicted by central durable work', async () => {
    const input = work(); await service.reserveDashboardWork(input); await service.beginEnrollmentDrain(nodeId, 'fixture');
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => new Response(JSON.stringify(sign({ ...JSON.parse(init.body),
      status: 'drained', activeCount: 0, unknownCount: 0, evidenceSha256: 'a'.repeat(64) }, dashboardKey)))));
    expect(await service.refreshEnrollmentParticipant(nodeId, 'dashboard')).toMatchObject({ status: 'pending', reason: 'unsettled-work' });
  });
  it('rejects oversized provider receipts without unbounded buffering', async () => {
    await service.beginEnrollmentDrain(nodeId, 'fixture');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(16_385))));
    expect(await service.refreshEnrollmentParticipant(nodeId, 'agent')).toMatchObject({ status: 'pending' });
  });
  it('rejects equal-character-length Unicode credentials as 401, not an exception', () => {
    expect(() => service.verifyDashboardCredential('é'.repeat(dashboardKey.length))).toThrow(expect.objectContaining({ status: 401 }));
  });
  it('never sends an agent credential over an HTTP fallback endpoint', async () => {
    await service.beginEnrollmentDrain(nodeId, 'fixture'); vi.stubEnv('TLS_CERT_PATH', '');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(await service.refreshEnrollmentParticipant(nodeId, 'agent')).toMatchObject({ status: 'pending' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects previously valid receipts on a new challenge', async () => {
    await service.beginEnrollmentDrain(nodeId, 'fixture'); let old: object;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { old = sign({ ...JSON.parse(init.body), status: 'drained',
      activeCount: 0, unknownCount: 0, evidenceSha256: 'a'.repeat(64) }); return new Response(JSON.stringify(old)); }));
    expect(await service.refreshEnrollmentParticipant(nodeId, 'agent')).toMatchObject({ status: 'verified' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(old))));
    expect(await service.refreshEnrollmentParticipant(nodeId, 'agent')).toMatchObject({ status: 'pending' });
    expect((await service.inspectEnrollment(nodeId)).participants[0]?.status).toBe('pending');
  });
  it('rejects an expired signed challenge after bounded transport delay', async () => {
    await service.beginEnrollmentDrain(nodeId, 'fixture'); const original = Date.now.bind(Date);
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { const descriptor = JSON.parse(init.body);
      vi.spyOn(Date, 'now').mockImplementation(() => original() + 31_000);
      return new Response(JSON.stringify(sign({ ...descriptor, status: 'drained', activeCount: 0, unknownCount: 0, evidenceSha256: 'a'.repeat(64) }))); }));
    expect(await service.refreshEnrollmentParticipant(nodeId, 'agent')).toMatchObject({ status: 'pending' });
  });
  it('arbitrates a separate-process session start against the durable drain lock', async () => {
    const input = work(); const reserved = await service.reserveDashboardWork(input);
    const child = join(temporary, 'race.mts');
    await writeFile(child, `import { startDashboardWork, beginEnrollmentDrain } from ${JSON.stringify(fileURLToPath(new URL('./resource-enrollment.ts', import.meta.url)))};
import { disconnectDb } from ${JSON.stringify(fileURLToPath(new URL('../db/index.ts', import.meta.url)))};
try { const value = process.argv[2] === 'start' ? await startDashboardWork(process.argv[3], JSON.parse(process.argv[4])) : await beginEnrollmentDrain(process.argv[3], 'process-fixture'); console.log(JSON.stringify({ok:true,state:value.state})); } catch(error) { console.log(JSON.stringify({ok:false,code:error.code})); } finally { await disconnectDb(); }
`);
    const run = (mode: string, id: string, body: unknown) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const worker = spawn(process.execPath, ['--import', 'tsx', child, mode, id, JSON.stringify(body)], {
        cwd: process.cwd(), env: { ...process.env, DATABASE_URL: process.env['TEST_DATABASE_URL']! },
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
      let output = ''; worker.stdout.on('data', data => { output += String(data); });
      worker.on('error', reject); worker.on('exit', code => {
        if (code !== 0) return reject(new Error('Isolated drain race worker failed'));
        try { resolve(JSON.parse(output.trim())); } catch { reject(new Error('Invalid worker verdict')); }
      });
    });
    const [start, drain] = await Promise.all([run('start', input.workId, reserved), run('drain', nodeId, {})]);
    expect(drain).toMatchObject({ ok: true, state: 'draining' });
    const saved = await db.resourceParticipantWork.findUniqueOrThrow({ where: { workId: input.workId } });
    expect(saved.state).toBe(start.ok ? 'running' : 'released');
    await expect(service.reserveDashboardWork(work())).rejects.toMatchObject({ code: 'RESOURCE_DRAIN_REQUIRED' });
    if (start.ok) expect(await service.enrollmentStatus(nodeId, randomUUID(), 'dashboard')).toMatchObject({ activeCount: 1 });
  });
  it('checks dedicated deployment readiness without creating enrollment or work', async () => {
    expect((await post('/enrollment/dashboard/readiness', {}, nodeKey)).status).toBe(401);
    expect((await post('/enrollment/dashboard/readiness', { activeCount: 0 })).status).toBe(400);
    const response = await post('/enrollment/dashboard/readiness', {});
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ success: true, data: {
      version: 1, participant: 'dashboard', protocol: 'resource-enrollment-v1', ready: true } });
    expect(await db.resourceEnrollment.count({ where: { nodeId } })).toBe(0);
    expect(await db.resourceParticipantWork.count({ where: { nodeId } })).toBe(0);
    vi.stubEnv('RESOURCE_ENROLLMENT_DASHBOARD_SECRET', '');
    expect((await post('/enrollment/dashboard/readiness', {})).status).toBe(503);
    vi.stubEnv('RESOURCE_ENROLLMENT_DASHBOARD_SECRET', dashboardKey);
  });
  it('cannot activate unfinished API/scheduler integration through fixture-supplied zero acknowledgments', async () => {
    const drain = await service.beginEnrollmentDrain(nodeId, 'fixture');
    for (const participant of service.PARTICIPANTS) await db.resourceDrainParticipant.create({ data: { nodeId,
      participant, epoch: drain.epoch, barrierId: drain.barrierId!, challengeId: randomUUID(),
      challengeExpiresAt: new Date(Date.now() + 30_000), status: 'verified', verifiedAt: new Date(), evidenceSha256: 'a'.repeat(64) } });
    await expect(service.completeEnrollment(nodeId)).rejects.toMatchObject({ code: 'RESOURCE_DRAIN_INCOMPLETE' });
    expect((await service.inspectEnrollment(nodeId)).state).toBe('draining');
  });
  it('requires independent API and scheduler boundary reviews before one-way enrollment', async () => {
    const drain = await service.beginEnrollmentDrain(nodeId, 'fixture');
    const prepared = await service.refreshEnrollmentParticipant(nodeId, 'api');
    expect(prepared).toMatchObject({ participant: 'api', status: 'pending', reason: 'signed-reviewed-evidence-required' });
    const descriptor = (prepared as { descriptor: Record<string, unknown> }).descriptor;
    const hashes = { preinstrumentationSha256: 'a'.repeat(64), localDescendantsSha256: 'b'.repeat(64),
      sshDescendantsSha256: 'c'.repeat(64) };
    const evidenceSha256 = createHash('sha256').update(service.canonical({ nodeId, nodeFqdn, epoch: drain.epoch,
      barrierId: drain.barrierId, ...hashes })).digest('hex');
    const unsigned = { ...descriptor, status: 'drained' as const, activeCount: 0 as const, unknownCount: 0 as const,
      evidenceSha256, ...hashes, observedAt: Date.now(), approvalRef: 'fixture:reviewed' };
    const signed = { ...unsigned, signature: createHmac('sha256', reconciliationKey)
      .update(service.apiDrainAttestationSigningPayload(unsigned as Parameters<typeof service.apiDrainAttestationSigningPayload>[0])).digest('hex') };
    await expect(service.acceptApiDrainAttestation(nodeId, { ...signed, sshDescendantsSha256: 'd'.repeat(64) }))
      .rejects.toMatchObject({ status: 403 });
    expect(await service.acceptApiDrainAttestation(nodeId, signed)).toMatchObject({ status: 'verified' });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const current = JSON.parse(String(init.body));
      const participant = current.participant as 'agent' | 'dashboard' | 'scheduler';
      expect(url).toContain(participant === 'dashboard' ? '/api/internal/resource-enrollment/drain'
        : participant === 'agent' ? '/api/v1/commands/enrollment-drain' : '/api/v1/cron/enrollment-drain');
      const snapshot = participant === 'dashboard' ? await service.enrollmentStatus(nodeId, randomUUID(), 'dashboard') : null;
      const receipt = participant === 'scheduler'
        ? { ...current, scope: 'magnus-managed-scheduler-only', status: 'managed-drained', activeCount: 0, unknownCount: 0,
          externalBlockers: [{ identityVersion: 2, kind: 'SYSTEM_TIMER_DEFINITION', sourceSha256: 'f'.repeat(64), count: 1 }],
          evidenceSha256: 'e'.repeat(64) }
        : { ...current, status: 'drained', activeCount: 0, unknownCount: 0,
          evidenceSha256: snapshot?.evidenceSha256 ?? 'e'.repeat(64) };
      return new Response(JSON.stringify(sign(receipt, participant === 'dashboard' ? dashboardKey : resultKey)));
    }));
    for (const participant of ['agent', 'dashboard'] as const)
      expect(await service.refreshEnrollmentParticipant(nodeId, participant)).toMatchObject({ status: 'verified' });
    expect(await service.refreshEnrollmentParticipant(nodeId, 'scheduler')).toMatchObject({ status: 'pending', reason: 'reviewed-boundary-required' });
    await expect(service.completeEnrollment(nodeId)).rejects.toMatchObject({ code: 'RESOURCE_DRAIN_INCOMPLETE' });
    const schedulerAck = await db.resourceDrainParticipant.findUniqueOrThrow({ where: { nodeId_participant: { nodeId, participant: 'scheduler' } } });
    const schedulerReceipt = JSON.parse(schedulerAck.receiptJson!);
    const boundary = { version: 1 as const, scope: 'magnus-managed-scheduler-only' as const, nodeId, nodeFqdn,
      epoch: drain.epoch, barrierId: drain.barrierId!, challengeId: schedulerAck.challengeId,
      receiptSha256: createHash('sha256').update(schedulerAck.receiptJson!).digest('hex'),
      externalBlockersSha256: createHash('sha256').update(service.canonical(schedulerReceipt.externalBlockers)).digest('hex'),
      reviewSha256: 'f'.repeat(64), observedAt: Date.now(), approvalRef: 'fixture:external-scheduler-review' };
    const signedBoundary = { ...boundary, signature: createHmac('sha256', reconciliationKey)
      .update(service.schedulerBoundaryAttestationSigningPayload(boundary)).digest('hex') };
    await expect(service.acceptSchedulerBoundaryAttestation(nodeId, { ...signedBoundary, reviewSha256: 'e'.repeat(64) }))
      .rejects.toMatchObject({ status: 403 });
    expect(await service.acceptSchedulerBoundaryAttestation(nodeId, signedBoundary)).toMatchObject({ status: 'verified' });
    expect(await service.completeEnrollment(nodeId)).toMatchObject({ state: 'enrolled', epoch: drain.epoch });
    expect((await service.inspectEnrollment(nodeId)).apiBlockers).toEqual([]);
  });
  it('rejects a reviewed boundary that relabels an unrecognized source', async () => {
    await service.beginEnrollmentDrain(nodeId, 'fixture');
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const descriptor = JSON.parse(String(init.body));
      return new Response(JSON.stringify(sign({ ...descriptor, scope: 'magnus-managed-scheduler-only', status: 'managed-drained',
        activeCount: 0, unknownCount: 0, evidenceSha256: 'a'.repeat(64),
        externalBlockers: [{ identityVersion: 2, kind: 'LEGACY_SCHEDULER_IDENTITY_UNRECONCILABLE', sourceSha256: 'b'.repeat(64), count: 1 }] })));
    }));
    expect(await service.refreshEnrollmentParticipant(nodeId, 'scheduler')).toMatchObject({ status: 'pending' });
    const ack = await db.resourceDrainParticipant.findUniqueOrThrow({ where: { nodeId_participant: { nodeId, participant: 'scheduler' } } });
    const receipt = JSON.parse(ack.receiptJson!);
    const review = { version: 1 as const, scope: 'magnus-managed-scheduler-only' as const, nodeId, nodeFqdn,
      epoch: ack.epoch, barrierId: ack.barrierId, challengeId: ack.challengeId,
      receiptSha256: createHash('sha256').update(ack.receiptJson!).digest('hex'),
      externalBlockersSha256: createHash('sha256').update(service.canonical(receipt.externalBlockers)).digest('hex'),
      reviewSha256: 'c'.repeat(64), observedAt: Date.now(), approvalRef: 'fixture:bad-boundary' };
    await expect(service.acceptSchedulerBoundaryAttestation(nodeId, { ...review, signature: createHmac('sha256', reconciliationKey)
      .update(service.schedulerBoundaryAttestationSigningPayload(review)).digest('hex') }))
      .rejects.toMatchObject({ code: 'SCHEDULER_BOUNDARY_EVIDENCE_INVALID' });
  });
  it('admits only a signed Ardent action while the scheduler and whole node remain draining', async () => {
    const scoped = await import('./ardent-scope-enrollment.js');
    const drain = await service.beginEnrollmentDrain(nodeId, 'fixture');
    const prepared = await service.refreshEnrollmentParticipant(nodeId, 'api');
    const descriptor = (prepared as { descriptor: Record<string, unknown> }).descriptor;
    const hashes = { preinstrumentationSha256: 'a'.repeat(64), localDescendantsSha256: 'b'.repeat(64),
      sshDescendantsSha256: 'c'.repeat(64) };
    const evidenceSha256 = createHash('sha256').update(service.canonical({ nodeId, nodeFqdn, epoch: drain.epoch,
      barrierId: drain.barrierId, ...hashes })).digest('hex');
    const api = { ...descriptor, status: 'drained' as const, activeCount: 0 as const, unknownCount: 0 as const,
      evidenceSha256, ...hashes, observedAt: Date.now(), approvalRef: 'fixture:reviewed' };
    await service.acceptApiDrainAttestation(nodeId, { ...api, signature: createHmac('sha256', reconciliationKey)
      .update(service.apiDrainAttestationSigningPayload(api as Parameters<typeof service.apiDrainAttestationSigningPayload>[0])).digest('hex') });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const current = JSON.parse(String(init.body));
      const snapshot = current.participant === 'dashboard' ? await service.enrollmentStatus(nodeId, randomUUID(), 'dashboard') : null;
      const receipt = { ...current, status: 'drained', activeCount: 0, unknownCount: 0,
        evidenceSha256: snapshot?.evidenceSha256 ?? 'd'.repeat(64) };
      return new Response(JSON.stringify(sign(receipt, current.participant === 'dashboard' ? dashboardKey : resultKey)));
    }));
    for (const participant of ['agent', 'dashboard'] as const)
      expect(await service.refreshEnrollmentParticipant(nodeId, participant)).toMatchObject({ status: 'verified' });
    const status = await scoped.inspectArdentScope(nodeId);
    const rows = await db.resourceDrainParticipant.findMany({ where: { nodeId } });
    const receiptSha256 = Object.fromEntries(['agent', 'api', 'dashboard'].map(participant => {
      const row = rows.find(item => item.participant === participant)!;
      return [participant, createHash('sha256').update(row.receiptJson!).digest('hex')];
    })) as { agent: string; api: string; dashboard: string };
    const assertion = { version: 1 as const, scope: 'managed-ardent-actions-only' as const,
      excludedParticipant: 'scheduler' as const, nodeId, nodeFqdn, epoch: drain.epoch,
      barrierId: drain.barrierId!, decisionId: randomUUID(), approvalRef: 'fixture:operator',
      reviewSha256: 'f'.repeat(64), schedulerSnapshotSha256: status.schedulerSnapshotSha256,
      receiptSha256, expiresAt: Date.now() + 60_000 };
    const signed = { ...assertion, signature: createHmac('sha256', reconciliationKey)
      .update(scoped.ardentScopeSigningPayload(assertion)).digest('hex') };
    await expect(scoped.activateArdentScope(nodeId, { ...signed, reviewSha256: 'e'.repeat(64) }))
      .rejects.toMatchObject({ code: 'ARDENT_SCOPE_EVIDENCE_INVALID' });
    expect(await scoped.activateArdentScope(nodeId, signed)).toMatchObject({ state: 'active' });
    expect((await service.inspectEnrollment(nodeId)).state).toBe('draining');
    await expect(leases.admitResourceCommand(context, command())).rejects.toMatchObject({ code: 'RESOURCE_ENROLLMENT_REQUIRED' });
    await expect(leases.admitResourceCommand({ ...context, scope: 'ardent-managed-http' }, command()))
      .rejects.toMatchObject({ code: 'RESOURCE_SCOPE_INVALID' });
    const action = httpIdentity(`ardent-${randomUUID()}`, 'POST', '/ardent/action', '{}', 10);
    const admitted = await leases.admitResourceCommand({ ...context, scope: 'ardent-managed-http' }, action);
    expect(admitted?.payload.coordination?.resourceKey).toBe(`node:${nodeId}:ardent`);
    await leases.markResourceDispatched(admitted!);
    const claim = { leaseId: admitted!.leaseId, nodeId, nodeFqdn, commandId: action.commandId,
      requestSha256: commandRequestDigest(admitted!.payload), coordination: admitted!.payload.coordination };
    expect((await post('/claim', claim, nodeKey, 'x-node-token')).status).toBe(200);
  });
  it.each([false, true])('verifies actual dashboard runtime signatures and durable work contract (unsettled=%s)', async unsettled => {
    const { createResourceParticipant } = await import('../../../../apps/dashboard/runtime-resource-participant.mjs');
    const participant = createResourceParticipant({ env: { RESOURCE_ENROLLMENT_DASHBOARD_SECRET: dashboardKey },
      request: async (path, body) => {
        const response = await post('/enrollment/dashboard' + path, body);
        if (response.status !== 200) throw new Error('Fixture participant authority denied');
        return (await response.json()).data;
      } });
    if (unsettled) {
      const handle = await participant.begin(nodeFqdn, 'hermes-ws');
      await handle.finish('remote-ended');
      expect(await db.resourceParticipantWork.findUnique({ where: { workId: handle.workId } })).toMatchObject({ state: 'unknown' });
    }
    await service.beginEnrollmentDrain(nodeId, 'fixture');
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => new Response(JSON.stringify(
      await participant.drain(JSON.parse(init.body), dashboardKey)))));
    expect(await service.refreshEnrollmentParticipant(nodeId, 'dashboard')).toMatchObject({ status: unsettled ? 'pending' : 'verified' });
  });
  it('prevents deleting inventory while durable enrollment or participant work remains', async () => {
    await service.beginEnrollmentDrain(nodeId, 'fixture');
    await expect(db.node.delete({ where: { id: nodeId } })).rejects.toMatchObject({ code: 'P2003' });
  });
});
