import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// The launcher is plain JavaScript so it runs without dependencies.
import { confirmSeconds, decideLaunch } from '../../launcher/launcher.mjs';
import { parseInstallServiceArgs, renderUnit } from './install-service.js';
import { confirmTrial, readUpgradeState, selfUpgradeStatus, stageUpgrade, tarballName, writeUpgradeState, type Runner } from './self-upgrade.js';

const minute = 60_000;

describe('launcher decision', () => {
  const now = Date.parse('2026-11-01T00:00:00Z');
  it('runs normally without an upgrade in progress', () => {
    expect(decideLaunch(null, now, 3 * minute)).toEqual({ action: 'run', next: null, trial: false });
    expect(decideLaunch({ state: 'confirmed', from: '1.0.3', to: '1.1.0' }, now, minute).action).toBe('run');
  });
  it('starts a staged version on trial with a deadline', () => {
    const decision = decideLaunch({ state: 'staged', from: '1.0.3', to: '1.1.0', attempt: 0, maxAttempts: 2 }, now, 3 * minute);
    expect(decision).toMatchObject({ action: 'run', trial: true, next: { state: 'trial', attempt: 1, trialDeadline: '2026-11-01T00:03:00.000Z' } });
  });
  it('retries a crash once, then reverts', () => {
    const trial = { state: 'trial', from: '1.0.3', to: '1.1.0', attempt: 1, maxAttempts: 2, trialDeadline: '2026-11-01T00:03:00.000Z' };
    expect(decideLaunch(trial, now, 3 * minute)).toMatchObject({ action: 'run', trial: true, next: { attempt: 2 } });
    expect(decideLaunch({ ...trial, attempt: 2 }, now, 3 * minute)).toMatchObject({ action: 'revert', next: { state: 'reverted' } });
  });
  it('reverts once the deadline passes without a confirmation', () => {
    const trial = { state: 'trial', from: '1.0.3', to: '1.1.0', attempt: 1, maxAttempts: 2, trialDeadline: '2026-10-31T23:59:00.000Z' };
    expect(decideLaunch(trial, now, 3 * minute)).toMatchObject({ action: 'revert', reason: expect.stringMatching(/no confirmed heartbeat/) });
  });
  it('bounds the confirmation window', () => {
    expect(confirmSeconds({})).toBe(180);
    expect(confirmSeconds({ MAGNUS_AGENT_UPGRADE_CONFIRM_SECONDS: '5' })).toBe(180);
    expect(confirmSeconds({ MAGNUS_AGENT_UPGRADE_CONFIRM_SECONDS: '20' })).toBe(20);
  });
});

function versionedInstall(): string {
  const dir = mkdtempSync(join(tmpdir(), 'magnus-agent-install-'));
  mkdirSync(join(dir, 'versions', '1.0.3'), { recursive: true });
  symlinkSync(join('versions', '1.0.3'), join(dir, 'current'));
  return dir;
}

const launcherEnv = (dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
  ({ AGENT_INSTALL_DIR: dir, MAGNUS_AGENT_LAUNCHER: '1', MAGNUS_AGENT_LAUNCHER_PROTOCOL: '1', ...extra });

describe('self-upgrade status', () => {
  it('explains why an agent cannot upgrade itself', () => {
    const dir = versionedInstall();
    expect(selfUpgradeStatus('1.0.3', { AGENT_INSTALL_DIR: dir })).toMatchObject({ layout: 'legacy', enabled: false, reason: expect.stringMatching(/install-service/) });
    expect(selfUpgradeStatus('1.0.3', launcherEnv(dir, { MAGNUS_AGENT_SELF_UPGRADE: 'false' }))).toMatchObject({ enabled: false, reason: expect.stringMatching(/MAGNUS_AGENT_SELF_UPGRADE=false/) });
    expect(selfUpgradeStatus('1.0.3', launcherEnv(dir, { MAGNUS_AGENT_CONTAINER: '1' }))).toMatchObject({ layout: 'container', enabled: false });
    expect(selfUpgradeStatus('1.0.3', launcherEnv(dir))).toMatchObject({ layout: 'versioned', enabled: true, launcherProtocol: 1, protocol: 1 });
  });

  it('confirms a trial on the first accepted heartbeat and prunes old versions', () => {
    const dir = versionedInstall();
    mkdirSync(join(dir, 'versions', '1.0.2'));
    mkdirSync(join(dir, 'versions', '1.1.0'));
    writeUpgradeState(dir, { state: 'trial', from: '1.0.3', to: '1.1.0', requestId: 'r1', attempt: 1 });
    expect(confirmTrial('1.0.3', launcherEnv(dir))).toBe(false);
    expect(confirmTrial('1.1.0', launcherEnv(dir))).toBe(true);
    expect(readUpgradeState(dir)?.state).toBe('confirmed');
    expect(existsSync(join(dir, 'versions', '1.0.2'))).toBe(false);
    expect(existsSync(join(dir, 'versions', '1.0.3'))).toBe(true);
  });
});

describe('staging an upgrade', () => {
  const tarball = (dir: string, version: string, content = 'agent tarball') => {
    const source = join(dir, 'source');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, tarballName(version)), content);
    return { source, integrity: `sha512-${createHash('sha512').update(content).digest('base64')}` };
  };
  const fakeNpm = (calls: string[], reportedVersion: string): Runner => async (command, args, options) => {
    calls.push(`${command === process.execPath ? 'node' : command} ${args.join(' ')}`);
    if (args[0] === 'install') {
      const entry = join(options.cwd, 'node_modules', '@hivemagnus', 'magnus-agent', 'dist');
      mkdirSync(entry, { recursive: true });
      writeFileSync(join(entry, 'index.js'), '');
    }
    if (args.at(-1) === '--version') return { code: 0, stdout: `${reportedVersion}\n`, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };

  it('verifies, installs beside the running version, switches and records the trial', async () => {
    const dir = versionedInstall();
    const { source, integrity } = tarball(dir, '1.1.0');
    const calls: string[] = [];
    const result = await stageUpgrade({ request: { version: '1.1.0', integrity, requestId: 'req-1', packageName: '@hivemagnus/magnus-agent' },
      version: '1.0.3', env: launcherEnv(dir, { MAGNUS_AGENT_UPGRADE_SOURCE_DIR: source }), run: fakeNpm(calls, '1.1.0') });
    expect(result).toMatchObject({ from: '1.0.3', to: '1.1.0' });
    expect(readlinkSync(join(dir, 'current'))).toBe(join('versions', '1.1.0'));
    expect(readUpgradeState(dir)).toMatchObject({ state: 'staged', from: '1.0.3', to: '1.1.0', requestId: 'req-1' });
    expect(calls.some(call => call.startsWith('npm audit signatures'))).toBe(true);
    expect(existsSync(join(dir, 'staging', '1.1.0'))).toBe(false);
  });

  it('refuses a tarball whose integrity differs and leaves ./current alone', async () => {
    const dir = versionedInstall();
    const { source } = tarball(dir, '1.1.0');
    const other = `sha512-${createHash('sha512').update('something else').digest('base64')}`;
    await expect(stageUpgrade({ request: { version: '1.1.0', integrity: other, requestId: 'r', packageName: '@hivemagnus/magnus-agent' },
      version: '1.0.3', env: launcherEnv(dir, { MAGNUS_AGENT_UPGRADE_SOURCE_DIR: source }), run: fakeNpm([], '1.1.0') }))
      .rejects.toMatchObject({ code: 'SELF_UPGRADE_INTEGRITY' });
    expect(readlinkSync(join(dir, 'current'))).toBe(join('versions', '1.0.3'));
    expect(existsSync(join(dir, 'versions', '1.1.0'))).toBe(false);
  });

  it('refuses majors, downgrades, legacy layouts and a second upgrade during a trial', async () => {
    const dir = versionedInstall();
    const { source, integrity } = tarball(dir, '2.0.0');
    const request = (version: string) => ({ version, integrity, requestId: 'r', packageName: '@hivemagnus/magnus-agent' });
    const env = launcherEnv(dir, { MAGNUS_AGENT_UPGRADE_SOURCE_DIR: source });
    await expect(stageUpgrade({ request: request('2.0.0'), version: '1.0.3', env, run: fakeNpm([], '2.0.0') })).rejects.toMatchObject({ code: 'SELF_UPGRADE_REFUSED' });
    await expect(stageUpgrade({ request: request('1.0.2'), version: '1.0.3', env, run: fakeNpm([], '1.0.2') })).rejects.toMatchObject({ code: 'SELF_UPGRADE_REFUSED' });
    await expect(stageUpgrade({ request: request('1.1.0'), version: '1.0.3', env: { AGENT_INSTALL_DIR: dir }, run: fakeNpm([], '1.1.0') }))
      .rejects.toMatchObject({ code: 'SELF_UPGRADE_UNAVAILABLE' });
    writeUpgradeState(dir, { state: 'trial', from: '1.0.2', to: '1.0.3', requestId: 'r0' });
    await expect(stageUpgrade({ request: request('1.1.0'), version: '1.0.3', env, run: fakeNpm([], '1.1.0') })).rejects.toMatchObject({ code: 'SELF_UPGRADE_BUSY' });
  });

  it('refuses an install that does not report the requested version', async () => {
    const dir = versionedInstall();
    const { source, integrity } = tarball(dir, '1.1.0');
    await expect(stageUpgrade({ request: { version: '1.1.0', integrity, requestId: 'r', packageName: '@hivemagnus/magnus-agent' },
      version: '1.0.3', env: launcherEnv(dir, { MAGNUS_AGENT_UPGRADE_SOURCE_DIR: source, MAGNUS_AGENT_UPGRADE_REQUIRE_PROVENANCE: 'false' }), run: fakeNpm([], '1.0.9') }))
      .rejects.toThrow(/reports "1\.0\.9"/);
    expect(readlinkSync(join(dir, 'current'))).toBe(join('versions', '1.0.3'));
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
