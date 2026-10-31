import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { MutationBarrier } from './mutation-barrier.js';
import { signHistoricalAssertion } from './historical-mutation.js';
const fixture = vi.hoisted(() => ({ barrier: null as unknown as MutationBarrier, authority: vi.fn(), commandSnapshot: vi.fn(), inventory: vi.fn() }));
const secret = 'independent-result-signing-key-for-drain-proof';
vi.mock('../env.js', () => ({ CONTROL_API_URL: 'https://control.fixture', HOST_FQDN: 'fixture.lab',
  NODE_MANAGER_SECRET: 'node-auth', NODE_MANAGER_SECRET_PREVIOUS: '', RESULT_SIGNING_SECRET: 'independent-result-signing-key-for-drain-proof', MAGNUS_EXECUTION_SUPERVISOR_ENABLED: true }));
vi.mock('../tls.js', () => ({ controlApiFetch: fixture.authority }));
vi.mock('./command-executor.js', () => ({ commandLedger: { drainSnapshot: fixture.commandSnapshot }, executionSupervisor: { inventory: fixture.inventory } }));
vi.mock('./mutation-barrier.js', async importOriginal => ({ ...await importOriginal<typeof import('./mutation-barrier.js')>(),
  mutationBarrier: new Proxy({}, { get: (_o, name) => {
    const value = fixture.barrier[name as keyof MutationBarrier]; return typeof value === 'function' ? value.bind(fixture.barrier) : value;
  } }) }));
const { enrollmentDrainRoutes, canonicalDrainJson, HOST_LOCAL_WRITER_DOMAIN } = await import('./enrollment-drain.js');
const { nodeAuthMiddleware } = await import('../middleware.js');
const { managedMutationGuard } = await import('./managed-http.js');
let root: string;
let descriptor: { version: 1; participant: 'agent'; nodeId: string; nodeFqdn: string; epoch: number;
  barrierId: string; challengeId: string; expiresAt: number };
let app: Hono;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'enrollment-proof-')); fixture.barrier = new MutationBarrier(root, 'fixture.lab');
  descriptor = { version: 1, participant: 'agent', nodeId: 'fixture', nodeFqdn: 'fixture.lab', epoch: 1,
    barrierId: randomUUID(), challengeId: randomUUID(), expiresAt: Date.now() + 60_000 };
  fixture.authority.mockReset().mockImplementation(async (_url, init) => new Response(JSON.stringify({ success: true, data: {
    version: 1, nodeId: 'fixture', nodeFqdn: 'fixture.lab', nonce: JSON.parse(init.body).nonce,
    state: 'draining', epoch: descriptor.epoch, barrierId: descriptor.barrierId,
    agentChallenge: { challengeId: descriptor.challengeId, expiresAt: descriptor.expiresAt },
  } })));
  fixture.commandSnapshot.mockReset().mockResolvedValue({ activeCount: 0, unknownCount: 0, evidenceSha256: 'a'.repeat(64) });
  fixture.inventory.mockReset().mockResolvedValue({ supported: true, quiescent: true });
  app = new Hono(); app.use('*', nodeAuthMiddleware); app.use('*', managedMutationGuard);
  app.route('/commands', enrollmentDrainRoutes);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const send = (body = descriptor, authenticated = true) => app.request('/commands/enrollment-drain', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { 'x-node-token': 'node-auth' } : {}) }, body: JSON.stringify(body),
});
describe('authority-bound node drain evidence', () => {
  it('signs settled process counts while the forensic inventory retains original unknown outcomes', async () => {
    let clock = Date.now();
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    let boot = { id: randomUUID(), startedAt: clock - 100_000 };
    const keys = { result: secret, reconciliation: 'separate-controller-reconciliation-key'.repeat(2) };
    const reviewed: Record<string, { nodeFqdn: string; recordSha256: string }> = {};
    fixture.barrier = new MutationBarrier(root, 'fixture.lab', keys, async () => boot, reviewed);
    try {
      const token = await fixture.barrier.begin('POST', '/codex/update'); await fixture.barrier.finish(token, 'unknown');
      await fixture.barrier.drain({ nodeId: descriptor.nodeId, nodeFqdn: descriptor.nodeFqdn, epoch: descriptor.epoch, barrierId: descriptor.barrierId });
      const before = await fixture.barrier.historicalObservation(); clock += 10_000;
      for (const row of before.records) reviewed[row.id] = { nodeFqdn: 'fixture.lab', recordSha256: row.recordSha256 };
      boot = { id: randomUUID(), startedAt: clock }; clock += 5000;
      await fixture.barrier.settleHistorical(signHistoricalAssertion({ version: 1, before, boot, records: before.records,
        disposition: 'post_boot_quiescence_outcome_unknown', approvalRef: 'operator:fixture', decisionId: randomUUID(), expiresAt: clock + 300_000 }, keys.reconciliation));
      const result = await app.request('/commands/host-local-writer-proof?' + new URLSearchParams({ nodeFqdn: 'fixture.lab', nonce: randomUUID() }),
        { headers: { 'x-node-token': 'node-auth' } });
      const { signature, ...receipt } = (await result.json()).data;
      expect(receipt).toMatchObject({ active: 0, unknown: 0 });
      expect(signature).toBe(createHmac('sha256', secret).update(HOST_LOCAL_WRITER_DOMAIN + canonicalDrainJson(receipt)).digest('hex'));
      expect((await fixture.barrier.unknownInventory()).rows).toMatchObject([{ id: token.id, state: 'unknown',
        historicalSettlement: { replayPermitted: false } }]);
    } finally { spy.mockRestore(); }
  });
  it('signs a fresh exact owner fence and retains unknown effects in the proof', async () => {
    const request = { nodeFqdn: 'fixture.lab', nonce: randomUUID() };
    const path = '/commands/host-local-writer-proof?' + new URLSearchParams(request);
    const proof = () => app.request(path, { headers: { 'x-node-token': 'node-auth' } });
    expect((await app.request(path)).status).toBe(401);
    expect((await proof()).status).toBe(409);
    await fixture.barrier.drain({ nodeId: descriptor.nodeId, nodeFqdn: descriptor.nodeFqdn,
      epoch: descriptor.epoch, barrierId: descriptor.barrierId });
    const result = await proof();
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    const body = await result.json();
    const { signature, ...receipt } = body.data;
    expect(receipt).toMatchObject({ sourceClass: 'host-local-mutations', nodeId: 'fixture',
      nonce: request.nonce, active: 0, unknown: 0, epoch: 1, barrierId: descriptor.barrierId });
    expect(signature).toBe(createHmac('sha256', secret)
      .update(HOST_LOCAL_WRITER_DOMAIN + canonicalDrainJson(receipt)).digest('hex'));
    expect((await proof()).status).toBe(200);
    // A retained claim produced before the drain remains visible and cannot
    // become a zero-work proof merely because the process restarted.
  });
  it('reports pre-drain unknown claims under a signed fenced identity', async () => {
    const token = await fixture.barrier.begin('POST', '/commands/execute');
    await fixture.barrier.finish(token, 'unknown');
    await fixture.barrier.drain({ nodeId: descriptor.nodeId, nodeFqdn: descriptor.nodeFqdn,
      epoch: descriptor.epoch, barrierId: descriptor.barrierId });
    const result = await app.request('/commands/host-local-writer-proof?' + new URLSearchParams({
      nodeFqdn: 'fixture.lab', nonce: randomUUID() }), { headers: { 'x-node-token': 'node-auth' } });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ data: { active: 0, unknown: 1 } });
  });
  it('exposes only authenticated, read-only retained mutation metadata', async () => {
    const token = await fixture.barrier.begin('POST', '/codex/update');
    await fixture.barrier.finish(token, 'unknown');
    const path = '/commands/mutation-inventory';
    expect((await app.request(path)).status).toBe(401);
    const result = await app.request(path, { headers: { 'x-node-token': 'node-auth' } });
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    const body = await result.json();
    expect(body).toMatchObject({ success: true, data: { nodeFqdn: 'fixture.lab', drain: null,
      rows: [{ id: token.id, state: 'unknown', commandId: null }] } });
    expect(JSON.stringify(body)).not.toContain('/codex/update');
    expect(JSON.stringify(body)).not.toContain(token.nonce);
    expect((await fixture.barrier.unknownInventory()).rows).toHaveLength(1);
  });
  it('requires node authentication before inspecting or changing the barrier', async () => {
    expect((await send(descriptor, false)).status).toBe(401); expect(fixture.authority).not.toHaveBeenCalled();
    expect(fixture.commandSnapshot).not.toHaveBeenCalled();
  });
  it('independently verifies the challenge then persists a barrier before signing zero owned work', async () => {
    const response = await send(); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const { signature, ...receipt } = await response.json();
    expect(receipt).toMatchObject({ ...descriptor, status: 'drained', activeCount: 0, unknownCount: 0 });
    expect(signature).toBe(createHmac('sha256', secret).update('magnus.resource-enrollment.v1\n' + canonicalDrainJson(receipt)).digest('hex'));
    await expect(new MutationBarrier(root, 'fixture.lab').begin('POST', '/files/write')).rejects.toThrow('draining');
  });
  it('reports active and crashed/unknown work as pending instead of approving enrollment', async () => {
    const token = await fixture.barrier.begin('POST', '/background'); await fixture.barrier.finish(token, 'unknown');
    fixture.commandSnapshot.mockResolvedValue({ activeCount: 1, unknownCount: 0, evidenceSha256: 'b'.repeat(64) });
    expect(await (await send()).json()).toMatchObject({ status: 'pending', activeCount: 1, unknownCount: 1 });
  });
  it('cannot accept caller-supplied counts or a different challenge, node or epoch', async () => {
    expect((await send({ ...descriptor, activeCount: 0 } as typeof descriptor)).status).toBe(400);
    for (const change of [{ nodeId: 'other' }, { epoch: 2 }, { challengeId: randomUUID() }, { nodeFqdn: 'other.lab' }])
      expect((await send({ ...descriptor, ...change })).status).toBe(409);
    expect(fixture.commandSnapshot).not.toHaveBeenCalled();
  });
  it('retains a sticky barrier but refuses proof when the ledger is unavailable', async () => {
    fixture.commandSnapshot.mockRejectedValue(new Error('ledger busy'));
    expect((await send()).status).toBe(409);
    await expect(fixture.barrier.begin('POST', '/files/write')).rejects.toThrow('draining');
  });
  it('refuses zero-work proof if systemd is unsupported or retains unowned/unknown executions', async () => {
    for (const inventory of [{ supported: false, quiescent: false }, { supported: true, quiescent: false }]) {
      fixture.inventory.mockResolvedValue(inventory);
      expect((await send()).status).toBe(409);
    }
    expect(fixture.commandSnapshot).not.toHaveBeenCalled();
  });
  it('rejects stale challenge evidence after filesystem/ledger waits', async () => {
    // Advance wall time only when the ledger is reached, after authority binding.
    const now = Date.now(); fixture.commandSnapshot.mockImplementation(async () => {
      vi.spyOn(Date, 'now').mockReturnValue(now + 120_000);
      return { activeCount: 0, unknownCount: 0, evidenceSha256: 'a'.repeat(64) };
    });
    try { expect((await send()).status).toBe(409); } finally { vi.restoreAllMocks(); }
  });
});
