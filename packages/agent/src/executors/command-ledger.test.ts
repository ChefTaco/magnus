import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { signCommandResult, commandReconciliationSigningPayload } from '../security/command-result-signature.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandLedger, commandRequestDigest, type CommandIdentity } from './command-ledger.js';

const authority = { resultSecret: 'test-result-key-longer-than-thirty-two-bytes', reconciliationSecret: 'test-reconciliation-key-longer-than-thirty-two-bytes', nodeFqdn: 'fixture.lab' };
let root: string;
let ledger: CommandLedger;
const input = (id = 'command-1', fence?: string): CommandIdentity => ({
  commandId: id, command: 'fixture', args: [], timeoutSeconds: 10,
  ...(fence ? { coordination: { version: 1, resourceKey: 'node:fixture', fence, expiresAt: Date.now() + 60_000 } } : {}),
});
function result(request: CommandIdentity, digest = commandRequestDigest(request)) {
  const value = { commandId: request.commandId, stdout: 'done', stderr: '', exitCode: 0, durationMs: 1,
    truncated: false, signature: 'a'.repeat(64),
    ...(request.coordination ? { coordination: { ...request.coordination, requestSha256: digest } } : {}) };
  return { ...value, signature: signCommandResult(value, authority.resultSecret) };
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'command-ledger-')); ledger = new CommandLedger(root, authority); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('durable node command admission', () => {
  it('replays the exact completed result after restart, without retaining raw input secrets', async () => {
    const request = { ...input(), environment: { SECRET: 'never-save-this-value' } };
    const run = vi.fn(async () => result(request));
    const first = await ledger.execute(request, run);
    expect(await new CommandLedger(root, authority).execute(request, run)).toEqual(first);
    expect(run).toHaveBeenCalledTimes(1);
    for (const name of await readdir(root)) {
      expect(await readFile(join(root, name), 'utf8')).not.toContain('never-save-this-value');
      expect((await stat(join(root, name))).mode & 0o077).toBe(0);
    }
  });
  it('rejects payload changes under an existing command ID', async () => {
    const request = input(); await ledger.execute(request, async () => result(request));
    const run = vi.fn();
    await expect(ledger.execute({ ...request, args: ['different'] }, run)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(run).not.toHaveBeenCalled();
  });
  it('serializes concurrent commands across ledger instances and keeps original running status on duplicate rejection', async () => {
    const request = input();
    let finish!: () => void, accepted!: () => void;
    const ready = new Promise<void>(resolve => { accepted = resolve; });
    const pending = ledger.execute(request, async () => { accepted(); await new Promise<void>(resolve => { finish = resolve; }); return result(request); });
    await ready;
    await expect(ledger.execute(request, vi.fn())).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect((await ledger.receipt(request.commandId))?.state).toBe('running');
    await expect(new CommandLedger(root, authority).execute(input('command-2'), vi.fn())).rejects.toMatchObject({ code: 'RESOURCE_BUSY' });
    finish(); await pending;
    const next = input('command-2'); await expect(ledger.execute(next, async () => result(next))).resolves.toMatchObject({ commandId: next.commandId });
  });
  it('retains uncertain effects across restart and refuses both replay and another command', async () => {
    const request = input();
    await expect(ledger.execute(request, async () => { throw new Error('lost after side effect'); })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    const restarted = new CommandLedger(root, authority);
    expect((await restarted.receipt(request.commandId))?.state).toBe('unknown');
    const run = vi.fn();
    await expect(restarted.execute(request, run)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    await expect(restarted.execute(input('other'), run)).rejects.toMatchObject({ code: 'RESOURCE_BUSY' });
    expect(run).not.toHaveBeenCalled();
  });
  it('rejects expired and stale resource fences before the effect, preserving high water across restart', async () => {
    const first = input('first', '7'); await ledger.execute(first, async () => result(first));
    const run = vi.fn(); const expired = input('expired', '9'); expired.coordination!.expiresAt = Date.now() - 1;
    for (const [request, code] of [[expired, 'LEASE_EXPIRED'], [input('stale', '6'), 'STALE_FENCE'], [input('same', '7'), 'STALE_FENCE']] as const) {
      await expect(new CommandLedger(root, authority).execute(request, run)).rejects.toMatchObject({ code });
    }
    expect(run).not.toHaveBeenCalled();
    const next = input('next', '8'); await expect(ledger.execute(next, async () => result(next))).resolves.toMatchObject({ commandId: 'next' });
  });
  it('does not consume a fence when its lease has already expired', async () => {
    const expired = input('expired', '9'); expired.coordination!.expiresAt = Date.now() - 1;
    await expect(ledger.execute(expired, vi.fn())).rejects.toMatchObject({ code: 'LEASE_EXPIRED' });
    const next = input('valid', '1'); await ledger.execute(next, async () => result(next));
  });
  it('leaves a mismatched result uncertain instead of making it replayable', async () => {
    const request = input('fenced', '1');
    await expect(ledger.execute(request, async () => result(request, 'b'.repeat(64)))).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect((await ledger.receipt(request.commandId))?.state).toBe('unknown');
  });
  it('fails closed on corrupt durable results', async () => {
    const request = input(); await ledger.execute(request, async () => result(request));
    const filename = join(root, `receipt-${createHash('sha256').update(request.commandId).digest('hex')}.json`);
    const row = JSON.parse(await readFile(filename, 'utf8')); row.result.exitCode = 'fake';
    await writeFile(filename, JSON.stringify(row));
    const run = vi.fn();
    await expect(ledger.execute(request, run)).rejects.toMatchObject({ code: 'LEDGER_UNAVAILABLE' });
    expect(run).not.toHaveBeenCalled();
  });
  it('canonicalizes environment ordering and binds all execution inputs', () => {
    const request = { ...input(), environment: { z: '1', a: '2' } };
    expect(commandRequestDigest(request)).toBe(commandRequestDigest({ ...request, environment: { a: '2', z: '1' } }));
    for (const patch of [{ command: 'other' }, { args: ['x'] }, { timeoutSeconds: 11 }, { workingDirectory: '/tmp' }, { environment: { z: '2' } }]) {
      expect(commandRequestDigest({ ...request, ...patch })).not.toBe(commandRequestDigest(request));
    }
  });
});

function assertion(request: CommandIdentity, patch: Record<string, unknown> = {}) {
  const value = { nodeFqdn: authority.nodeFqdn, commandId: request.commandId,
    requestSha256: commandRequestDigest(request), coordination: request.coordination,
    disposition: 'effects_verified' as const, evidenceSha256: 'e'.repeat(64),
    approvalRef: 'telegram:approved-decision-1', decisionId: 'decision-1', expiresAt: Date.now() + 60_000, ...patch };
  return { ...value, signature: createHmac('sha256', authority.reconciliationSecret)
    .update(commandReconciliationSigningPayload(value)).digest('hex') };
}

describe('explicit uncertain-command reconciliation', () => {
  it('requires separately signed evidence, preserves the original command tombstone, and permits new work', async () => {
    const request = input('uncertain', '10');
    await expect(ledger.execute(request, async () => { throw new Error('lost result'); })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    const decision = assertion(request);
    expect(await ledger.reconcile(decision)).toMatchObject({ state: 'reconciled', reconciliation: decision });
    const restarted = new CommandLedger(root, authority);
    expect(await restarted.reconcile(decision)).toMatchObject({ state: 'reconciled' });
    await expect(restarted.execute(request, vi.fn())).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    await expect(restarted.reconcile(assertion(request, { decisionId: 'another-decision' }))).rejects.toMatchObject({ code: 'INVALID_RECONCILIATION' });
    const next = input('new-work', '11');
    await expect(restarted.execute(next, async () => result(next))).resolves.toMatchObject({ commandId: next.commandId });
    expect(await restarted.receipt(request.commandId)).toMatchObject({ state: 'reconciled', reconciliation: decision });
  });

  it('cannot reconcile a live process, even with valid operator attestation', async () => {
    const request = input(); let resolve!: () => void, started!: () => void;
    const ready = new Promise<void>(r => { started = r; });
    const pending = ledger.execute(request, async () => { started(); await new Promise<void>(r => { resolve = r; }); return result(request); });
    await ready;
    try { await expect(new CommandLedger(root, authority).reconcile(assertion(request))).rejects.toMatchObject({ code: 'RESOURCE_BUSY' }); }
    finally { resolve(); await pending; }
  });

  it.each([
    { nodeFqdn: 'other.lab' }, { requestSha256: 'b'.repeat(64) }, { expiresAt: 1 },
    { expiresAt: 8_000_000_000_000 }, { coordination: undefined },
    { coordination: { version: 1, resourceKey: 'node:other', fence: '12', expiresAt: Date.now() + 60_000 } },
  ])('rejects signed but mismatched or expired evidence: %j', async patch => {
    const request = input('uncertain', '12');
    await expect(ledger.execute(request, async () => { throw new Error('uncertain'); })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    await expect(ledger.reconcile(assertion(request, patch))).rejects.toMatchObject({ code: 'INVALID_RECONCILIATION' });
    expect((await ledger.receipt(request.commandId))?.state).toBe('unknown');
    await expect(ledger.execute(input('unrelated'), vi.fn())).rejects.toMatchObject({ code: 'RESOURCE_BUSY' });
  });

  it('does not accept a result-signing key as reconciliation authority or a forged receipt result', async () => {
    const request = input();
    await expect(ledger.execute(request, async () => { throw new Error('lost'); })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    const value = assertion(request);
    value.signature = createHmac('sha256', authority.resultSecret).update(commandReconciliationSigningPayload(value)).digest('hex');
    await expect(ledger.reconcile(value)).rejects.toMatchObject({ code: 'INVALID_RECONCILIATION' });
    const missingKey = new CommandLedger(root, { ...authority, reconciliationSecret: '' });
    await expect(missingKey.reconcile(assertion(request))).rejects.toMatchObject({ code: 'INVALID_RECONCILIATION' });
    await ledger.reconcile(assertion(request, { disposition: 'no_effect_verified' }));
    const next = input('forged-result');
    await expect(ledger.execute(next, async () => ({ ...result(next), stdout: 'tampered' }))).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
  });
});

/** Real separate Node processes exercise the kernel lock and crash durability;
 * injected pauses occur precisely between durable protocol transitions. */
async function fixture(mode: 'prepared' | 'running' | 'completed' | 'contend', request: CommandIdentity) {
  const modulePath = fileURLToPath(new URL('./command-ledger.ts', import.meta.url));
  const signaturePath = fileURLToPath(new URL('../security/command-result-signature.ts', import.meta.url));
  const script = `
    import { CommandLedger } from ${JSON.stringify(modulePath)};
    import { signCommandResult } from ${JSON.stringify(signaturePath)};
    import { appendFile } from 'node:fs/promises';
    const authority = ${JSON.stringify(authority)}, request = ${JSON.stringify(request)};
    const ledger = new CommandLedger(${JSON.stringify(root)}, authority);
    const pause = async () => { process.send({ ready: true }); await new Promise(() => {}); };
    if (${JSON.stringify(mode)} === 'prepared') {
      const write = ledger.write.bind(ledger);
      ledger.write = async (name, value) => { if (name.startsWith('receipt-')) await pause(); return write(name, value); };
    }
    if (${JSON.stringify(mode)} === 'completed') ledger.releaseClaim = pause;
    if (${JSON.stringify(mode)} === 'contend') { process.send({ ready: true }); await new Promise(resolve => process.once('message', resolve)); }
    try {
      const value = await ledger.execute(request, async digest => {
        await appendFile(${JSON.stringify(join(root, 'effects'))}, request.commandId + '\\n', { mode: 0o600 });
        if (${JSON.stringify(mode)} === 'running') await pause();
        if (${JSON.stringify(mode)} === 'contend') await new Promise(resolve => setTimeout(resolve, 300));
        const r = {commandId: request.commandId, exitCode: 0, stdout: 'done', stderr: '', durationMs: 1, truncated: false,
          ...(request.coordination ? {coordination: {...request.coordination, requestSha256: digest}} : {})};
        return {...r, signature: signCommandResult(r, authority.resultSecret)};
      });
      process.send({ result: value });
    } catch(error) { process.send({ error: error.code }); }
    process.disconnect();
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => code === 0 || signal === 'SIGKILL' ? resolve() : reject(new Error(stderr || `Fixture exited ${code}`)));
  });
  // Keep an observed rejection handler while callers wait for the IPC checkpoint.
  void exited.catch(() => {});
  await Promise.race([new Promise<void>(resolve => child.once('message', () => resolve())),
    exited.then(() => { throw new Error('Fixture exited before checkpoint'); })]);
  return { child, exited };
}

describe('crash and cross-process execution recovery', () => {
  it.each(['prepared', 'completed'] as const)('recovers a proven %s claim after SIGKILL without replaying effects', async mode => {
    const request = input('crashed-' + mode);
    const { child, exited } = await fixture(mode, request);
    child.kill('SIGKILL'); await exited;
    const next = input('after-crash');
    await expect(new CommandLedger(root, authority).execute(next, async () => result(next))).resolves.toMatchObject({ commandId: next.commandId });
    if (mode === 'completed') {
      const run = vi.fn();
      await expect(ledger.execute(request, run)).resolves.toMatchObject({ commandId: request.commandId });
      expect(run).not.toHaveBeenCalled();
      expect(await readFile(join(root, 'effects'), 'utf8')).toBe(request.commandId + '\n');
    } else expect(await ledger.receipt(request.commandId)).toBe(null);
  }, 15_000);

  it('keeps an effectful crash fenced until reviewed reconciliation, regardless of dead PID', async () => {
    const request = input('crashed-running', '1');
    const { child, exited } = await fixture('running', request);
    child.kill('SIGKILL'); await exited;
    const restarted = new CommandLedger(root, authority);
    expect((await restarted.receipt(request.commandId))?.state).toBe('unknown');
    await expect(restarted.execute(input('after-crash', '2'), vi.fn())).rejects.toMatchObject({ code: 'RESOURCE_BUSY' });
    expect(await readFile(join(root, 'effects'), 'utf8')).toBe(request.commandId + '\n');
    await restarted.reconcile(assertion(request));
    const next = input('after-review', '2');
    await expect(restarted.execute(next, async () => result(next))).resolves.toMatchObject({ commandId: next.commandId });
    await expect(restarted.execute(request, vi.fn())).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
  }, 15_000);

  it('admits exactly one of concurrent independent processes', async () => {
    const workers = await Promise.all([1, 2, 3, 4].map(i => fixture('contend', input('race-' + i))));
    const outcomes = workers.map(({ child }) => new Promise<Record<string, unknown>>(resolve => child.once('message', resolve)));
    for (const { child } of workers) child.send('go');
    const results = await Promise.all(outcomes); await Promise.all(workers.map(w => w.exited));
    expect(results.filter(r => r['result'])).toHaveLength(1);
    expect(results.filter(r => r['error'] === 'RESOURCE_BUSY')).toHaveLength(3);
    expect((await readFile(join(root, 'effects'), 'utf8')).trim().split('\n')).toHaveLength(1);
  }, 15_000);
});
