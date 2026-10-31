/** Actual built CLI in the npm-installed directory layout, no network or job effects. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ManagedScheduler, makeCronJob } from './managed-scheduler.js';
let root: string; let installed: string; let runner: string; let store: ManagedScheduler;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'installed-managed-cron-'));
  installed = join(root, 'node_modules/@hivemagnus/magnus-agent');
  await mkdir(installed, { recursive: true });
  await cp(resolve('dist'), join(installed, 'dist'), { recursive: true });
  await writeFile(join(installed, 'package.json'), '{"type":"module"}');
  for (const dependency of ['dotenv', 'zod', 'undici']) await symlink(resolve('../../node_modules', dependency), join(root, 'node_modules', dependency));
  await writeFile(join(root, '.env'), 'HOST_FQDN=installed.fixture.invalid\nMAGNUS_EXECUTION_SUPERVISOR_ENABLED=false\nNODE_MANAGER_SECRET=installed-node-fixture-secret\nRESULT_SIGNING_SECRET=installed-result-fixture-secret-at-least-32\n', { mode: 0o600 });
  runner = join(installed, 'dist/executors/scheduler-runner.js');
  store = new ManagedScheduler(join(root, '.magnus/managed-scheduler'));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function seed() {
  const job = makeCronJob({ nodeFqdn: 'installed.fixture.invalid', name: 'installed-probe', revision: 1,
    schedule: '* * * * *', timezone: 'UTC', command: '/usr/bin/false', timeoutSeconds: 3600, expiresAt: Date.now() + 3_600_000 });
  await store.locked(() => store.saveJob(job)); return job;
}
async function run(id: string) {
  return new Promise<{ code: number | string; stdout: string; stderr: string }>(resolveResult => {
    execFile(process.execPath, [runner, 'trigger', id, '1'], { timeout: 10_000, maxBuffer: 64 * 1024,
      env: { PATH: '/usr/bin:/bin', MAGNUS_EXECUTION_SUPERVISOR_ENABLED: 'true', CONTROL_API_URL: 'https://must-not-contact.invalid',
        AGENT_INSTALL_DIR: '/must-not-write', NODE_MANAGER_SECRET: 'fixture-stale-inherited-credential' } },
    (error, stdout, stderr) => resolveResult({ code: error?.code ?? 0, stdout, stderr }));
  });
}
describe('installed managed scheduler entrypoint', () => {
  it('loads stable installation environment and stores disabled occurrence outside package replacement tree', async () => {
    const job = await seed(); const result = await run(job.jobId);
    expect(result.code).toBe(1); expect(result.stderr).toBe('');
    const summary = JSON.parse(result.stdout); expect(summary.state).toBe('unknown');
    const occurrence = await store.occurrence(summary.occurrenceId);
    expect(occurrence?.admission).toBeUndefined(); // Disabled locally before any API request.
    expect(occurrence?.command.command).toBe('/usr/bin/false');
    await expect(readFile(join(installed, '.magnus/managed-scheduler', 'occurrence-' + summary.occurrenceId + '.json'))).rejects.toThrow();
  });
  it('refuses inherited or package-local authority when the stable installed environment is absent', async () => {
    const job = await seed(); await rm(join(root, '.env'));
    await writeFile(join(installed, '.env'), 'MAGNUS_EXECUTION_SUPERVISOR_ENABLED=false\n');
    const result = await run(job.jobId); expect(result.code).toBe(1); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Installed scheduler environment is unavailable');
    expect((await store.inventory()).occurrences).toHaveLength(0);
  });
});
