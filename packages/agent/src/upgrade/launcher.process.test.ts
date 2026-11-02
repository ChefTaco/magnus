import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const LAUNCHER = resolve(import.meta.dirname, '..', '..', 'launcher', 'launcher.mjs');

function fakeVersion(dir: string, version: string, body: string): void {
  const dist = join(dir, 'versions', version, 'node_modules', '@hivemagnus', 'magnus-agent', 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.js'), body);
}

function installDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'magnus-launcher-'));
  mkdirSync(join(dir, 'launcher'));
  cpSync(LAUNCHER, join(dir, 'launcher', 'launcher.mjs'));
  return dir;
}

const state = (dir: string) => JSON.parse(readFileSync(join(dir, 'upgrade-state.json'), 'utf8')) as Record<string, unknown>;

function runLauncher(dir: string, env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, [join(dir, 'launcher', 'launcher.mjs')], { env: { ...process.env, ...env }, stdio: 'ignore' });
    child.on('exit', code => resolvePromise(code));
  });
}

// End to end with real processes: a version that never confirms is replaced by
// the previous one once the confirmation window closes.
describe('launcher process', () => {
  it('reverts a version that never reports a heartbeat', async () => {
    const dir = installDir();
    fakeVersion(dir, '1.0.3', `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(dir, 'old-ran'))}, JSON.stringify({ launcher: process.env.MAGNUS_AGENT_LAUNCHER, dir: process.env.AGENT_INSTALL_DIR }));`);
    fakeVersion(dir, '1.1.0', 'setInterval(() => {}, 1000);');
    symlinkSync(join('versions', '1.1.0'), join(dir, 'current'));
    writeFileSync(join(dir, 'upgrade-state.json'), JSON.stringify({ state: 'staged', from: '1.0.3', to: '1.1.0', requestId: 'r', attempt: 0, maxAttempts: 2 }));

    const started = Date.now();
    expect(await runLauncher(dir, { MAGNUS_AGENT_UPGRADE_CONFIRM_SECONDS: '10' })).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
    expect(readlinkSync(join(dir, 'current'))).toBe(join('versions', '1.0.3'));
    expect(JSON.parse(readFileSync(join(dir, 'upgrade-state.json'), 'utf8'))).toMatchObject({ state: 'reverted', reason: expect.stringMatching(/no confirmed heartbeat/) });

    // systemd restarts the launcher, which now runs the previous version normally.
    // The child always gets the launcher's own directory.
    expect(await runLauncher(dir, { AGENT_INSTALL_DIR: '/opt/elsewhere' })).toBe(0);
    expect(existsSync(join(dir, 'old-ran'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'old-ran'), 'utf8'))).toEqual({ launcher: '1', dir });
  }, 40_000);

  it('extends the trial while the new version is alive but cannot reach the control API, then reports why it reverted', async () => {
    const dir = installDir();
    fakeVersion(dir, '1.0.3', '');
    fakeVersion(dir, '1.1.0', `import { writeFileSync } from 'node:fs';
const beat = () => writeFileSync(${JSON.stringify(join(dir, 'trial-alive.json'))}, JSON.stringify({ version: '1.1.0', at: Date.now(), error: 'connect ECONNREFUSED' }));
beat(); setInterval(beat, 1000);`);
    symlinkSync(join('versions', '1.1.0'), join(dir, 'current'));
    writeFileSync(join(dir, 'upgrade-state.json'), JSON.stringify({ state: 'staged', from: '1.0.3', to: '1.1.0', requestId: 'r', attempt: 0, maxAttempts: 2 }));
    const started = Date.now();
    expect(await runLauncher(dir, { MAGNUS_AGENT_UPGRADE_CONFIRM_SECONDS: '10' })).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(29_000);
    expect(readlinkSync(join(dir, 'current'))).toBe(join('versions', '1.0.3'));
    expect(state(dir)).toMatchObject({ state: 'reverted', attempt: 1, extended: 2, reason: expect.stringMatching(/^control API unreachable from 1\.1\.0 \(connect ECONNREFUSED\)/) });
  }, 60_000);

  it.skipIf(process.getuid?.() === 0)('starts the agent instead of crash-looping when the install directory is read-only', async () => {
    const dir = installDir();
    const outside = mkdtempSync(join(tmpdir(), 'magnus-launcher-out-'));
    for (const version of ['1.0.3', '1.1.0']) {
      fakeVersion(dir, version, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(outside, 'ran'))}, '${version}');`);
    }
    symlinkSync(join('versions', '1.1.0'), join(dir, 'current'));
    writeFileSync(join(dir, 'upgrade-state.json'), JSON.stringify({ state: 'staged', from: '1.0.3', to: '1.1.0', requestId: 'r' }));
    chmodSync(dir, 0o555);
    try {
      expect(await runLauncher(dir, {})).toBe(0);
    } finally {
      chmodSync(dir, 0o755);
    }
    // Neither the trial nor a switch back could be recorded: ./current runs, without a trial that could never revert.
    expect(readFileSync(join(outside, 'ran'), 'utf8')).toBe('1.1.0');
    expect(state(dir)).toMatchObject({ state: 'staged' });
  }, 20_000);

  it('falls back to last-good when the state file is unreadable and ./current keeps exiting', async () => {
    const dir = installDir();
    fakeVersion(dir, '1.0.3', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(dir, 'old-ran'))}, '1');`);
    fakeVersion(dir, '1.1.0', 'process.exit(3);');
    symlinkSync(join('versions', '1.1.0'), join(dir, 'current'));
    symlinkSync(join('versions', '1.0.3'), join(dir, 'last-good'));
    writeFileSync(join(dir, 'upgrade-state.json'), '{"state": "tri');
    expect(await runLauncher(dir, {})).toBe(3);
    expect(await runLauncher(dir, {})).toBe(3);
    expect(await runLauncher(dir, {})).toBe(0);
    expect(readlinkSync(join(dir, 'current'))).toBe(join('versions', '1.0.3'));
    expect(existsSync(join(dir, 'old-ran'))).toBe(true);
    expect(state(dir)).toMatchObject({ state: 'reverted' });
  }, 20_000);

  it('reports its protocol without starting anything', () => {
    const dir = installDir();
    expect(execFileSync(process.execPath, [join(dir, 'launcher', 'launcher.mjs'), '--protocol'], { encoding: 'utf8' }).trim()).toMatch(/^\d+$/);
  });
});
