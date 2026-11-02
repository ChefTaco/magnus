import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_SECRET_ENV_KEYS } from '../utils/child-env.js';
import { installService, parseInstallServiceArgs, renderUnit } from './install-service.js';
import {
  adoptInstallOwner, ALIVE_FILE, confirmTrial, controlApiUnreachable, engineProblem, pointCurrentAt, readUpgradeState, recordTrialAlive, resolveNpm, runProcess, selfUpgradeStatus, stageUpgrade,
  STAGE_BUDGET_MS, tarballName, upgradeLauncher, writeUpgradeState, type Runner,
} from './self-upgrade.js';
import { stableCodePath } from './stable-path.js';

const minute = 60_000;
const asRoot = process.getuid?.() === 0;
const LAUNCHER = resolve(import.meta.dirname, '..', '..', 'launcher', 'launcher.mjs');

function fakeVersion(dir: string, version: string, manifest: Record<string, unknown> = {}): string {
  const pkg = join(dir, 'versions', version, 'node_modules', '@hivemagnus', 'magnus-agent');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(join(pkg, 'dist', 'index.js'), '');
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@hivemagnus/magnus-agent', version, ...manifest }));
  return pkg;
}

function versionedInstall(): string {
  const dir = mkdtempSync(join(tmpdir(), 'magnus-agent-install-'));
  fakeVersion(dir, '1.0.3');
  symlinkSync(join('versions', '1.0.3'), join(dir, 'current'));
  return dir;
}

const launcherEnv = (dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
  ({ AGENT_INSTALL_DIR: dir, MAGNUS_AGENT_LAUNCHER: '1', MAGNUS_AGENT_LAUNCHER_PROTOCOL: '1', MAGNUS_AGENT_NPM: 'npm', PATH: '/usr/bin:/bin', ...extra });

describe('self-upgrade status', () => {
  it('explains why an agent cannot upgrade itself', () => {
    const dir = versionedInstall();
    expect(selfUpgradeStatus('1.0.3', { AGENT_INSTALL_DIR: dir })).toMatchObject({ layout: 'legacy', enabled: false, reason: expect.stringMatching(/install-service/), confirmSeconds: null });
    expect(selfUpgradeStatus('1.0.3', launcherEnv(dir, { MAGNUS_AGENT_SELF_UPGRADE: 'false' }))).toMatchObject({ enabled: false, reason: expect.stringMatching(/MAGNUS_AGENT_SELF_UPGRADE=false/) });
    expect(selfUpgradeStatus('1.0.3', launcherEnv(dir, { MAGNUS_AGENT_CONTAINER: '1' }))).toMatchObject({ layout: 'container', enabled: false });
    expect(selfUpgradeStatus('1.0.3', launcherEnv(dir))).toMatchObject({ layout: 'versioned', enabled: true, launcherProtocol: 1, protocol: 1, confirmSeconds: 180 });
    expect(selfUpgradeStatus('1.0.3', launcherEnv(dir, { MAGNUS_AGENT_LAUNCHER_CONFIRM_SECONDS: '42' })).confirmSeconds).toBe(42);
  });

  it.skipIf(asRoot)('reports a staging directory or state file the agent cannot write', () => {
    const dir = versionedInstall();
    writeUpgradeState(dir, { state: 'confirmed', from: '1.0.2', to: '1.0.3', requestId: 'r' });
    chmodSync(join(dir, 'upgrade-state.json'), 0o400);
    expect(selfUpgradeStatus('1.0.3', launcherEnv(dir))).toMatchObject({ enabled: false, reason: expect.stringMatching(/cannot write .*upgrade-state\.json/) });
    chmodSync(join(dir, 'upgrade-state.json'), 0o600);
    mkdirSync(join(dir, 'staging'), { mode: 0o500 });
    expect(selfUpgradeStatus('1.0.3', launcherEnv(dir))).toMatchObject({ enabled: false, reason: expect.stringMatching(/cannot write .*staging/) });
    chmodSync(join(dir, 'staging'), 0o700);
  });

  it('keeps reasons inside the wire limits', () => {
    const dir = versionedInstall();
    writeUpgradeState(dir, { state: 'reverted', from: '1.0.3', to: '1.1.0', requestId: 'r', reason: 'x'.repeat(5000) });
    expect(selfUpgradeStatus('1.0.3', launcherEnv(dir)).upgrade?.reason?.length).toBe(500);
  });
});

describe('npm resolution', () => {
  const node = (npmVersion?: string) => {
    const root = mkdtempSync(join(tmpdir(), 'magnus-node-'));
    mkdirSync(join(root, 'bin'));
    if (npmVersion) {
      mkdirSync(join(root, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true });
      writeFileSync(join(root, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), '');
      writeFileSync(join(root, 'lib', 'node_modules', 'npm', 'package.json'), JSON.stringify({ version: npmVersion }));
    }
    return join(root, 'bin', 'node');
  };
  it('prefers the npm beside the running Node.js, run with that Node.js', () => {
    const execPath = node('11.6.0');
    expect(resolveNpm({ PATH: '/nonexistent' }, execPath)).toMatchObject({
      command: execPath, args: [join(execPath, '..', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')], version: '11.6.0', problem: null });
    expect(resolveNpm({ MAGNUS_AGENT_NPM: '/opt/npm/bin/npm' }, execPath)).toMatchObject({ command: '/opt/npm/bin/npm', args: [] });
  });
  it('reports a missing or too old npm', () => {
    expect(resolveNpm({ PATH: '/nonexistent' }, node('9.9.0')).problem).toMatch(/npm 9\.9\.0 .* older than/);
    expect(resolveNpm({ PATH: '/nonexistent' }, node()).problem).toMatch(/npm was not found/);
    const dir = versionedInstall();
    expect(selfUpgradeStatus('1.0.3', { ...launcherEnv(dir), MAGNUS_AGENT_NPM: undefined, PATH: '/nonexistent' }).enabled)
      .toBe(existsSync(join(process.execPath, '..', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')));
  });
});

describe('confirming a trial', () => {
  const onTrial = (extra: Record<string, unknown> = {}) => {
    const dir = versionedInstall();
    fakeVersion(dir, '1.0.2');
    fakeVersion(dir, '1.1.0');
    writeUpgradeState(dir, { state: 'trial', from: '1.0.3', to: '1.1.0', requestId: 'r1', attempt: 1, trialDeadline: '2026-11-01T00:03:00.000Z', ...extra });
    return dir;
  };
  const at = new Date('2026-11-01T00:01:00Z');
  const switchTo = (dir: string, version: string) => pointCurrentAt(dir, version);

  it('confirms on the first accepted heartbeat, records last-good and prunes old versions', () => {
    const dir = onTrial();
    switchTo(dir, '1.1.0');
    writeFileSync(join(dir, ALIVE_FILE), '{}');
    expect(confirmTrial('1.0.3', launcherEnv(dir), at)).toBe(false);
    expect(confirmTrial('1.1.0', launcherEnv(dir), at)).toBe(true);
    expect(readUpgradeState(dir)?.state).toBe('confirmed');
    expect(readlinkSync(join(dir, 'last-good'))).toBe(join('versions', '1.1.0'));
    expect(readdirSync(join(dir, 'versions')).sort()).toEqual(['1.0.3', '1.1.0']);
    expect(existsSync(join(dir, ALIVE_FILE))).toBe(false);
  });

  it('refuses once the trial window has closed or when ./current does not run the version', () => {
    const dir = onTrial();
    expect(confirmTrial('1.1.0', launcherEnv(dir), at)).toBe(false); // ./current still runs 1.0.3
    switchTo(dir, '1.1.0');
    expect(confirmTrial('1.1.0', launcherEnv(dir), new Date('2026-11-01T00:03:00Z'))).toBe(false);
    expect(readUpgradeState(dir)?.state).toBe('trial');
  });

  it('waits for the launcher\'s lock instead of racing a revert', () => {
    const dir = onTrial();
    switchTo(dir, '1.1.0');
    writeFileSync(join(dir, 'upgrade-state.lock'), String(process.ppid));
    expect(confirmTrial('1.1.0', launcherEnv(dir), at)).toBe(false);
    expect(readUpgradeState(dir)?.state).toBe('trial');
  });

  it('counts network errors and gateway errors as an unreachable control API, not rejections', () => {
    const http = (status: number) => Object.assign(new Error('HTTP'), { name: 'HTTPError', response: { status } });
    expect(controlApiUnreachable(new TypeError('fetch failed'))).toBe(true);
    expect(controlApiUnreachable(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))).toBe(true);
    expect(controlApiUnreachable(http(503))).toBe(true);
    expect(controlApiUnreachable(http(401))).toBe(false);
    expect(controlApiUnreachable(http(500))).toBe(false);
  });

  it('marks the trial alive only for the version on trial', () => {
    const dir = onTrial();
    expect(recordTrialAlive('1.0.3', 'fetch failed', launcherEnv(dir), 5)).toBe(false);
    expect(recordTrialAlive('1.1.0', 'fetch failed', launcherEnv(dir), 5)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, ALIVE_FILE), 'utf8'))).toEqual({ version: '1.1.0', requestId: 'r1', at: 5, error: 'fetch failed' });
  });

  it('installs the confirmed version\'s launcher only when it declares a higher protocol and passes its self-check', () => {
    const dir = versionedInstall();
    const pkg = fakeVersion(dir, '1.1.0');
    mkdirSync(join(pkg, 'launcher'));
    mkdirSync(join(dir, 'launcher'));
    const current = readFileSync(LAUNCHER, 'utf8');
    const old = current.replace(/^export const LAUNCHER_PROTOCOL = \d+;$/m, 'export const LAUNCHER_PROTOCOL = 1;');
    writeFileSync(join(dir, 'launcher', 'launcher.mjs'), old);
    // Same protocol: kept.
    writeFileSync(join(pkg, 'launcher', 'launcher.mjs'), old);
    expect(upgradeLauncher(dir, '1.1.0')).toBeNull();
    // Higher protocol but broken: kept.
    writeFileSync(join(pkg, 'launcher', 'launcher.mjs'), `${current}\nthis is not javascript(`);
    expect(() => upgradeLauncher(dir, '1.1.0')).toThrow(/self-check/);
    expect(readFileSync(join(dir, 'launcher', 'launcher.mjs'), 'utf8')).toBe(old);
    // Higher protocol: replaced, previous kept.
    writeFileSync(join(pkg, 'launcher', 'launcher.mjs'), current);
    expect(upgradeLauncher(dir, '1.1.0')).toMatch(/1 -> \d+/);
    expect(readFileSync(join(dir, 'launcher', 'launcher.mjs'), 'utf8')).toBe(current);
    expect(readFileSync(join(dir, 'launcher', 'launcher.mjs.previous'), 'utf8')).toBe(old);
  });
});

describe('staging an upgrade', () => {
  afterEach(() => { vi.useRealTimers(); });
  const tarball = (dir: string, version: string, content = 'agent tarball') => {
    const source = join(dir, 'source');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, tarballName(version)), content);
    return { source, integrity: `sha512-${createHash('sha512').update(content).digest('base64')}` };
  };
  interface Call { line: string; env: NodeJS.ProcessEnv; timeoutMs?: number }
  const fakeNpm = (calls: Call[], reportedVersion: string, options: { manifest?: Record<string, unknown>; hook?: (args: readonly string[]) => Partial<Awaited<ReturnType<Runner>>> | void } = {}): Runner =>
    async (command, args, runOptions) => {
      calls.push({ line: `${command === process.execPath ? 'node' : command} ${args.join(' ')}`, env: runOptions.env, timeoutMs: runOptions.timeoutMs });
      const override = options.hook?.(args);
      if (override) return { code: 0, stdout: '', stderr: '', ...override };
      if (args[0] === 'install') {
        const pkg = join(runOptions.cwd, 'node_modules', '@hivemagnus', 'magnus-agent');
        mkdirSync(join(pkg, 'dist'), { recursive: true });
        writeFileSync(join(pkg, 'dist', 'index.js'), '');
        writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: reportedVersion, engines: { node: '^24.0.0 || ^26.0.0' }, ...options.manifest }));
      }
      if (args.at(-1) === '--version') return { code: 0, stdout: `${reportedVersion}\n`, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
  const request = (version: string, integrity: string, requestId = 'req-1') => ({ version, integrity, requestId, packageName: '@hivemagnus/magnus-agent' });
  const secrets = Object.fromEntries(AGENT_SECRET_ENV_KEYS.map(key => [key, 'fixture-secret-value']));

  it('verifies, installs beside the running version, switches and records the trial', async () => {
    const dir = versionedInstall();
    mkdirSync(join(dir, 'staging', '0.9.9'), { recursive: true });
    writeFileSync(join(dir, 'staging', '0.9.9', 'leftover'), '');
    const { source, integrity } = tarball(dir, '1.1.0');
    const calls: Call[] = [];
    const result = await stageUpgrade({ request: request('1.1.0', integrity), version: '1.0.3', nodeVersion: '24.22.1',
      env: launcherEnv(dir, { MAGNUS_AGENT_UPGRADE_SOURCE_DIR: source, ...secrets }), run: fakeNpm(calls, '1.1.0') });
    expect(result).toMatchObject({ from: '1.0.3', to: '1.1.0' });
    expect(readlinkSync(join(dir, 'current'))).toBe(join('versions', '1.1.0'));
    expect(readUpgradeState(dir)).toMatchObject({ state: 'staged', from: '1.0.3', to: '1.1.0', requestId: 'req-1' });
    expect(calls.some(call => call.line.startsWith('npm audit signatures'))).toBe(true);
    expect(calls.filter(call => call.line.startsWith('npm')).every(call => call.line.includes('--fetch-timeout=60000'))).toBe(true);
    // No agent credentials reach npm, lifecycle scripts or the smoke test.
    for (const call of calls) for (const key of AGENT_SECRET_ENV_KEYS) expect(call.env[key]).toBeUndefined();
    expect(calls.every(call => typeof call.timeoutMs === 'number' && call.timeoutMs > 0)).toBe(true);
    expect(calls[0]!.env['npm_config_cache']).toBe(join(dir, 'staging', '1.1.0', '.npm'));
    expect(calls[0]!.env['PATH']?.startsWith(`${resolve(process.execPath, '..')}:`)).toBe(true);
    expect(existsSync(join(dir, 'staging', '1.1.0'))).toBe(false);
    expect(existsSync(join(dir, 'staging', '0.9.9'))).toBe(false);

    // The same request again (a retry after a lost reply): the current state, nothing changed.
    const again = await stageUpgrade({ request: request('1.1.0', integrity), version: '1.0.3', env: launcherEnv(dir, { MAGNUS_AGENT_UPGRADE_SOURCE_DIR: source }), run: fakeNpm([], '1.1.0') });
    expect(again).toMatchObject({ repeated: true, upgrade: { state: 'staged', requestId: 'req-1' } });
  });

  it('refuses a tarball whose integrity differs and leaves ./current alone', async () => {
    const dir = versionedInstall();
    const { source } = tarball(dir, '1.1.0');
    const other = `sha512-${createHash('sha512').update('something else').digest('base64')}`;
    await expect(stageUpgrade({ request: request('1.1.0', other, 'r'), version: '1.0.3', env: launcherEnv(dir, { MAGNUS_AGENT_UPGRADE_SOURCE_DIR: source }), run: fakeNpm([], '1.1.0') }))
      .rejects.toMatchObject({ code: 'SELF_UPGRADE_INTEGRITY' });
    expect(readlinkSync(join(dir, 'current'))).toBe(join('versions', '1.0.3'));
    expect(existsSync(join(dir, 'versions', '1.1.0'))).toBe(false);
  });

  it('refuses majors, downgrades, legacy layouts, a missing previous version and a second upgrade during a trial', async () => {
    const dir = versionedInstall();
    const { source, integrity } = tarball(dir, '2.0.0');
    const env = launcherEnv(dir, { MAGNUS_AGENT_UPGRADE_SOURCE_DIR: source });
    await expect(stageUpgrade({ request: request('2.0.0', integrity, 'r'), version: '1.0.3', env, run: fakeNpm([], '2.0.0') })).rejects.toMatchObject({ code: 'SELF_UPGRADE_REFUSED' });
    await expect(stageUpgrade({ request: request('1.0.2', integrity, 'r'), version: '1.0.3', env, run: fakeNpm([], '1.0.2') })).rejects.toMatchObject({ code: 'SELF_UPGRADE_REFUSED' });
    await expect(stageUpgrade({ request: request('1.1.0', integrity, 'r'), version: '1.0.3', env: { AGENT_INSTALL_DIR: dir }, run: fakeNpm([], '1.1.0') }))
      .rejects.toMatchObject({ code: 'SELF_UPGRADE_UNAVAILABLE' });
    await expect(stageUpgrade({ request: request('1.1.0', integrity, 'r'), version: '1.0.4', env, run: fakeNpm([], '1.1.0') }))
      .rejects.toMatchObject({ code: 'SELF_UPGRADE_UNAVAILABLE', message: expect.stringMatching(/versions\/1\.0\.4/) });
    writeUpgradeState(dir, { state: 'trial', from: '1.0.2', to: '1.0.3', requestId: 'r0' });
    await expect(stageUpgrade({ request: request('1.1.0', integrity, 'r'), version: '1.0.3', env, run: fakeNpm([], '1.1.0') })).rejects.toMatchObject({ code: 'SELF_UPGRADE_BUSY' });
  });

  it('refuses an install that does not report the requested version', async () => {
    const dir = versionedInstall();
    const { source, integrity } = tarball(dir, '1.1.0');
    await expect(stageUpgrade({ request: request('1.1.0', integrity, 'r'), version: '1.0.3',
      env: launcherEnv(dir, { MAGNUS_AGENT_UPGRADE_SOURCE_DIR: source, MAGNUS_AGENT_UPGRADE_REQUIRE_PROVENANCE: 'false' }), run: fakeNpm([], '1.0.9') }))
      .rejects.toThrow(/reports "1\.0\.9"/);
    expect(readlinkSync(join(dir, 'current'))).toBe(join('versions', '1.0.3'));
  });

  it('refuses a release for another Node.js or a newer launcher before switching', async () => {
    const dir = versionedInstall();
    const { source, integrity } = tarball(dir, '1.1.0');
    const env = launcherEnv(dir, { MAGNUS_AGENT_UPGRADE_SOURCE_DIR: source });
    await expect(stageUpgrade({ request: request('1.1.0', integrity, 'a'), version: '1.0.3', nodeVersion: '22.1.0', env, run: fakeNpm([], '1.1.0') }))
      .rejects.toMatchObject({ code: 'SELF_UPGRADE_ENGINE', status: 422, message: expect.stringMatching(/requires Node\.js .* runs 22\.1\.0/) });
    await expect(stageUpgrade({ request: request('1.1.0', integrity, 'b'), version: '1.0.3', nodeVersion: '24.22.1', env,
      run: fakeNpm([], '1.1.0', { manifest: { magnusAgent: { minLauncher: 5 } } }) }))
      .rejects.toMatchObject({ code: 'SELF_UPGRADE_LAUNCHER', status: 422, message: expect.stringMatching(/launcher protocol 5; this node runs 1/) });
    expect(readlinkSync(join(dir, 'current'))).toBe(join('versions', '1.0.3'));
    expect(readUpgradeState(dir)).toBeNull();
    expect(engineProblem('>=22 <27', '20.0.0')).toBeNull(); // forms the checker cannot judge are not refused
  });

  it('times out a hung step, clears staging and accepts the next request', async () => {
    const dir = versionedInstall();
    const { source, integrity } = tarball(dir, '1.1.0');
    const env = launcherEnv(dir, { MAGNUS_AGENT_UPGRADE_SOURCE_DIR: source });
    await expect(stageUpgrade({ request: request('1.1.0', integrity, 'a'), version: '1.0.3', nodeVersion: '24.22.1', env,
      run: fakeNpm([], '1.1.0', { hook: args => (args[0] === 'install' ? { code: 143, timedOut: true } : undefined) }) }))
      .rejects.toMatchObject({ code: 'SELF_UPGRADE_TIMEOUT', message: expect.stringMatching(/npm install did not finish/) });
    expect(existsSync(join(dir, 'staging', '1.1.0'))).toBe(false);
    expect(readlinkSync(join(dir, 'current'))).toBe(join('versions', '1.0.3'));
    await expect(stageUpgrade({ request: request('1.1.0', integrity, 'b'), version: '1.0.3', nodeVersion: '24.22.1', env, run: fakeNpm([], '1.1.0') }))
      .resolves.toMatchObject({ to: '1.1.0' });
  });

  it('stops when the total budget is used up', async () => {
    const dir = versionedInstall();
    const { source, integrity } = tarball(dir, '1.1.0');
    let clock = 0;
    const calls: Call[] = [];
    const slow: Runner = async (command, args, options) => { clock += 7 * minute; return fakeNpm(calls, '1.1.0')(command, args, options); };
    await expect(stageUpgrade({ request: request('1.1.0', integrity), version: '1.0.3', nodeVersion: '24.22.1', clock: () => clock,
      env: launcherEnv(dir, { MAGNUS_AGENT_UPGRADE_SOURCE_DIR: source }), run: slow }))
      .rejects.toMatchObject({ code: 'SELF_UPGRADE_TIMEOUT', message: expect.stringMatching(/budget before the installed agent/) });
    expect(calls[0]!.timeoutMs).toBeLessThanOrEqual(STAGE_BUDGET_MS);
  });

  it('records failed, not staged, when ./current cannot be switched', async () => {
    const dir = versionedInstall();
    const { source, integrity } = tarball(dir, '1.1.0');
    // A non-empty directory where the temporary link goes makes the switch fail.
    mkdirSync(join(dir, `current.${process.pid}.tmp`, 'blocker'), { recursive: true });
    await expect(stageUpgrade({ request: request('1.1.0', integrity), version: '1.0.3', nodeVersion: '24.22.1',
      env: launcherEnv(dir, { MAGNUS_AGENT_UPGRADE_SOURCE_DIR: source }), run: fakeNpm([], '1.1.0') }))
      .rejects.toMatchObject({ code: 'SELF_UPGRADE_FAILED', message: expect.stringMatching(/switching \.\/current/) });
    expect(readUpgradeState(dir)).toMatchObject({ state: 'failed', to: '1.1.0' });
    expect(readlinkSync(join(dir, 'current'))).toBe(join('versions', '1.0.3'));
    expect(existsSync(join(dir, 'versions', '1.1.0'))).toBe(false);
  });
});

describe('running upgrade steps', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('kills the whole process group when a step times out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const dir = mkdtempSync(join(tmpdir(), 'magnus-run-'));
    const marker = join(dir, 'grandchild.pid');
    const pending = runProcess('/bin/sh', ['-c', `sleep 60 & echo $! > ${marker}; wait`], { cwd: dir, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 1_000 });
    while (!existsSync(marker) || readFileSync(marker, 'utf8').trim() === '') await new Promise(resolvePromise => setImmediate(resolvePromise));
    const grandchild = Number(readFileSync(marker, 'utf8'));
    vi.advanceTimersByTime(1_000);
    const result = await pending;
    expect(result.timedOut).toBe(true);
    let alive = true;
    for (let index = 0; index < 200 && alive; index++) {
      try { process.kill(grandchild, 0); await new Promise(resolvePromise => setImmediate(resolvePromise)); } catch { alive = false; }
    }
    expect(alive).toBe(false);
  });
});

describe('install-service', () => {
  it('parses options and renders a launcher unit for both modes', () => {
    const options = parseInstallServiceArgs(['--unprivileged', '--dir', '/opt/magnus-agent', '--dry-run'], {});
    expect(options).toMatchObject({ unprivileged: true, user: 'magnus-agent', dryRun: true, dir: '/opt/magnus-agent' });
    const unit = renderUnit({ dir: '/opt/magnus-agent', unprivileged: true, user: 'magnus-agent', nodePath: '/usr/bin/node' });
    expect(unit).toMatch(/^ExecStart=\/usr\/bin\/node \/opt\/magnus-agent\/launcher\/launcher\.mjs$/m);
    expect(unit).toMatch(/^Restart=always$/m);
    expect(unit).toMatch(/^User=magnus-agent$/m);
    expect(unit).toMatch(/^ReadWritePaths=\/opt\/magnus-agent$/m);
    expect(renderUnit({ dir: '/opt/magnus-agent', unprivileged: false, user: 'x', nodePath: '/usr/bin/node' })).not.toMatch(/^User=/m);
    expect(() => parseInstallServiceArgs(['--bogus'], {})).toThrow(/unknown option/);
  });
  it('links last-good and hands root-owned upgrade leftovers to the service account', async () => {
    const dir = versionedInstall();
    mkdirSync(join(dir, 'staging'));
    writeUpgradeState(dir, { state: 'confirmed', from: '1.0.2', to: '1.0.3', requestId: 'r' });
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await installService(['--dry-run', '--unprivileged', '--no-start', '--dir', dir, '--unit', join(dir, 'unit.service')])).toBe(0);
    } finally { log.mockRestore(); warn.mockRestore(); }
    expect(lines.join('\n')).toMatch(/link .*last-good to the running version/);
    expect(existsSync(join(dir, 'last-good'))).toBe(false); // dry run
  });
});

describe('offline source directory', async () => {
  const { sourceOverrides } = await import('./self-upgrade.js');
  it('uses sibling @hivemagnus tarballs from the source directory instead of the registry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magnus-agent-source-'));
    for (const file of ['hivemagnus-magnus-agent-1.1.1-ci.tgz', 'hivemagnus-magnus-contracts-1.1.0.tgz', 'notes.txt']) writeFileSync(join(dir, file), '');
    expect(sourceOverrides(dir, join(dir, 'hivemagnus-magnus-agent-1.1.1-ci.tgz')))
      .toEqual({ '@hivemagnus/magnus-contracts': `file:${join(dir, 'hivemagnus-magnus-contracts-1.1.0.tgz')}` });
  });
});

describe('stable code paths and install ownership', () => {
  function layout(withLink: boolean) {
    const dir = mkdtempSync(join(tmpdir(), 'agent-stable-'));
    mkdirSync(join(dir, 'versions', '1.1.0', 'node_modules', 'pkg', 'dist'), { recursive: true });
    symlinkSync(join('versions', '1.1.0'), join(dir, 'current'), 'dir');
    if (withLink) symlinkSync(join('current', 'node_modules'), join(dir, 'node_modules'), 'dir');
    return dir;
  }
  const code = (dir: string) => join(dir, 'versions', '1.1.0', 'node_modules', 'pkg', 'dist', 'runner.js');

  it('keeps the pre-launcher node_modules path when the compatibility link exists', () => {
    const dir = layout(true);
    expect(stableCodePath(code(dir), { MAGNUS_AGENT_LAUNCHER: '1', AGENT_INSTALL_DIR: dir }))
      .toBe(join(dir, 'node_modules', 'pkg', 'dist', 'runner.js'));
  });
  it('goes through ./current without the link, and leaves other paths alone', () => {
    const dir = layout(false);
    expect(stableCodePath(code(dir), { MAGNUS_AGENT_LAUNCHER: '1', AGENT_INSTALL_DIR: dir }))
      .toBe(join(dir, 'current', 'node_modules', 'pkg', 'dist', 'runner.js'));
    expect(stableCodePath(code(dir), { AGENT_INSTALL_DIR: dir })).toBe(code(dir));
    expect(stableCodePath('/usr/lib/x.js', { MAGNUS_AGENT_LAUNCHER: '1', AGENT_INSTALL_DIR: dir })).toBe('/usr/lib/x.js');
  });
  it('hands written files to the install owner only when running as root', () => {
    const dir = layout(false);
    // As "root" in a directory this (non-root) account owns, chown to that owner is a permitted no-op change.
    expect(() => adoptInstallOwner(dir, join(dir, 'versions'), 0)).not.toThrow();
    expect(() => adoptInstallOwner(dir, join(dir, 'missing'), 0)).not.toThrow();
    expect(() => adoptInstallOwner(dir, join(dir, 'versions'), 1000)).not.toThrow();
  });
});
