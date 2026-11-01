import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const LAUNCHER = resolve(import.meta.dirname, '..', '..', 'launcher', 'launcher.mjs');

function fakeVersion(dir: string, version: string, body: string): void {
  const dist = join(dir, 'versions', version, 'node_modules', '@hivemagnus', 'magnus-agent', 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.js'), body);
}

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
    const dir = mkdtempSync(join(tmpdir(), 'magnus-launcher-'));
    mkdirSync(join(dir, 'launcher'));
    cpSync(LAUNCHER, join(dir, 'launcher', 'launcher.mjs'));
    fakeVersion(dir, '1.0.3', `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(dir, 'old-ran'))}, process.env.MAGNUS_AGENT_LAUNCHER ?? '');`);
    fakeVersion(dir, '1.1.0', 'setInterval(() => {}, 1000);');
    symlinkSync(join('versions', '1.1.0'), join(dir, 'current'));
    writeFileSync(join(dir, 'upgrade-state.json'), JSON.stringify({ state: 'staged', from: '1.0.3', to: '1.1.0', requestId: 'r', attempt: 0, maxAttempts: 2 }));

    const started = Date.now();
    expect(await runLauncher(dir, { MAGNUS_AGENT_UPGRADE_CONFIRM_SECONDS: '10' })).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
    expect(readlinkSync(join(dir, 'current'))).toBe(join('versions', '1.0.3'));
    expect(JSON.parse(readFileSync(join(dir, 'upgrade-state.json'), 'utf8'))).toMatchObject({ state: 'reverted', reason: expect.stringMatching(/no confirmed heartbeat/) });

    // systemd restarts the launcher, which now runs the previous version normally.
    expect(await runLauncher(dir, {})).toBe(0);
    expect(existsSync(join(dir, 'old-ran'))).toBe(true);
    expect(readFileSync(join(dir, 'old-ran'), 'utf8')).toBe('1');
  }, 40_000);
});
