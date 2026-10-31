import { randomUUID, createHmac } from 'node:crypto';
import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const probe = vi.hoisted(() => ({ host: '', available: true }));
vi.mock('./control-host-node.js', () => ({ probeLocalAgent: async () => probe.available ? { verifiedTlsHostname: probe.host } : null }));
const nodeKey = 'local-drain-node-fixture-at-least-32-characters';
const resultKey = 'local-drain-result-fixture-at-least-32-characters';
vi.mock('../utils/env.js', async original => ({ ...await original<object>(), NODE_MANAGER_SECRET: 'local-drain-node-fixture-at-least-32-characters',
  RESULT_SIGNING_SECRET: 'local-drain-result-fixture-at-least-32-characters', getNodeManagerSecret: () => 'local-drain-node-fixture-at-least-32-characters' }));
const id = 'local-' + randomUUID(); const host = id + '.invalid';
describe.skipIf(!process.env['TEST_DATABASE_URL'])('local API maintenance and scheduler drain authority (PostgreSQL)', () => {
  let db: ReturnType<typeof import('../db/index.js')['getDb']>;
  let local: typeof import('./api-local-work.js'); let enrollment: typeof import('./resource-enrollment.js');
  beforeAll(async () => {
    const url = process.env['TEST_DATABASE_URL']!; if (!new URL(url).pathname.startsWith('/magnus_ideas')) throw new Error('Disposable fixture required');
    vi.stubEnv('DATABASE_URL', url); vi.stubEnv('TLS_CERT_PATH', 'fixture'); vi.stubEnv('TLS_KEY_PATH', 'fixture');
    db = (await import('../db/index.js')).getDb(); local = await import('./api-local-work.js'); enrollment = await import('./resource-enrollment.js');
    await db.node.create({ data: { id, name: id, hostname: host, ipAddress: '127.0.0.1', port: 39093,
      os: 'fixture', arch: 'fixture', token: randomUUID(), status: 'ONLINE', lastHeartbeatAt: new Date() } });
  });
  beforeEach(() => { probe.host = host; probe.available = true; vi.stubEnv('MAGNUS_RESOURCE_LEASES_ENABLED', 'false'); });
  afterEach(async () => {
    vi.unstubAllGlobals(); vi.restoreAllMocks();
    await db.managedCronOccurrence.deleteMany({ where: { nodeId: id } });
    await db.resourceParticipantWork.deleteMany({ where: { nodeId: id } });
    await db.resourceDrainParticipant.deleteMany({ where: { nodeId: id } }); await db.resourceEnrollment.deleteMany({ where: { nodeId: id } });
  });
  afterAll(async () => { if (db) { await db.node.delete({ where: { id } }); await (await import('../db/index.js')).disconnectDb(); } vi.unstubAllEnvs(); });
  it('requires verified local TLS inventory identity before creating an owner', async () => {
    probe.available = false; await expect(local.reserveApiLocalWork('self-update-apply')).rejects.toMatchObject({ code: 'LOCAL_WORK_IDENTITY_UNAVAILABLE' });
    expect(await db.resourceParticipantWork.count({ where: { nodeId: id } })).toBe(0);
    probe.available = true; probe.host = 'unregistered.invalid';
    await expect(local.reserveApiLocalWork('self-update-apply')).rejects.toMatchObject({ code: 'RESOURCE_TARGET_INVALID' });
  });
  it('persists ownership before effects and retains successful descendants as unknown', async () => {
    const result = await local.withApiLocalWork('self-update-check', async () => {
      expect(await db.resourceParticipantWork.count({ where: { nodeId: id, state: 'running' } })).toBe(1); return { observed: true };
    });
    expect(result.observed).toBe(true);
    expect(await local.apiLocalWorkStatus(result.workId)).toMatchObject({ kind: 'self-update-check', state: 'unknown', settlement: 'descendants-unverified' });
  });
  it('denies delayed execution when drain begins after reservation', async () => {
    const work = await local.reserveApiLocalWork('self-update-restart'); await enrollment.beginEnrollmentDrain(id, 'fixture');
    const effect = vi.fn(async () => undefined); await expect(work.run(effect)).rejects.toMatchObject({ code: 'RESOURCE_DRAIN_REQUIRED' });
    expect(effect).not.toHaveBeenCalled(); expect(await local.apiLocalWorkStatus(work.workId)).toMatchObject({ state: 'released', settlement: 'barrier-before-dispatch' });
  });
  it('keeps a lost callback held and never replays a work identity', async () => {
    const work = await local.reserveApiLocalWork('self-update-apply'); const effect = vi.fn(async () => { throw new Error('lost callback'); });
    await expect(work.run(effect)).rejects.toThrow('lost callback'); await expect(work.run(effect)).rejects.toMatchObject({ code: 'RESOURCE_WORK_CONFLICT' });
    expect(effect).toHaveBeenCalledTimes(1); expect(await local.apiLocalWorkStatus(work.workId)).toMatchObject({ state: 'unknown' });
  });
  it('rechecks local identity without running against a newly selected host', async () => {
    const work = await local.reserveApiLocalWork('self-update-restart'); probe.host = 'other.invalid'; const effect = vi.fn(async () => undefined);
    await expect(work.run(effect)).rejects.toMatchObject({ code: 'LOCAL_WORK_IDENTITY_CHANGED' }); expect(effect).not.toHaveBeenCalled();
    expect(await local.apiLocalWorkStatus(work.workId)).toMatchObject({ state: 'released', settlement: 'not-dispatched' });
  });
  it('serializes two invocations of the same reservation', async () => {
    const work = await local.reserveApiLocalWork('self-update-restart'); const effect = vi.fn(async () => true);
    const results = await Promise.allSettled([work.run(effect), work.run(effect)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(effect).toHaveBeenCalledTimes(1);
  });
  function schedulerReply(change?: (value: Record<string, unknown>) => void) {
    return vi.fn(async (url: string, options: RequestInit) => {
      expect(url).toBe('https://127.0.0.1:39093/api/v1/cron/enrollment-drain'); expect(options.headers).toMatchObject({ 'x-node-token': nodeKey });
      const descriptor = JSON.parse(String(options.body));
      expect(await enrollment.nodeEnrollmentStatus(host, randomUUID(), 'scheduler')).toMatchObject({ schedulerChallenge: { challengeId: descriptor.challengeId }, state: 'draining' });
      const value = { ...descriptor, scope: 'magnus-managed-scheduler-only', status: 'managed-drained', activeCount: 0,
        unknownCount: 0, externalBlockers: [], evidenceSha256: 'a'.repeat(64) }; change?.(value);
      return new Response(JSON.stringify({ ...value, signature: createHmac('sha256', resultKey).update(enrollment.enrollmentSigningPayload(value)).digest('hex') }));
    });
  }
  it('requires a separate review for a current signed scheduler boundary without activating enrollment', async () => {
    await enrollment.beginEnrollmentDrain(id, 'fixture'); vi.stubGlobal('fetch', schedulerReply());
    expect(await enrollment.refreshEnrollmentParticipant(id, 'scheduler')).toMatchObject({ status: 'pending', reason: 'reviewed-boundary-required' });
    await expect(enrollment.completeEnrollment(id)).rejects.toMatchObject({ code: 'RESOURCE_DRAIN_INCOMPLETE' });
  });
  it('rejects a correctly signed receipt for another participant', async () => {
    await enrollment.beginEnrollmentDrain(id, 'fixture'); vi.stubGlobal('fetch', schedulerReply(value => { value.participant = 'agent'; }));
    expect(await enrollment.refreshEnrollmentParticipant(id, 'scheduler')).toMatchObject({ status: 'pending', reason: 'participant-evidence-unavailable' });
  });
  it('retains central unknown occurrences even if node inventory claims zero', async () => {
    await enrollment.beginEnrollmentDrain(id, 'fixture');
    await db.managedCronOccurrence.create({ data: { id: randomUUID(), cronJobId: 'fixture', nodeId: id, revision: 1, specSha256: 'a'.repeat(64),
      scheduledAt: new Date(), deadline: new Date(Date.now() - 1000), commandId: randomUUID(), state: 'unknown' } });
    vi.stubGlobal('fetch', schedulerReply());
    expect(await enrollment.refreshEnrollmentParticipant(id, 'scheduler')).toMatchObject({ status: 'pending', reason: 'unsettled-work' });
    expect((await enrollment.inspectEnrollment(id)).schedulerUnsettled).toBe(1);
  });
});
