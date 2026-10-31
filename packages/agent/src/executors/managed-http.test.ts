import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { CommandLedger, commandRequestDigest } from './command-ledger.js';
import { MutationBarrier } from './mutation-barrier.js';
import { httpIdentity, httpReceiptBody } from '../security/managed-http.js';
import { verifyCommandResult } from '../security/command-result-signature.js';
const fixture = vi.hoisted(() => ({ ledger: null as unknown as CommandLedger, barrier: null as unknown as MutationBarrier, confirm: vi.fn() }));
const key = 'managed-http-result-key-more-than-thirty-two';
vi.mock('../env.js', () => ({ CONTROL_API_URL: 'https://control.fixture', HOST_FQDN: 'fixture.lab', NODE_MANAGER_SECRET: 'fixture-node-key', NODE_MANAGER_SECRET_PREVIOUS: '', RESULT_SIGNING_SECRET: 'managed-http-result-key-more-than-thirty-two', MAGNUS_EXECUTION_SUPERVISOR_ENABLED: false }));
vi.mock('../tls.js', () => ({ controlApiFetch: fixture.confirm }));
vi.mock('./command-executor.js', async importOriginal => ({ executeBodySchema: (await importOriginal<typeof import('./command-executor.js')>()).executeBodySchema, commandLedger: new Proxy({}, { get: (_o, name) => {
  const value = fixture.ledger[name as keyof CommandLedger]; return typeof value === 'function' ? value.bind(fixture.ledger) : value;
} }) }));
vi.mock('./mutation-barrier.js', async importOriginal => ({ ...await importOriginal<typeof import('./mutation-barrier.js')>(),
  mutationBarrier: new Proxy({}, { get: (_o, name) => {
    const value = fixture.barrier[name as keyof MutationBarrier]; return typeof value === 'function' ? value.bind(fixture.barrier) : value;
  } }) }));
const { managedMutationGuard, registerManagedHttp } = await import('./managed-http.js');
const { nodeAuthMiddleware } = await import('../middleware.js');
let root: string;
let barrierRoot: string;
let app: Hono;
let execute: ReturnType<typeof vi.fn>;
function request(id = 'native-one', body = JSON.stringify({ private: 'do-not-store-body' }), path = '/files/write', fence = '1') {
  return { claim: { leaseId: 'lease-'+id, nodeId: 'fixture', nodeFqdn: 'fixture.lab' }, commandId: id,
    method: 'POST', path, body, timeoutSeconds: 10,
    coordination: { version: 1, resourceKey: 'node:fixture', fence, expiresAt: Date.now() + 60_000 } };
}
type ManagedRequest = ReturnType<typeof request> & { recoveryOnly?: true };
function send(value: ManagedRequest) {
  return app.request('http://localhost/api/v1/commands/managed-http', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-node-token': 'fixture-node-key' }, body: JSON.stringify(value) });
}
function sendWithSignal(value: ManagedRequest, signal: AbortSignal) {
  return app.request('http://localhost/api/v1/commands/managed-http', { method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-node-token': 'fixture-node-key' }, body: JSON.stringify(value) });
}
function skillPublicationBody(version = '1.0.0') {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const manifest = JSON.stringify({ name: 'crash-skill', version });
  const entries = [{ path: 'manifest.json', mode: 420 as const, sha256: hash(manifest), contentBase64: Buffer.from(manifest).toString('base64') }];
  const bundle = { format: 'magnus-skill-bundle-v1' as const, entries };
  return { skillName: 'crash-skill', version, bundleSha256: hash(JSON.stringify(bundle)), bundle };
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'managed-native-'));
  barrierRoot = await mkdtemp(join(tmpdir(), 'managed-barrier-'));
  fixture.barrier = new MutationBarrier(barrierRoot, 'fixture.lab');
  fixture.ledger = new CommandLedger(root, { resultSecret: key, reconciliationSecret: '', nodeFqdn: 'fixture.lab' });
  fixture.confirm.mockReset().mockImplementation(async (url, init) => new Response(JSON.stringify({ success: true, data: String(url).endsWith('/legacy-admission')
    ? { ...JSON.parse(init.body), nodeId: 'fixture', enrolled: false, gateEnabled: false, allowedLegacy: true }
    : { admitted: true, ...JSON.parse(init.body) } }), { status: 200 }));
  execute = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { written: true } }), { headers: { 'content-type': 'application/json' } }));
  app = new Hono(); app.use('/api/v1/*', nodeAuthMiddleware); app.use('/api/v1/*', managedMutationGuard);
  app.post('/api/v1/files/write', () => execute()); app.get('/api/v1/files/read', c => c.json({ success: true }));
  app.post('/api/v1/codex/device-auth', () => execute()); registerManagedHttp(app);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); await rm(barrierRoot, { recursive: true, force: true }); });

describe('managed native mutation execution boundary', () => {
  it('accepts only an exact Ardent scoped claim after sticky enrollment', async () => {
    app.post('/api/v1/ardent/action', () => execute());
    await fixture.ledger.observeManagedEnrollment({ nodeId: 'fixture', nodeFqdn: 'fixture.lab' });
    const scoped = request('ardent-scoped', '{}', '/ardent/action');
    scoped.coordination.resourceKey = 'node:fixture:ardent';
    expect((await send(scoped)).status).toBe(200);
    expect((await fixture.ledger.receipt(scoped.commandId))?.state).toBe('completed');
    const wrongPath = request('ardent-wrong-path', '{}', '/files/write', '2');
    wrongPath.coordination.resourceKey = 'node:fixture:ardent';
    expect((await send(wrongPath)).status).toBe(409);
    const raw = await app.request('/api/v1/ardent/action', { method: 'POST', headers: { 'x-node-token': 'fixture-node-key' } });
    expect(raw.status).toBe(409);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('preserves legacy cron only while unenrolled and distinguishes finite managed installation', async () => {
    app.post('/api/v1/cron/sync', () => execute()); app.post('/api/v1/cron/managed-sync', () => execute());
    app.post('/api/v1/cron/managed-activate', () => execute()); app.post('/api/v1/cron/managed-revoke', () => execute());
    expect((await app.request('/api/v1/cron/sync', { method: 'POST', headers: { 'x-node-token': 'fixture-node-key' } })).status).toBe(200);
    expect((await send(request('raw-denied', '{}', '/cron/sync'))).status).toBe(409);
    expect((await send(request('managed-allowed', '{}', '/cron/managed-sync'))).status).toBe(200);
    expect((await send(request('managed-activate', '{}', '/cron/managed-activate', '2'))).status).toBe(200);
    expect((await send(request('managed-revoke', '{}', '/cron/managed-revoke', '3'))).status).toBe(200);
    expect((await app.request('/api/v1/cron/sync', { method: 'POST', headers: { 'x-node-token': 'fixture-node-key' } })).status).toBe(409);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('preserves unenrolled legacy calls only after fresh authoritative admission', async () => {
    const response = await app.request('/api/v1/files/write', { method: 'POST', headers: { 'x-node-token': 'fixture-node-key' } });
    expect(response.status).toBe(200); expect(execute).toHaveBeenCalledTimes(1); expect(fixture.confirm).toHaveBeenCalledTimes(1);
    expect(fixture.confirm.mock.calls[0]?.[0]).toContain('/legacy-admission');
    expect(await fixture.ledger.managedEnrollment()).toBeNull();
  });
  it('executes once under the node ledger, signs the exact response, and persists only body digests', async () => {
    const input = request(); const response = await send(input); expect(response.status).toBe(200);
    const body = await response.json(); const receipt = body.data.receipt;
    expect(execute).toHaveBeenCalledTimes(1); expect(verifyCommandResult(receipt, key)).toBe(true);
    expect(receipt.stdout).toBe(httpReceiptBody('POST', '/files/write', body.data.response.status, body.data.response.body));
    expect(await fixture.ledger.managedEnrollment()).toEqual({ version: 1, nodeId: 'fixture', nodeFqdn: 'fixture.lab' });
    expect((await send(input)).status).toBe(409); expect(execute).toHaveBeenCalledTimes(1);
    for (const name of await readdir(root)) expect(await readFile(join(root, name), 'utf8')).not.toContain('do-not-store-body');
  });
  it('denies every raw mutation after enrollment while keeping reads available', async () => {
    await send(request());
    for (const path of ['/files/write', '/codex/device-auth', '/unknown-future-route']) {
      const response = await app.request('/api/v1'+path, { method: 'POST', headers: { 'x-node-token': 'fixture-node-key' } });
      expect(response.status).toBe(409); expect((await response.json()).error.code).toBe('UNMANAGED_MUTATION');
    }
    expect((await app.request('/api/v1/files/read', { headers: { 'x-node-token': 'fixture-node-key' } })).status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
    const run = vi.fn();
    await expect(fixture.ledger.execute({ commandId: 'bypass', command: '/bin/true', args: [], timeoutSeconds: 1 }, run)).rejects.toMatchObject({ code: 'UNMANAGED_MUTATION' });
    expect(run).not.toHaveBeenCalled();
  });
  it('requires existing node authentication before processing a managed mutation', async () => {
    expect((await app.request('/api/v1/commands/managed-http', { method: 'POST', body: '{}' })).status).toBe(401);
    expect(fixture.confirm).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
  it('refuses mismatched body digest and forged root confirmation before any effect', async () => {
    const input = request(); const identity = { ...httpIdentity(input.commandId, input.method, input.path, input.body, input.timeoutSeconds), coordination: input.coordination };
    const expected = commandRequestDigest(identity);
    fixture.confirm.mockImplementation(async (_url, init) => {
      const claim = JSON.parse(init.body); return new Response(JSON.stringify({ success: true, data: { admitted: true, ...claim } }), { status: claim.requestSha256 === expected ? 200 : 409 });
    });
    expect((await send({ ...input, body: '{}' })).status).toBe(409); expect(execute).not.toHaveBeenCalled();
    fixture.confirm.mockResolvedValue(new Response(JSON.stringify({ success: true, data: { admitted: true } }), { status: 200 }));
    expect((await send(input)).status).toBe(409); expect(execute).not.toHaveBeenCalled();
    expect(await fixture.ledger.managedEnrollment()).toBeNull();
  });
  it('retains uncertainty across restart after a callback failure and blocks another operation', async () => {
    execute.mockRejectedValue(new Error('lost after effect'));
    expect((await send(request())).status).toBe(409);
    fixture.ledger = new CommandLedger(root, { resultSecret: key, reconciliationSecret: '', nodeFqdn: 'fixture.lab' });
    expect((await fixture.ledger.receipt('native-one'))?.state).toBe('unknown');
    expect((await send({ ...request('native-two'), coordination: { ...request().coordination, fence: '2' } })).status).toBe(409);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('does not release an accepted asynchronous response as completed', async () => {
    execute.mockResolvedValue(new Response('{}', { status: 202 }));
    expect((await send(request())).status).toBe(409);
    expect((await fixture.ledger.receipt('native-one'))?.state).toBe('unknown');
  });
  it('records a signed no-dispatch failure when authority expires during durable admission', async () => {
    const input = request();
    const original = fixture.ledger.execute.bind(fixture.ledger);
    const admission = vi.spyOn(fixture.ledger, 'execute').mockImplementation((identity, run, enrollment) =>
      original(identity, async digest => {
        // The real ledger has already persisted its fence, enrollment and running
        // receipt. Simulate time spent in those writes without slowing the test.
        const clock = vi.spyOn(Date, 'now').mockReturnValue(input.coordination.expiresAt + 1);
        try { return await run(digest); } finally { clock.mockRestore(); }
      }, enrollment));
    try {
      const response = await send(input);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(execute).not.toHaveBeenCalled();
      expect(body.data.response.status).toBe(409);
      expect(JSON.parse(body.data.response.body).error.code).toBe('LEASE_EXPIRED');
      expect(body.data.receipt.exitCode).toBe(1);
      expect(verifyCommandResult(body.data.receipt, key)).toBe(true);
      expect(body.data.receipt.coordination).toMatchObject(input.coordination);
      expect((await fixture.ledger.receipt(input.commandId))?.state).toBe('completed');
      expect((await send(input)).status).toBe(409);
      expect(execute).not.toHaveBeenCalled();
    } finally { admission.mockRestore(); }
  });
  it('rejects unsupported background login before reservation or execution', async () => {
    expect((await send(request('native-one', '{}', '/codex/device-auth'))).status).toBe(409);
    expect(fixture.confirm).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
  it('rejects a reviewed path classified to a different resource before authority or execution', async () => {
    const input = request();
    input.coordination.resourceKey = 'node:different';
    expect((await send(input)).status).toBe(409);
    expect(fixture.confirm).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
  it('requires pre-enrollment legacy work to drain before accepting a managed owner', async () => {
    let release!: () => void; let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    execute.mockImplementation(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return new Response('{}'); });
    const legacy = app.request('/api/v1/files/write', { method: 'POST', headers: { 'x-node-token': 'fixture-node-key' } }); await ready;
    expect((await send(request())).status).toBe(409); expect(fixture.confirm).toHaveBeenCalledTimes(1);
    release(); await legacy;
  });
  it('guards execution-bearing Hermes inspection and denies lifecycle/scheduler paths on enrolled nodes', async () => {
    await send(request());
    const response = await app.request('/api/v1/hermes/state?hermesBin=/tmp/custom-program', { headers: { 'x-node-token': 'fixture-node-key' } });
    expect(response.status).toBe(409);
    for (const path of ['/hermes/install', '/hermes/update', '/hermes/configure', '/codex/update', '/health/system-updates/enable', '/cron/sync'])
      expect((await send(request('denied', '{}', path))).status).toBe(409);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('cancels oversized response streams while retaining uncertain ownership', async () => {
    const cancelled = vi.fn(); let pulls = 0;
    execute.mockImplementation(async () => new Response(new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel: cancelled,
    })));
    expect((await send(request())).status).toBe(409);
    expect(cancelled).toHaveBeenCalled(); expect(pulls).toBeLessThan(8);
    expect((await fixture.ledger.receipt('native-one'))?.state).toBe('unknown');
  });

  it('does not clear another admission lock when a concurrent finite command is rejected', async () => {
    let release!: () => void; let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    fixture.confirm.mockImplementation(async (_url, init) => {
      entered(); await new Promise<void>(resolve => { release = resolve; });
      return new Response(JSON.stringify({ success: true, data: { admitted: true, ...JSON.parse(init.body) } }));
    });
    const first = send(request()); await ready;
    const rejected = await app.request('/api/v1/commands/execute', { method: 'POST', headers: {
      'x-node-token': 'fixture-node-key', 'x-magnus-resource-claim': JSON.stringify(request().claim),
    }, body: '{}' });
    expect(rejected.status).toBe(409);
    expect((await app.request('/api/v1/files/write', { method: 'POST', headers: { 'x-node-token': 'fixture-node-key' } })).status).toBe(409);
    release(); expect((await first).status).toBe(200); expect(execute).toHaveBeenCalledTimes(1);
  });

  it('closes the first-reservation gap and persists authoritative enrollment across node restart', async () => {
    fixture.confirm.mockImplementation(async (_url, init) => new Response(JSON.stringify({ success: true,
      data: { ...JSON.parse(init.body), nodeId: 'fixture', enrolled: true, gateEnabled: false, allowedLegacy: false } })));
    const raw = () => app.request('/api/v1/files/write', { method: 'POST', headers: { 'x-node-token': 'fixture-node-key' } });
    expect((await raw()).status).toBe(409); expect(execute).not.toHaveBeenCalled();
    expect(await fixture.ledger.managedEnrollment()).toEqual({ version: 1, nodeId: 'fixture', nodeFqdn: 'fixture.lab' });
    fixture.ledger = new CommandLedger(root, { resultSecret: key, reconciliationSecret: '', nodeFqdn: 'fixture.lab' });
    fixture.confirm.mockReset().mockRejectedValue(new Error('offline'));
    expect((await raw()).status).toBe(409); expect(fixture.confirm).not.toHaveBeenCalled();
  });
  it('does not cache a prior unenrolled answer when central enrollment changes', async () => {
    const raw = () => app.request('/api/v1/files/write', { method: 'POST', headers: { 'x-node-token': 'fixture-node-key' } });
    expect((await raw()).status).toBe(200);
    fixture.confirm.mockImplementation(async (_url, init) => new Response(JSON.stringify({ success: true,
      data: { ...JSON.parse(init.body), nodeId: 'fixture', enrolled: true, gateEnabled: false, allowedLegacy: false } })));
    expect((await raw()).status).toBe(409); expect(execute).toHaveBeenCalledTimes(1);
  });
  it.each(['unavailable', 'stale', 'contradictory'])('denies legacy admission on %s authority evidence', async mode => {
    fixture.confirm.mockImplementation(async (_url, init) => {
      if (mode === 'unavailable') throw new Error('offline');
      return new Response(JSON.stringify({ success: true, data: { ...JSON.parse(init.body),
        ...(mode === 'stale' ? { nonce: '00000000-0000-4000-8000-000000000000' } : {}),
        nodeId: 'fixture', enrolled: mode === 'contradictory', gateEnabled: false, allowedLegacy: true } }));
    });
    const response = await app.request('/api/v1/files/write', { method: 'POST', headers: { 'x-node-token': 'fixture-node-key' } });
    expect(response.status).toBe(409); expect(execute).not.toHaveBeenCalled();
  });
  it('blocks first enrollment while a pre-enrollment authorization is still in flight', async () => {
    let release!: () => void; let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    fixture.confirm.mockImplementation(async (_url, init) => {
      entered(); await new Promise<void>(resolve => { release = resolve; });
      return new Response(JSON.stringify({ success: true, data: { ...JSON.parse(init.body),
        nodeId: 'fixture', enrolled: false, gateEnabled: false, allowedLegacy: true } }));
    });
    const legacy = app.request('/api/v1/files/write', { method: 'POST', headers: { 'x-node-token': 'fixture-node-key' } }); await ready;
    expect((await send(request())).status).toBe(409);
    release(); expect((await legacy).status).toBe(200); expect(execute).toHaveBeenCalledTimes(1);
  });

  it('denies legacy mutation while global enrollment is enabled without inventing sticky node history', async () => {
    fixture.confirm.mockImplementation(async (_url, init) => new Response(JSON.stringify({ success: true, data: {
      ...JSON.parse(init.body), nodeId: 'fixture', enrolled: false, gateEnabled: true, allowedLegacy: false,
    } })));
    const response = await app.request('/api/v1/files/write', { method: 'POST', headers: { 'x-node-token': 'fixture-node-key' } });
    expect(response.status).toBe(409); expect(execute).not.toHaveBeenCalled(); expect(await fixture.ledger.managedEnrollment()).toBeNull();
  });
  it('runs the actual file handler only through its exact managed owner once enrolled', async () => {
    const { fileRoutes } = await import('./file-sync-executor.js');
    app = new Hono(); app.use('/api/v1/*', nodeAuthMiddleware); app.use('/api/v1/*', managedMutationGuard);
    app.route('/api/v1/files', fileRoutes); registerManagedHttp(app);
    const filePath = join(root, 'actual-file.txt');
    const response = await send(request('actual-file', JSON.stringify({ filePath, content: 'owned-write' })));
    expect(response.status).toBe(200); expect(await readFile(filePath, 'utf8')).toBe('owned-write');
    expect((await app.request('/api/v1/files/write', { method: 'POST', headers: {
      'x-node-token': 'fixture-node-key', 'content-type': 'application/json',
    }, body: JSON.stringify({ filePath, content: 'bypass' }) })).status).toBe(409);
    expect(await readFile(filePath, 'utf8')).toBe('owned-write');
  });

  it('adopts a crash-after-publish receipt and returns the same response on later exact replay', async () => {
    const skillsRoot = join(root, 'skills'); vi.stubEnv('SKILLS_DIR', skillsRoot);
    const { skillRoutes } = await import('./skill-manager.js');
    app = new Hono(); app.use('/api/v1/*', nodeAuthMiddleware); app.use('/api/v1/*', managedMutationGuard);
    app.route('/api/v1/skills', skillRoutes); registerManagedHttp(app);
    const publication = skillPublicationBody(); const { bundleSha256 } = publication;
    const input = request('skill-crash', JSON.stringify(publication), '/skills/install');
    const original = fixture.ledger.execute.bind(fixture.ledger);
    const executeSpy = vi.spyOn(fixture.ledger, 'execute').mockImplementationOnce((identity, run, enrollment) =>
      original(identity, async digest => { await run(digest); throw new Error('lost after atomic rename'); }, enrollment));
    expect((await send(input)).status).toBe(409);
    expect(await readFile(join(skillsRoot, 'crash-skill', '1.0.0', 'manifest.json'), 'utf8'))
      .toBe(Buffer.from(publication.bundle.entries[0]!.contentBase64, 'base64').toString('utf8'));
    expect((await fixture.ledger.receipt(input.commandId))?.state).toBe('unknown');
    const recovered = await send({ ...input, recoveryOnly: true }); expect(recovered.status).toBe(200); const recoveredBody = await recovered.json();
    expect(fixture.confirm.mock.calls.some(call => String(call[0]).endsWith('/resource-leases/recovery-claim'))).toBe(true);
    expect(recoveredBody.data.response.status).toBe(200);
    expect(JSON.parse(recoveredBody.data.response.body).data).toMatchObject({ bundleSha256, commandId: input.commandId });
    expect((await fixture.ledger.receipt(input.commandId))?.state).toBe('completed');
    const replay = await send({ ...input, recoveryOnly: true }); expect(replay.status).toBe(200);
    expect((await replay.json()).data.response).toEqual(recoveredBody.data.response);
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it('terminalizes exact no-effect recovery when the node crashed before its first ledger receipt', async () => {
    const skillsRoot = join(root, 'pre-ledger-skills'); vi.stubEnv('SKILLS_DIR', skillsRoot);
    const input = { ...request('before-ledger', JSON.stringify(skillPublicationBody('2.0.0')), '/skills/install'), recoveryOnly: true as const };
    expect(await fixture.ledger.receipt(input.commandId)).toBeNull();
    const response = await send(input); expect(response.status).toBe(200); const envelope = await response.json();
    expect(envelope.data.response.status).toBe(409);
    expect(JSON.parse(envelope.data.response.body)).toMatchObject({ error: { code: 'SKILL_PUBLICATION_NOT_COMMITTED' },
      data: { commandId: input.commandId, effect: 'none' } });
    expect(verifyCommandResult(envelope.data.receipt, key)).toBe(true);
    expect((await fixture.ledger.receipt(input.commandId))?.state).toBe('completed');
    expect(execute).not.toHaveBeenCalled();
    expect(fixture.confirm.mock.calls.every(call => !String(call[0]).endsWith('/resource-leases/claim'))).toBe(true);
    expect(fixture.confirm.mock.calls.some(call => String(call[0]).endsWith('/resource-leases/recovery-claim'))).toBe(true);
    const replay = await send(input); expect(replay.status).toBe(200);
    expect((await replay.json()).data.response).toEqual(envelope.data.response);
  });

  it('uses typed no-effect evidence when a skill lease expires after ledger admission but before its handler', async () => {
    const skillsRoot = join(root, 'expired-skills'); vi.stubEnv('SKILLS_DIR', skillsRoot);
    const input = request('expired-skill', JSON.stringify(skillPublicationBody('3.0.0')), '/skills/install');
    const original = fixture.ledger.execute.bind(fixture.ledger);
    const admission = vi.spyOn(fixture.ledger, 'execute').mockImplementation((identity, run, enrollment) =>
      original(identity, async digest => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(input.coordination.expiresAt + 1);
        try { return await run(digest); } finally { clock.mockRestore(); }
      }, enrollment));
    try {
      const response = await send(input); expect(response.status).toBe(200); const envelope = await response.json();
      expect(envelope.data.response.status).toBe(409);
      expect(JSON.parse(envelope.data.response.body)).toMatchObject({ error: { code: 'SKILL_PUBLICATION_NOT_COMMITTED' },
        data: { commandId: input.commandId, effect: 'none' } });
      expect((await fixture.ledger.receipt(input.commandId))?.state).toBe('completed');
      expect(execute).not.toHaveBeenCalled();
    } finally { admission.mockRestore(); }
  });

  it('recovers the byte-identical signed no-effect result after staged cancellation response loss without handler replay', async () => {
    const skillsRoot = join(root, 'cancelled-skills'); const controller = new AbortController();
    const { skillInstallHandler } = await import('./skill-manager.js');
    let boundaryCalls = 0;
    app = new Hono(); app.use('/api/v1/*', nodeAuthMiddleware); app.use('/api/v1/*', managedMutationGuard);
    app.post('/api/v1/skills/install', skillInstallHandler({ skillsDir: skillsRoot, publicationHooks: {
      beforeVisibility: () => { boundaryCalls++; controller.abort(); },
    } })); registerManagedHttp(app);
    const publication = skillPublicationBody('3.1.0');
    const input = request('cancelled-skill', JSON.stringify(publication), '/skills/install');
    const expectedBody = JSON.stringify({ success: false, error: { code: 'SKILL_PUBLICATION_NOT_COMMITTED',
      message: 'The interrupted publication committed no visible skill version' }, data: { skillName: publication.skillName,
      version: publication.version, bundleSha256: publication.bundleSha256, commandId: input.commandId,
      requestSha256: commandRequestDigest({ ...httpIdentity(input.commandId, input.method, input.path, input.body, input.timeoutSeconds),
        coordination: input.coordination }), effect: 'none' } });
    let lostResult: Awaited<ReturnType<Parameters<CommandLedger['execute']>[1]>> | undefined;
    const original = fixture.ledger.execute.bind(fixture.ledger);
    const execution = vi.spyOn(fixture.ledger, 'execute').mockImplementationOnce((identity, run, enrollment) =>
      original(identity, async digest => { lostResult = await run(digest); throw new Error('lost cancellation response'); }, enrollment));
    const lost = await sendWithSignal(input, controller.signal); expect(lost.status).toBe(409);
    expect(boundaryCalls).toBe(1);
    expect(lostResult?.stdout).toBe(httpReceiptBody('POST', '/skills/install', 409, expectedBody));
    expect((await fixture.ledger.receipt(input.commandId))?.state).toBe('unknown');
    expect(await readdir(skillsRoot)).not.toContain(publication.skillName);
    vi.stubEnv('SKILLS_DIR', skillsRoot);
    const recovered = await send({ ...input, recoveryOnly: true }); expect(recovered.status, await recovered.clone().text()).toBe(200);
    const envelope = await recovered.json(); expect(envelope.data.response).toEqual({ status: 409, body: expectedBody });
    expect(verifyCommandResult(envelope.data.receipt, key)).toBe(true);
    expect(envelope.data.receipt.stdout).toBe(lostResult?.stdout);
    expect(boundaryCalls).toBe(1); expect(execution).toHaveBeenCalledTimes(1);
    expect((await fixture.ledger.receipt(input.commandId))?.state).toBe('completed');
    expect((await readdir(skillsRoot)).filter(name => name.startsWith('.skill-publish-'))).toEqual([]);
  });

  it('rejects recovery-only on every non-skill shape before authority or execution', async () => {
    const wrongRoute = { ...request('wrong-recovery'), recoveryOnly: true as const };
    expect((await send(wrongRoute)).status).toBe(400);
    const falseFlag = { ...request('false-recovery', JSON.stringify(skillPublicationBody('4.0.0')), '/skills/install'), recoveryOnly: false };
    expect((await app.request('http://localhost/api/v1/commands/managed-http', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-node-token': 'fixture-node-key' }, body: JSON.stringify(falseFlag) })).status).toBe(400);
    expect(fixture.confirm).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });

});
