/**
 * One wave through the real client, admission, leases and fence rows in
 * PostgreSQL. Only the agents are fake, answering at the HTTP boundary the way
 * their versions really do: a 1.1.8 agent whose preflight reports a high fence, a
 * 1.1.8 agent that signs a STALE_FENCE refusal, and an older agent that has no
 * preflight and can only answer MANAGED_MUTATION_UNCERTAIN.
 * agent-upgrade.real-agent.integration.test.ts runs the real agent itself.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { commandRequestDigest } from '../security/command-request.js';
import { commandRefusalSigningPayload, commandResultSigningPayload, fenceProofSigningPayload } from '../security/command-result-signature.js';
import { httpIdentity, httpReceiptBody } from '../security/managed-http.js';

const secret = 'upgrade-wave-result-fixture-at-least-32-characters';
vi.mock('../utils/env.js', async original => ({ ...await original<object>(),
  NODE_MANAGER_SECRET: 'upgrade-wave-node-auth-fixture-at-least-32-characters',
  RESULT_SIGNING_SECRET: 'upgrade-wave-result-fixture-at-least-32-characters', RESULT_SIGNING_PREVIOUS_SECRET: '',
  getNodeManagerSecret: () => 'upgrade-wave-node-auth-fixture-at-least-32-characters' }));
const auditLog = vi.hoisted(() => vi.fn(async (_event: unknown) => undefined));
vi.mock('./audit-service.js', async original => ({ ...await original<object>(), logAuditEvent: auditLog }));

const prefix = `wave-${randomUUID().slice(0, 8)}`;
const HIGH = 1789962351090n;
const INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const TARGET = '1.1.8';

type Behaviour = 'proof' | 'refuses-signed' | 'old-uncertain' | 'old-busy' | 'busy-signed-once' | 'lost-then-confirms' | 'reverts' | 'unreachable';

describe.skipIf(!process.env['TEST_DATABASE_URL'])('an upgrade wave over real leases and fences', () => {
  let db: ReturnType<typeof import('../db/index.js')['getDb']>;
  let service: typeof import('./agent-upgrade-service.js');
  const created: string[] = [];
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const hmac = (payload: string) => createHmac('sha256', secret).update(payload).digest('hex');
  const metadata = () => JSON.stringify({ agentSelfUpgrade: { protocol: 1, launcherProtocol: 1, layout: 'versioned', enabled: true, upgrade: { state: 'idle', to: '1.1.7' }, observedAt: new Date().toISOString() } });

  beforeAll(async () => {
    const url = process.env['TEST_DATABASE_URL']!;
    if (!new URL(url).pathname.startsWith('/magnus_ideas')) throw new Error('Disposable magnus_ideas database required');
    vi.stubEnv('DATABASE_URL', url); vi.stubEnv('MAGNUS_RESOURCE_LEASES_ENABLED', 'true');
    vi.stubEnv('CREDENTIAL_ROTATION_KEY', 'upgrade-wave-rotation-fixture-at-least-32-characters'); vi.stubEnv('CREDENTIAL_ROTATION_STATE_PATH', join(tmpdir(), `magnus-wave-rotation-${randomUUID()}.json`));
    db = (await import('../db/index.js')).getDb();
    service = await import('./agent-upgrade-service.js');
  });

  const clean = async (ids: string[]) => {
    await db.commandResourceLease.deleteMany({ where: { nodeId: { in: ids } } });
    await db.remoteCommand.deleteMany({ where: { nodeId: { in: ids } } });
    await db.commandResourceFence.deleteMany({ where: { resourceKey: { in: ids.map(id => `node:${id}`) } } });
    await db.resourceEnrollment.deleteMany({ where: { nodeId: { in: ids } } });
    await db.agent.deleteMany({ where: { nodeId: { in: ids } } });
    await db.node.deleteMany({ where: { id: { in: ids } } });
  };

  afterEach(async () => { vi.unstubAllGlobals(); auditLog.mockClear(); });
  afterAll(async () => {
    if (db) { await clean(created); await (await import('../db/index.js')).disconnectDb(); }
    vi.unstubAllEnvs();
  });

  /** Create nodes with fake agents that answer at the HTTP boundary, each the way its version really does. */
  async function fleet(spec: Record<string, { behaviour: Behaviour; ledgerFence?: bigint; enrollment?: 'draining' }>) {
    const run = randomUUID().slice(0, 6);
    const nodes = Object.entries(spec).map(([name, entry], index) => ({ id: `${prefix}-${run}-${name}`, port: 41000 + index, ...entry }));
    created.push(...nodes.map(node => node.id));
    for (const node of nodes) {
      await db.node.create({ data: { id: node.id, name: node.id, hostname: `${node.id}.invalid`, ipAddress: '127.0.0.1', port: node.port, os: 'fixture', arch: 'fixture', token: randomUUID(),
        status: 'ONLINE', lastHeartbeatAt: new Date(), metadata: metadata(), agent: { create: { version: '1.1.7', status: 'RUNNING' } } } });
      await db.resourceEnrollment.create({ data: { nodeId: node.id, nodeFqdn: `${node.id}.invalid`, state: node.enrollment ?? 'enrolled', epoch: 1, barrierId: randomUUID(),
        ...(node.enrollment ? { startedAt: new Date('2026-06-03T10:00:00Z') } : { enrolledAt: new Date() }) } });
    }
    const ledger = new Map(nodes.map(node => [node.id, node.ledgerFence ?? 0n]));
    const accepted: string[] = [];
    const busied = new Set<string>();
    const receipts = new Map<string, unknown>();
    vi.stubGlobal('fetch', vi.fn(async (req: Request) => {
      const url = new URL(req.url);
      const node = nodes.find(entry => String(entry.port) === url.port)!;
      if (node.behaviour === 'unreachable') throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
      if (url.pathname.endsWith('/ping')) return json({ success: true, data: { features: { managedMutations: 1 } } });
      if (url.pathname.endsWith('/agent-upgrade/preflight')) {
        // Older agents have no such route. A 1.1.8 agent reports its fence, signed for this nonce.
        if (node.behaviour === 'old-uncertain' || node.behaviour === 'old-busy') return json({ success: false, error: { code: 'NOT_FOUND' } }, 404);
        if (node.behaviour === 'refuses-signed') return json({ success: false, error: { code: 'BUSY' } }, 503);
        const nonce = url.searchParams.get('nonce')!;
        const fenceHighWater = ledger.get(node.id) ? { [`node:${node.id}`]: String(ledger.get(node.id)) } : {};
        const nodeFqdn = `${node.id}.invalid`;
        return json({ success: true, data: { preflightProtocol: 1, version: '1.1.7', layout: 'versioned', enabled: true, writable: { ok: true, blocked: [] }, fromVersionComplete: true, fenceHighWater,
          fenceProof: { nonce, nodeFqdn, signature: hmac(fenceProofSigningPayload({ nonce, nodeFqdn, fenceHighWater })) } } });
      }
      if (url.pathname.includes('/receipts/')) {
        const stored = receipts.get(decodeURIComponent(url.pathname.split('/receipts/')[1]!));
        return stored ? json({ success: true, data: stored }) : json({ success: false, error: { code: 'NOT_FOUND' } }, 404);
      }
      const value = await req.json() as { claim: { leaseId: string; nodeFqdn: string }; commandId: string; method: 'POST'; path: string; body: string; timeoutSeconds: number; coordination: { resourceKey: string; fence: string; expiresAt: number; version: 1 } };
      // What every released agent up to 1.1.7 answers, whatever the real cause.
      if (node.behaviour === 'old-busy') return json({ success: false, error: { code: 'RESOURCE_BUSY' } }, 409);
      if (node.behaviour === 'old-uncertain') return json({ success: false, error: { code: 'MANAGED_MUTATION_UNCERTAIN', message: 'Inspect the exact resource receipt before further work; no automatic replay' } }, 409);
      const identity = { ...httpIdentity(value.commandId, value.method, value.path, value.body, value.timeoutSeconds), coordination: value.coordination };
      const digest = commandRequestDigest(identity);
      if (BigInt(value.coordination.fence) <= ledger.get(node.id)!) {
        const unsigned = { commandId: value.commandId, requestSha256: digest, code: 'STALE_FENCE', highWater: String(ledger.get(node.id)), nodeFqdn: value.claim.nodeFqdn, leaseId: value.claim.leaseId };
        return json({ success: false, error: { code: 'STALE_FENCE', message: 'Stale resource fence cannot execute', executed: false, dispatched: false, highWater: unsigned.highWater, resourceKey: value.coordination.resourceKey,
          refusal: { ...unsigned, signature: hmac(commandRefusalSigningPayload(unsigned)) } } }, 409);
      }
      if (node.behaviour === 'busy-signed-once' && !busied.has(node.id)) {
        busied.add(node.id);
        const unsigned = { commandId: value.commandId, requestSha256: digest, code: 'RESOURCE_BUSY', highWater: null, nodeFqdn: value.claim.nodeFqdn, leaseId: value.claim.leaseId };
        return json({ success: false, error: { code: 'RESOURCE_BUSY', message: 'Another request owns the node execution slot; nothing ran', executed: false, dispatched: false, refusal: { ...unsigned, signature: hmac(commandRefusalSigningPayload(unsigned)) } } }, 409);
      }
      ledger.set(node.id, BigInt(value.coordination.fence));
      accepted.push(node.id);
      const body = JSON.stringify({ success: true, data: { accepted: true } });
      const result = { commandId: value.commandId, exitCode: 0, stdout: httpReceiptBody(value.method, value.path, 200, body), stderr: '', durationMs: 1, truncated: false, coordination: { ...value.coordination, requestSha256: digest } };
      const requestId = (JSON.parse(value.body) as { requestId: string }).requestId;
      await db.node.update({ where: { id: node.id }, data: { metadata: JSON.stringify({ agentSelfUpgrade: { protocol: 1, launcherProtocol: 1, layout: 'versioned', enabled: true,
        upgrade: { state: node.behaviour === 'reverts' ? 'reverted' : 'confirmed', from: '1.1.7', to: TARGET, requestId, reason: node.behaviour === 'reverts' ? 'the new version stayed silent' : null }, observedAt: new Date().toISOString() } }) } });
      const receipt = { ...result, signature: hmac(commandResultSigningPayload(result)) };
      if (node.behaviour === 'lost-then-confirms') {
        // The agent did the work and kept its signed receipt; only the reply never arrived.
        receipts.set(value.commandId, { commandId: value.commandId, requestSha256: digest, state: 'completed', result: receipt });
        throw new TypeError('socket hang up');
      }
      return json({ success: true, data: { response: { status: 200, body }, receipt } });
    }));
    const store = service.memoryRunStore();
    let clock = Date.now();
    const real = service.defaultDeps(store);
    // These agents keep sending heartbeats, on the same accelerated clock as the run.
    const deps = { ...real, pollMs: 5_000, confirmTimeoutMs: 10_000, retryBackoffMs: [1], now: () => clock, observe: async (nodeId: string) => ({ ...await real.observe(nodeId), lastHeartbeatAt: new Date(clock) }),
      sleep: async (ms: number) => { clock += ms; await new Promise(resolve => setTimeout(resolve, 1)); } };
    const started = await service.startUpgradeRun({ version: TARGET, integrity: INTEGRITY, nodeIds: nodes.map(node => node.id), actorId: 'admin', store, deps });
    const result = await started.done;
    const id = (name: string) => nodes.find(node => node.id.endsWith(`-${name}`))!.id;
    return { run: result, started, id, accepted, ids: nodes.map(node => node.id), entry: (name: string) => result.nodes.find(node => node.nodeId === id(name)) };
  }
  const fence = async (id: string) => (await db.commandResourceFence.findUniqueOrThrow({ where: { resourceKey: `node:${id}` } })).generation;

  it('heals what it can, retries what it may, excludes what it must, and hands off past an old agent', async () => {
    const { run, started, id, accepted, ids, entry } = await fleet({
      'a-old': { behaviour: 'old-uncertain' }, 'b-reports': { behaviour: 'proof', ledgerFence: HIGH }, 'c-refuses': { behaviour: 'refuses-signed', ledgerFence: HIGH }, 'd-stuck': { behaviour: 'proof', enrollment: 'draining' }, 'e-healthy': { behaviour: 'proof' } });
    // The old agent can only answer uncertain: real client, real lease, held. It does not stop the wave, and the canary role moves on.
    expect(entry('a-old')).toMatchObject({ state: 'ambiguous', code: 'MANAGED_MUTATION_UNCERTAIN', attempts: 1, failureClass: 'node' });
    expect(run.canaryNodeId).toBe(id('b-reports'));
    expect(await db.commandResourceLease.findFirstOrThrow({ where: { nodeId: id('a-old') } })).toMatchObject({ state: 'unknown' });
    // The preflight healed this one before anything was sent: it passed on its first request.
    expect(entry('b-reports')).toMatchObject({ state: 'confirmed', attempts: 1 });
    expect(await fence(id('b-reports'))).toBe(HIGH + 2n);
    // This one could only say so by refusing: signed, settled, healed, and tried again with a new request.
    expect(entry('c-refuses')).toMatchObject({ state: 'confirmed', attempts: 2 });
    expect(await fence(id('c-refuses'))).toBe(HIGH + 2n);
    expect(entry('e-healthy')?.state).toBe('confirmed');
    expect(started.run.excluded).toEqual([expect.objectContaining({ nodeId: id('d-stuck'), code: 'ENROLLMENT_DRAINING' })]);
    expect(run.status).toBe('partial');
    expect(run.attention?.map(item => item.code).sort()).toEqual(['ENROLLMENT_DRAINING', 'MANAGED_MUTATION_UNCERTAIN']);
    expect(accepted.sort()).toEqual([id('b-reports'), id('c-refuses'), id('e-healthy')].sort());
    const leases = await db.commandResourceLease.findMany({ where: { nodeId: { in: ids } } });
    // Exactly one lease stays held, and it is the one nobody can prove anything about.
    expect(leases.filter(lease => lease.state !== 'released').map(lease => lease.nodeId)).toEqual([id('a-old')]);
    expect(leases.filter(lease => lease.nodeId === id('c-refuses')).map(lease => lease.settlement).sort()).toEqual(['not-dispatched', 'signed-command-result']);
    const advanced = auditLog.mock.calls.map(([event]) => event as { action: string; details: { source: string } }).filter(event => event.action === 'agent.fence.advanced');
    expect(advanced.map(event => event.details.source).sort()).toEqual(['preflight', 'stale-fence-reply']);
  });

  it('a mixed wave settles each lease the way the real client does, and leaves none held', async () => {
    const { run, entry, id, ids } = await fleet({ 'a-healthy': { behaviour: 'proof' }, 'b-busy': { behaviour: 'busy-signed-once' }, 'c-lost': { behaviour: 'lost-then-confirms' }, 'd-reverts': { behaviour: 'reverts' }, 'e-down': { behaviour: 'unreachable' }, 'f-healthy': { behaviour: 'proof' } });
    expect(entry('b-busy')).toMatchObject({ state: 'confirmed', attempts: 2 });
    expect(entry('c-lost')).toMatchObject({ state: 'confirmed', detail: expect.stringMatching(/reply to the request was lost/) });
    expect(entry('d-reverts')).toMatchObject({ state: 'reverted', code: 'SELF_UPGRADE_REVERTED', failureClass: 'release' });
    expect(entry('e-down')).toMatchObject({ state: 'refused', code: 'AGENT_UNREACHABLE', attempts: 2 });
    expect(entry('f-healthy')?.state).toBe('confirmed');
    expect(run.status).toBe('failed');
    const leases = await db.commandResourceLease.findMany({ where: { nodeId: { in: ids } } });
    expect(leases.filter(lease => lease.state !== 'released')).toEqual([]);
    const settlements = (name: string) => leases.filter(lease => lease.nodeId === id(name)).map(lease => lease.settlement).sort();
    expect(settlements('b-busy')).toEqual(['not-dispatched', 'signed-command-result']);
    // The lost reply is settled by the agent's signed receipt, read after it confirmed.
    expect(settlements('c-lost')).toEqual(['signed-command-result']);
    expect(settlements('e-down')).toEqual(['not-dispatched', 'not-dispatched']);
  });

  describe('where a heartbeat can send the server', () => {
    const beat = async (fqdn: string, addresses: string[]) => {
      const { heartbeatRouter } = await import('../routes/heartbeat.js');
      const response = await new Hono().route('/', heartbeatRouter).request('/', { method: 'POST', headers: { 'content-type': 'application/json', 'x-node-token': 'upgrade-wave-node-auth-fixture-at-least-32-characters' },
        body: JSON.stringify({ agentVersion: '1.1.7', fqdn, health: { network: addresses.map(ipAddress => ({ ipAddress })) } }) });
      expect(response.status).toBe(200);
    };
    it('states the limit: a fleet credential can repoint a node only while its stored address is unroutable', async () => {
      const routable = `${prefix}-routable`;
      const loopback = `${prefix}-loopback`;
      created.push(routable, loopback);
      for (const [id, ipAddress] of [[routable, '192.0.2.10'], [loopback, '127.0.0.1']] as const)
        await db.node.create({ data: { id, name: id, hostname: `${id}.invalid`, ipAddress, port: 41000, os: 'fixture', arch: 'fixture', token: randomUUID(), status: 'ONLINE', lastHeartbeatAt: new Date() } });
      // Any holder of the credential can claim to be either node, and report any address it likes.
      await beat(`${routable}.invalid`, ['198.51.100.66']);
      await beat(`${loopback}.invalid`, ['198.51.100.66']);
      expect((await db.node.findUniqueOrThrow({ where: { id: routable } })).ipAddress).toBe('192.0.2.10');
      expect((await db.node.findUniqueOrThrow({ where: { id: loopback } })).ipAddress).toBe('198.51.100.66');
    });
  });

  it('finding 1: old agents that all answer uncertain stop at the budget, with the release suspect but unproven', async () => {
    const { run, entry, accepted } = await fleet({ 'a-old': { behaviour: 'old-uncertain' }, 'b-old': { behaviour: 'old-uncertain' }, 'c-old': { behaviour: 'old-uncertain' }, 'd-healthy': { behaviour: 'proof' } });
    expect(run).toMatchObject({ status: 'failed', message: expect.stringMatching(/suspect but unproven/), suspectedRelease: expect.stringMatching(/suspect but unproven/) });
    expect(entry('c-old')).toMatchObject({ state: 'skipped', code: 'NOT_REACHED' });
    expect(entry('d-healthy')?.state).toBe('skipped');
    expect(accepted).toEqual([]);
  });

  it('finding 10: does not retry a refusal an older agent could not prove, and keeps its code', async () => {
    // An older agent answers a busy slot with RESOURCE_BUSY but no signature: the client must hold the lease.
    const { run, entry } = await fleet({ 'a-healthy': { behaviour: 'proof' }, 'b-busy': { behaviour: 'old-busy' } });
    expect(entry('b-busy')).toMatchObject({ state: 'refused', code: 'RESOURCE_BUSY', attempts: 1, detail: expect.stringMatching(/lease of this request is still held/) });
    expect(run.attention?.map(item => item.code)).toEqual(['RESOURCE_BUSY']);
  });
});
