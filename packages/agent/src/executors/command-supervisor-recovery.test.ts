import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMAND_COMPLETION_REGISTRY_SHA256 } from '../security/command-completion-registry.js';
const fixture = vi.hoisted(() => ({ run: vi.fn(), status: vi.fn() }));
vi.mock('./execution-supervisor.js', () => ({ ExecutionSupervisor: class { run = fixture.run; status = fixture.status; } }));
let root: string;
const key = 'supervisor-recovery-result-signing-fixture-32';
const owner = { version: 1 as const, registrySha256: COMMAND_COMPLETION_REGISTRY_SHA256, descriptorId: 'diagnostics-uptime-v1' };
const registered = (commandId: string) => ({ commandId, command: '/usr/bin/uptime', args: [], timeoutSeconds: 60,
  coordination: { version: 1 as const, resourceKey: 'node:fixture', fence: '1', expiresAt: 4_102_444_800_000 } });
beforeEach(async () => {
  vi.resetModules(); fixture.run.mockReset(); fixture.status.mockReset();
  root = await mkdtemp(join(tmpdir(), 'supervisor-adoption-'));
  vi.stubEnv('AGENT_INSTALL_DIR', root); vi.stubEnv('RESULT_SIGNING_SECRET', key); vi.stubEnv('MAGNUS_EXECUTION_SUPERVISOR_ENABLED', 'true');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
describe('command ledger adoption of supervised execution', () => {
  it('adopts original completion after uncertainty without calling run again', async () => {
    const { executeCommand, recoverCommandReceipt, commandLedger } = await import('./command-executor.js');
    const { commandRequestDigest } = await import('./command-ledger.js');
    const { verifyCommandResult } = await import('../security/command-result-signature.js');
    const input = registered('original');
    const digest = commandRequestDigest(input);
    fixture.run.mockResolvedValue({ state: 'unknown', evidence: { requestSha256: digest } });
    await expect(executeCommand(input)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    fixture.status.mockResolvedValue({ state: 'running', evidence: { requestSha256: digest, completionOwner: owner } });
    expect((await recoverCommandReceipt(input.commandId))?.state).toBe('unknown');
    await expect(executeCommand(input)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    fixture.status.mockResolvedValue({ state: 'completed', evidence: { requestSha256: digest, completionOwner: owner },
      result: { exitCode: 0, stdout: 'original result', stderr: '', durationMs: 30, truncated: false } });
    const recovered = await recoverCommandReceipt(input.commandId);
    expect(recovered?.state).toBe('completed'); expect(verifyCommandResult(recovered!.result!, key)).toBe(true);
    expect((await commandLedger.drainSnapshot()).unknownCount).toBe(0);
    expect((await executeCommand(input)).stdout).toBe('original result'); expect(fixture.run).toHaveBeenCalledTimes(1);
  });
  it('retains ownership when recovered identity differs or evidence is unavailable', async () => {
    const { executeCommand, recoverCommandReceipt, commandLedger } = await import('./command-executor.js');
    const input = registered('uncertain');
    fixture.run.mockResolvedValue({ state: 'unknown', evidence: {} });
    await expect(executeCommand(input)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    fixture.status.mockResolvedValue({ state: 'completed', evidence: { requestSha256: '0'.repeat(64) },
      result: { exitCode: 0, stdout: '', stderr: '', durationMs: 1, truncated: false } });
    expect((await recoverCommandReceipt(input.commandId))?.state).toBe('unknown');
    fixture.status.mockRejectedValue(new Error('systemd unavailable'));
    expect((await recoverCommandReceipt(input.commandId))?.state).toBe('unknown');
    expect(await commandLedger.drainSnapshot()).toMatchObject({ activeCount: 0, unknownCount: 1 });
    await expect(executeCommand({ ...registered('replacement'), coordination: { ...input.coordination, fence: '2' } })).rejects.toMatchObject({ code: 'RESOURCE_BUSY' });
    expect(fixture.run).toHaveBeenCalledTimes(1);
  });
  it('never adopts completion produced under a different completion registry', async () => {
    const { executeCommand, recoverCommandReceipt, commandLedger } = await import('./command-executor.js');
    const { commandRequestDigest } = await import('./command-ledger.js');
    const input = registered('registry-drift');
    const digest = commandRequestDigest(input);
    fixture.run.mockResolvedValue({ state: 'unknown', evidence: { requestSha256: digest } });
    await expect(executeCommand(input)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    fixture.status.mockResolvedValue({ state: 'completed', evidence: { requestSha256: digest,
      completionOwner: { ...owner, registrySha256: '0'.repeat(64) } },
      result: { exitCode: 0, stdout: 'stale policy', stderr: '', durationMs: 1, truncated: false } });
    expect((await recoverCommandReceipt(input.commandId))?.state).toBe('unknown');
    expect((await commandLedger.drainSnapshot()).unknownCount).toBe(1);
    expect(fixture.run).toHaveBeenCalledTimes(1);
  });
  it('signs only independently completed supervisor results on the original path', async () => {
    const { executeCommand } = await import('./command-executor.js');
    const { commandRequestDigest } = await import('./command-ledger.js');
    const input = registered('completed');
    fixture.run.mockResolvedValue({ state: 'completed', evidence: { requestSha256: commandRequestDigest(input), completionOwner: owner },
      result: { exitCode: 0, stdout: '', stderr: '', durationMs: 15, truncated: false } });
    expect(await executeCommand(input)).toMatchObject({ commandId: input.commandId, exitCode: 0 });
    expect((await executeCommand(input)).exitCode).toBe(0); expect(fixture.run).toHaveBeenCalledTimes(1);
    expect(fixture.run).toHaveBeenCalledWith(input, owner);
  });

  it.each([
    ['an external-service command', { command: '/usr/bin/systemctl', args: ['restart', 'fixture.service'] }],
    ['a plain shell command', { command: 'uptime -p', args: [] }],
    ['a registered command without its fence', { coordination: undefined }],
  ])('refuses %s before the ledger claim and never starts a unit', async (_name, change) => {
    const { executeCommand, commandLedger } = await import('./command-executor.js');
    const input = { ...registered('unregistered'), ...change };
    await expect(executeCommand(input)).rejects.toMatchObject({ code: 'UNREGISTERED_COMMAND', notStarted: true });
    expect(fixture.run).not.toHaveBeenCalled();
    expect(await commandLedger.receipt(input.commandId)).toBeNull();
    expect(await commandLedger.drainSnapshot()).toMatchObject({ activeCount: 0, unknownCount: 0 });
    // The id stays free: nothing local refers to it, so the refusal is a certain one.
    expect(await commandLedger.commandTrace(input.commandId)).toMatchObject({ receipt: false, activeLock: false });
  });

});
