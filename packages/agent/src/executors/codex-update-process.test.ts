import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionSupervisor, type SupervisorStatus } from './execution-supervisor.js';
import { runCodexUpdateWorker } from './codex-update-process.js';
import { managedExecution } from '../security/managed-context.js';
import { codexRoutes } from './codex-manager.js';

const target = { user: 'operator', home: '/home/operator', codexHome: '/home/operator/.codex', bin: '/usr/bin/codex' };
const completed: SupervisorStatus = {
  state: 'completed',
  evidence: { version: 1, commandId: 'fixture', requestSha256: 'a'.repeat(64), unit: 'fixture.service', bootId: 'fixture', deadline: 1, groupEmpty: true },
  result: { exitCode: 0, stdout: '{"installed":true}', stderr: '', durationMs: 1, truncated: false },
};
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('supervised Codex update', () => {
  it('requires explicit privileged supervision before starting a worker', async () => {
    const run = vi.spyOn(ExecutionSupervisor.prototype, 'run');
    vi.stubEnv('MAGNUS_AGENT_PRIVILEGED', 'false');
    vi.stubEnv('MAGNUS_EXECUTION_SUPERVISOR_ENABLED', 'true');
    await expect(runCodexUpdateWorker(target)).rejects.toThrow('require privileged mode');
    vi.stubEnv('MAGNUS_AGENT_PRIVILEGED', 'true');
    vi.stubEnv('MAGNUS_EXECUTION_SUPERVISOR_ENABLED', 'false');
    await expect(runCodexUpdateWorker(target)).rejects.toThrow('require privileged mode');
    expect(run).not.toHaveBeenCalled();
    vi.stubEnv('MAGNUS_AGENT_PRIVILEGED', 'false');
    const response = await codexRoutes.request('/update', { method: 'POST' });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('AGENT_NOT_PRIVILEGED');
    vi.stubEnv('MAGNUS_AGENT_PRIVILEGED', 'true');
    vi.stubEnv('MAGNUS_EXECUTION_SUPERVISOR_ENABLED', 'false');
    const disabled = await codexRoutes.request('/update', { method: 'POST' });
    expect(disabled.status).toBe(409);
    expect((await disabled.json()).error.code).toBe('CODEX_UPDATE_SUPERVISOR_REQUIRED');
    expect(run).not.toHaveBeenCalled();
  });

  it('binds a single worker to the managed request, excludes credentials and waits for completion', async () => {
    vi.stubEnv('MAGNUS_AGENT_PRIVILEGED', 'true');
    vi.stubEnv('MAGNUS_EXECUTION_SUPERVISOR_ENABLED', 'true');
    vi.stubEnv('OPENAI_API_KEY', 'fixture-must-not-inherit');
    let release: (value: SupervisorStatus) => void = () => {};
    const run = vi.spyOn(ExecutionSupervisor.prototype, 'run').mockReturnValue(new Promise(resolve => { release = resolve; }));
    const context = { commandId: 'native-fixture', requestSha256: 'b'.repeat(64),
      claim: { leaseId: 'lease', nodeId: 'fixture', nodeFqdn: 'node-1.example.com' },
      coordination: { version: 1 as const, resourceKey: 'node:fixture', fence: '1', expiresAt: Date.now() + 900_000 } };
    let settled = false;
    const pending = managedExecution.run(context, () => runCodexUpdateWorker(target)).then(value => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    const input = run.mock.calls[0]![0];
    expect(input.commandId).toMatch(/^codex-update-[a-f0-9]{64}$/);
    expect(input.coordination).toEqual(context.coordination);
    expect(input.environment).toEqual({ HOME: target.home, CODEX_USER: target.user, CODEX_HOME: target.codexHome, CODEX_BIN: target.bin });
    expect(JSON.stringify(input)).not.toContain('fixture-must-not-inherit');
    expect(input.args[0]).toContain('codex-update-worker.js');
    release(completed);
    expect(await pending).toBe(completed.result!.stdout);
    run.mockResolvedValue(completed);
    await managedExecution.run(context, () => runCodexUpdateWorker(target));
    expect(run.mock.calls[1]![0]).toEqual(input);
    // The supervisor's shell sees exactly two literal argv elements.
    expect(execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${input.command} ${input.args.join(' ')}`], { encoding: 'utf8' }).trim().split('\n'))
      .toEqual(['/usr/bin/node', expect.stringContaining('codex-update-worker.js')]);
  });

  it.each([
    { ...completed, state: 'unknown' as const },
    { ...completed, state: 'running' as const },
    { ...completed, evidence: { ...completed.evidence, groupEmpty: false } },
    { ...completed, result: undefined },
  ])('refuses uncertain or incomplete process evidence without replay', async (observation) => {
    vi.stubEnv('MAGNUS_AGENT_PRIVILEGED', 'true');
    vi.stubEnv('MAGNUS_EXECUTION_SUPERVISOR_ENABLED', 'true');
    const run = vi.spyOn(ExecutionSupervisor.prototype, 'run').mockResolvedValue(observation);
    await expect(runCodexUpdateWorker(target)).rejects.toThrow('completion is uncertain');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not report a terminated or failed updater as a successful install', async () => {
    vi.stubEnv('MAGNUS_AGENT_PRIVILEGED', 'true');
    vi.stubEnv('MAGNUS_EXECUTION_SUPERVISOR_ENABLED', 'true');
    vi.spyOn(ExecutionSupervisor.prototype, 'run').mockResolvedValue({ ...completed, result: { ...completed.result!, exitCode: 124 } });
    await expect(runCodexUpdateWorker(target)).rejects.toThrow('exit 124');
  });
});
