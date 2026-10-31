import * as fs from 'node:fs/promises';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:fs/promises', async original => ({ ...(await original<any>()) }));
import * as discovery from './hermes-dashboard-discovery.js';
import { collectHermesState } from './hermes-manager.js';

let root: string; let home: string; let procRoot: string;
const row = (address = '450200C0', port = '239F', inode = '345', state = '0A') =>
  ` 0: ${address}:${port} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 1000 0 ${inode} 1 00000000\n`;
async function processFixture(pid = '42', args = ['python', '-m', 'hermes_cli.main', 'dashboard', '--host', 'hermes.example.com', '--port', '9119']) {
  const dir = join(procRoot, pid); await mkdir(join(dir, 'fd'), { recursive: true }); await mkdir(join(dir, 'net'));
  await writeFile(join(dir, 'cmdline'), args.join('\0') + '\0');
  await writeFile(join(dir, 'environ'), `HOME=${root}\0HERMES_HOME=${home}\0SECRET=must-not-appear\0`);
  await writeFile(join(dir, 'stat'), `${pid} (hermes dashboard) S ${Array(18).fill('0').join(' ')} 12345 0\n`);
  await symlink('socket:[345]', join(dir, 'fd', '10'));
  await writeFile(join(dir, 'net', 'tcp'), 'sl local_address rem_address st fields\n' + row());
  await writeFile(join(dir, 'net', 'tcp6'), 'sl local_address rem_address st fields\n');
  return dir;
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'hermes-listener-')); home = join(root, '.hermes'); procRoot = join(root, 'proc'); await mkdir(home); await mkdir(procRoot); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
describe('read-only dashboard endpoint observation', () => {
  it('reports actual owned tailnet listener, not configured hostname or loopback default', async () => {
    await processFixture();
    expect(await discovery.observeHermesDashboard(home, { procRoot })).toEqual({ status: 'running', host: '192.0.2.69', port: 9119, source: 'linux-proc-owned-listener', reason: 'observed' });
  });
  it('does not confuse process existence, another socket, or established connection with listening', async () => {
    const dir = await processFixture();
    await writeFile(join(dir, 'net', 'tcp'), 'header\n' + row('0100007F', '239F', '999') + row('450200C0', '239F', '345', '01'));
    expect(await discovery.observeHermesDashboard(home, { procRoot })).toMatchObject({ status: 'unknown', host: null, reason: 'not-observed' });
  });
  it('rejects foreign homes, headless serve and profile-ambiguous launchers', async () => {
    const dir = await processFixture(); await writeFile(join(dir, 'environ'), `HERMES_HOME=${root}/other\0`);
    await processFixture('43', ['hermes', 'serve']);
    await processFixture('44', ['hermes', '--profile', 'peer', 'dashboard']);
    await processFixture('45', ['python', '-m', 'hermes_cli.main', 'dashboard', '--profile=peer']);
    expect(await discovery.observeHermesDashboard(home, { procRoot })).toMatchObject({ status: 'unknown', host: null });
  });
  it('returns unknown on ambiguous listeners, malformed inventory and expired inspection budget', async () => {
    const dir = await processFixture();
    await writeFile(join(dir, 'net', 'tcp'), 'header\n' + row() + row('0100007F'));
    expect((await discovery.observeHermesDashboard(home, { procRoot })).reason).toBe('ambiguous');
    await writeFile(join(dir, 'net', 'tcp'), 'header\nmalformed\n');
    expect((await discovery.observeHermesDashboard(home, { procRoot })).reason).toBe('unavailable');
    expect((await discovery.observeHermesDashboard(home, { procRoot, timeoutMs: 0 })).reason).toBe('unavailable');
  });
  it('rejects oversized/symlinked inventory without reading arbitrary files', async () => {
    const dir = await processFixture(); await writeFile(join(dir, 'cmdline'), 'x'.repeat(65537));
    expect((await discovery.observeHermesDashboard(home, { procRoot })).reason).toBe('unavailable');
    await rm(join(dir, 'cmdline')); await symlink(join(dir, 'environ'), join(dir, 'cmdline'));
    expect((await discovery.observeHermesDashboard(home, { procRoot })).reason).toBe('unavailable');
  });
  it('does not publish a stale listener when the owner exits before identity recheck', async () => {
    const dir = await processFixture(); const original = fs.open; let statReads = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === join(dir, 'stat') && ++statReads === 2) await rm(join(dir, 'stat'));
      return original(...args);
    });
    expect(await discovery.observeHermesDashboard(home, { procRoot })).toMatchObject({ status: 'unknown', host: null, reason: 'not-observed' });
  });
  it('canonicalizes IPv6 socket byte order and preserves wildcard as observation', () => {
    expect(discovery.procListeners('header\n' + row('00000000000000000000000001000000'), true, new Set(['345']), 9119)).toEqual([{ host: '::1', port: 9119 }]);
    expect(discovery.procListeners('header\n' + row('00000000'), false, new Set(['345']), 9119)).toEqual([{ host: '0.0.0.0', port: 9119 }]);
  });
  it('plumbs only positive observation into collected node state; unknown never supplies a guessed endpoint', async () => {
    const bin = join(root, 'hermes'); await writeFile(bin, '#!/bin/sh\n[ "$1" = "version" ] && echo "Hermes Agent v1.0.0"\nexit 0\n'); await chmod(bin, 0o755);
    const observer = vi.spyOn(discovery, 'observeHermesDashboard').mockResolvedValue({ status: 'running', host: '192.0.2.69', port: 9119, source: 'linux-proc-owned-listener', reason: 'observed' });
    const observed = await collectHermesState({ hermesHome: home, hermesBin: bin }, true);
    expect(observed).toMatchObject({ dashboardStatus: 'running', dashboardHost: '192.0.2.69', dashboardPort: 9119 });
    observer.mockResolvedValue({ status: 'unknown', host: null, port: null, source: 'linux-proc-owned-listener', reason: 'unavailable' });
    const unknown = await collectHermesState({ hermesHome: home, hermesBin: bin }, true);
    expect(unknown.dashboardStatus).toBe('unknown'); expect(unknown).not.toHaveProperty('dashboardHost'); expect(unknown).not.toHaveProperty('dashboardPort');
  });
});
