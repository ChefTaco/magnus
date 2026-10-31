import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { COMMAND_COMPLETION_REGISTRY_SHA256 } from '../security/command-completion-registry.js';
const fixture = vi.hoisted(() => ({ run: vi.fn(), status: vi.fn() }));
vi.mock('./execution-supervisor.js', () => ({ ExecutionSupervisor: class { run = fixture.run; status = fixture.status; } }));
vi.mock('../tls.js', () => ({ controlApiFetch: async (_url: string, init: RequestInit) => new Response(JSON.stringify({ success: true, data: {
  ...JSON.parse(init.body as string), nodeId: 'fixture', enrolled: false, gateEnabled: false, allowedLegacy: true,
} })) }));
let root: string;
const owner = { version: 1 as const, registrySha256: COMMAND_COMPLETION_REGISTRY_SHA256, descriptorId: 'diagnostics-uptime-v1' };
const input = { commandId: 'original', command: '/usr/bin/uptime', args: [], timeoutSeconds: 60,
  coordination: { version: 1 as const, resourceKey: 'node:fixture', fence: '1', expiresAt: 4_102_444_800_000 } };
const identity = () => ({ nodeId: 'fixture', nodeFqdn: 'fixture.lab', epoch: 1, barrierId: randomUUID() });
beforeEach(async () => {
  vi.resetModules(); fixture.run.mockReset(); fixture.status.mockReset();
  root = await mkdtemp(join(tmpdir(), 'mutation-command-recovery-'));
  vi.stubEnv('AGENT_INSTALL_DIR', root); vi.stubEnv('HOST_FQDN', 'fixture.lab');
  vi.stubEnv('RESULT_SIGNING_SECRET', 'mutation-recovery-independent-result-key-32');
  vi.stubEnv('MAGNUS_EXECUTION_SUPERVISOR_ENABLED', 'true');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
async function native() {
  const executor = await import('./command-executor.js');
  const { managedMutationGuard } = await import('./managed-http.js');
  const { mutationBarrier } = await import('./mutation-barrier.js');
  const app = new Hono(); app.use('/api/v1/*', managedMutationGuard); app.route('/api/v1/commands', executor.commandRoutes);
  return { app, executor, barrier: mutationBarrier };
}
async function beginUnknown() {
  const { commandRequestDigest } = await import('./command-ledger.js'); const digest = commandRequestDigest(input);
  fixture.run.mockResolvedValue({ state: 'unknown', evidence: { requestSha256: digest } });
  const original = await native();
  const response = await original.app.request('/api/v1/commands/execute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  expect(response.status).toBe(409); expect(fixture.run).toHaveBeenCalledTimes(1);
  return { ...original, digest };
}
function completed(digest: string) {
  fixture.status.mockResolvedValue({ state: 'completed', evidence: { requestSha256: digest, completionOwner: owner },
    result: { exitCode: 0, stdout: 'original result', stderr: '', durationMs: 25, truncated: false } });
}

describe('original supervisor recovery settles exact legacy mutation ownership', () => {
  it('invalid command input settles a known no-dispatch request instead of leaving an unbound unknown', async () => {
    const { app, barrier } = await native();
    expect((await app.request('/api/v1/commands/execute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(400);
    const barrierIdentity = identity(); await barrier.drain(barrierIdentity);
    expect(await barrier.snapshot(barrierIdentity)).toMatchObject({ activeCount: 0, unknownCount: 0 });
    expect(fixture.run).not.toHaveBeenCalled();
  });
  it('uses real supervisor observation and retained unit evidence after lost launch acknowledgment', async () => {
    const { ExecutionSupervisor } = await vi.importActual<typeof import('./execution-supervisor.js')>('./execution-supervisor.js');
    const { writeJson } = await import('./execution-supervisor-state.js');
    let starts = 0; let populated = true;
    let unit: Record<string, string> | null = null;
    let unitName = '';
    const backend = {
      probe: async () => ({ bootId: 'fixture-original-boot' }),
      listUnits: async () => unitName ? [unitName] : [],
      async launch(intent: import('./execution-supervisor-state.js').ExecutionIntent, directory: string) {
        starts++; unitName = intent.unit;
        const ownerDigest = intent.completionOwner ? createHash('sha256').update(JSON.stringify(intent.completionOwner)).digest('hex') : '';
        unit = { LoadState: 'loaded', ActiveState: 'active', SubState: 'exited', InvocationID: 'a'.repeat(32),
          Description: 'Magnus execution ' + intent.nonce + ' ' + intent.requestSha256 + (ownerDigest ? ' ' + ownerDigest : ''), ControlGroup: '',
          ExecMainCode: '1', ExecMainStatus: '0', Result: 'success', KillMode: 'control-group', ExitType: 'cgroup', RemainAfterExit: 'yes', Restart: 'no' };
        await writeJson(directory, 'started.json', { version: 1, nonce: intent.nonce, requestSha256: intent.requestSha256,
          invocationId: 'a'.repeat(32), cgroup: '/fixture/' + intent.unit, startedAt: Date.now() });
        await writeJson(directory, 'result.json', { version: 1, nonce: intent.nonce, requestSha256: intent.requestSha256,
          invocationId: 'a'.repeat(32), exitCode: 0, stdout: 'original-only', stderr: '', durationMs: 1, truncated: false });
        throw Error('launch acknowledgement lost');
      },
      inspect: async () => unit ? { ...unit } : null,
      empty: async () => !populated,
      signal: async () => { throw Error('No signals allowed in observation test'); },
    };
    const options = { root: join(root, 'supervised'), backend, workerDirectory: resolve('dist/executors'), pollMs: 10 };
    const supervisor = new ExecutionSupervisor(options);
    fixture.run.mockImplementation((value, completionOwner) => supervisor.run(value, completionOwner));
    const original = await native();
    expect((await original.app.request('/api/v1/commands/execute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })).status).toBe(409);
    vi.resetModules(); const restarted = await native();
    const recoveredSupervisor = new ExecutionSupervisor(options);
    fixture.status.mockImplementation((id, digest) => recoveredSupervisor.status(id, digest));
    const barrierIdentity = identity(); await restarted.barrier.drain(barrierIdentity);
    expect((await restarted.executor.recoverCommandReceipt(input.commandId))?.state).toBe('unknown');
    expect(await restarted.barrier.snapshot(barrierIdentity)).toMatchObject({ unknownCount: 1 });
    populated = false;
    expect((await restarted.executor.recoverCommandReceipt(input.commandId))?.state).toBe('completed');
    expect(await restarted.barrier.snapshot(barrierIdentity)).toMatchObject({ activeCount: 0, unknownCount: 0 });
    expect(await restarted.executor.commandLedger.drainSnapshot()).toMatchObject({ activeCount: 0, unknownCount: 0 });
    expect(starts).toBe(1); expect(fixture.run).toHaveBeenCalledTimes(1);
  });
  it('after requester restart adopts original completion and clears both inventories without another run', async () => {
    const { digest } = await beginUnknown();
    const files = await readdir(join(root, '.magnus/mutation-barrier'));
    const journal = JSON.parse(await readFile(join(root, '.magnus/mutation-barrier', files.find(f => f.startsWith('request-'))!), 'utf8'));
    expect(journal).toMatchObject({ state: 'unknown', commandBinding: { commandId: input.commandId, requestSha256: digest } });
    expect(JSON.stringify(journal)).not.toContain('/bin/true');
    vi.resetModules(); const restarted = await native(); const barrierIdentity = identity();
    await restarted.barrier.drain(barrierIdentity);
    expect(await restarted.barrier.snapshot(barrierIdentity)).toMatchObject({ unknownCount: 1 });
    completed(digest);
    const receipt = await restarted.app.request('/api/v1/commands/receipts/original');
    expect(receipt.status).toBe(200); expect((await receipt.json()).data.state).toBe('completed');
    expect(await restarted.executor.commandLedger.drainSnapshot()).toMatchObject({ activeCount: 0, unknownCount: 0 });
    expect(await restarted.barrier.snapshot(barrierIdentity)).toMatchObject({ activeCount: 0, unknownCount: 0 });
    await restarted.executor.recoverCommandReceipt('original');
    expect(fixture.run).toHaveBeenCalledTimes(1);
  });
  it('recovers crash after ledger adoption but before journal settlement', async () => {
    const { executor, barrier, digest } = await beginUnknown(); completed(digest);
    vi.spyOn(barrier, 'settleCompletedCommand').mockRejectedValueOnce(Error('interrupted after ledger fsync'));
    await executor.recoverCommandReceipt('original');
    expect((await executor.commandLedger.receipt('original'))?.state).toBe('completed');
    vi.resetModules(); const restarted = await native(); const barrierIdentity = identity();
    await restarted.barrier.drain(barrierIdentity);
    expect(await restarted.barrier.snapshot(barrierIdentity)).toMatchObject({ unknownCount: 1 });
    await restarted.executor.recoverCommandReceipt('original');
    expect(await restarted.barrier.snapshot(barrierIdentity)).toMatchObject({ unknownCount: 0 });
    expect(fixture.run).toHaveBeenCalledTimes(1);
  });
  it('does not clear changed input, arbitrary async work, or unavailable supervisor evidence', async () => {
    const { executor, barrier, digest } = await beginUnknown();
    const changed = await barrier.begin('POST', '/commands/execute', { ...input, args: ['changed'] }); await barrier.finish(changed, 'unknown');
    const arbitrary = await barrier.begin('POST', '/codex/device-auth'); await barrier.finish(arbitrary, 'unknown');
    const barrierIdentity = identity(); await barrier.drain(barrierIdentity);
    completed('0'.repeat(64)); await executor.recoverCommandReceipt('original');
    expect(await barrier.snapshot(barrierIdentity)).toMatchObject({ unknownCount: 3 });
    completed(digest); await executor.recoverCommandReceipt('original');
    expect(await barrier.snapshot(barrierIdentity)).toMatchObject({ unknownCount: 2 });
    expect(fixture.run).toHaveBeenCalledTimes(1);
  });
  it('a late original handler cannot replace independently proven completion with unknown', async () => {
    const { executor, barrier, digest } = await beginUnknown();
    const token = await barrier.begin('POST', '/commands/execute', input);
    completed(digest); await executor.recoverCommandReceipt('original');
    await barrier.finish(token, 'unknown');
    const barrierIdentity = identity(); await barrier.drain(barrierIdentity);
    expect(await barrier.snapshot(barrierIdentity)).toMatchObject({ activeCount: 0, unknownCount: 0 });
  });
});
