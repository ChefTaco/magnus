import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { aggregateSchedulerBlockers, boundedSchedulerRead, boundedTimerInlineSources, discoverSchedulerSources, parseSchedulerAccounts,
  schedulerContentDigest, schedulerMembersDigest } from './scheduler-discovery.js';
import { schedulerInventory } from './scheduler-inventory.js';
import { ManagedScheduler } from './managed-scheduler.js';
let root: string; let servers: Server[];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'scheduler-discovery-')); servers = []; await mkdir(join(root, 'proc')); });
afterEach(async () => { for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
const quiet = async () => '';
function options() { return { accounts: [], run: quiet, procRoot: join(root, 'proc'), globalUserUnits: [], runtimeRoot: join(root, 'run') }; }
describe('native and user scheduler discovery', () => {
  it('denies a FIFO swapped in as a scheduler source without waiting for a writer', async () => {
    const path = join(root, 'swapped-source'); await writeFile(path, 'original');
    await rm(path); execFileSync('/usr/bin/mkfifo', [path]);
    await expect(boundedSchedulerRead(path)).rejects.toThrow('not a regular file');
    // Linux proc pseudo-files have size zero but are bounded regular-file observations.
    expect((await boundedSchedulerRead('/proc/self/cmdline')).length).toBeGreaterThan(0);
  });
  it('supports an actually observed empty fixture without an unconditional unsupported-user gate', async () => {
    const observed = await discoverSchedulerSources(options()); expect(observed.issues).toEqual([]); expect(observed.blockers).toEqual([]);
  });
  it('rejects malformed or unbounded account enumeration', () => {
    expect(parseSchedulerAccounts('operator:x:1000:1000::/home/operator:/bin/bash')).toEqual([{ name: 'operator', uid: 1000, home: '/home/operator' }]);
    expect(() => parseSchedulerAccounts('bad:x:not-a-uid:1000::/home/x:/bin/sh')).toThrow();
    expect(() => parseSchedulerAccounts('x:x:1:1::/x:/bin/sh\n'.repeat(257))).toThrow();
  });
  it('uses canonical content and member digests and aggregates duplicates deterministically', () => {
    expect(schedulerContentDigest('first')).not.toBe(schedulerContentDigest('second'));
    expect(schedulerMembersDigest(['b.timer', 'a.timer'])).toBe(schedulerMembersDigest(['a.timer', 'b.timer']));
    const digest = schedulerContentDigest('same');
    expect(aggregateSchedulerBlockers([
      { kind: 'SYSTEM_TIMERS', sourceSha256: digest, count: 2 },
      { kind: 'SYSTEM_CRONTAB', sourceSha256: 'f'.repeat(64), count: 1 },
      { kind: 'SYSTEM_TIMERS', sourceSha256: digest, count: 3 },
    ])).toEqual([
      { identityVersion: 2, kind: 'SYSTEM_CRONTAB', sourceSha256: 'f'.repeat(64), count: 1 },
      { identityVersion: 2, kind: 'SYSTEM_TIMERS', sourceSha256: digest, count: 5 },
    ]);
  });
  it('queries an existing user manager and reports its timers without starting it', async () => {
    const home = join(root, 'home'); await mkdir(join(root, 'run/1000'), { recursive: true });
    const unit = join(root, 'user.fixture.timer'); await writeFile(unit, '[Timer]\nOnCalendar=hourly\n');
    const service = join(root, 'user.fixture.service'); await writeFile(service, '[Service]\nExecStart=/bin/true\n');
    const server = createServer(); servers.push(server); await new Promise<void>(resolve => server.listen(join(root, 'run/1000/bus'), resolve));
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes('user@*.service')) return 'user@1000.service loaded active running User Manager\n';
      if (!args.includes('--user')) return '';
      if (args.includes('list-units')) return 'fixture.timer loaded active waiting Fixture\n';
      if (args.includes('list-unit-files')) return '';
      if (args.includes('show') && args.includes('fixture.service'))
        return `Id=fixture.service\nNames=fixture.service\nLoadState=loaded\nFragmentPath=${service}\nDropInPaths=\nExecStart={ path=/bin/true ; argv[]=/bin/true ; }\n`;
      if (args.includes('show')) return `Id=fixture.timer\nNames=fixture.timer\nLoadState=loaded\nFragmentPath=${unit}\nDropInPaths=\nActiveState=active\nUnitFileState=disabled\nUnit=fixture.service\n`;
      return '';
    });
    const observed = await discoverSchedulerSources({ ...options(), accounts: [{ name: 'operator', uid: 1000, home }], run });
    expect(observed.blockers.map(row => row.kind)).toContain('USER_TIMER_DEFINITION'); expect(observed.issues).toEqual([]);
    expect(run.mock.calls.some(([, args]) => args.includes('--machine=operator@.host'))).toBe(true);
    expect(run.mock.calls.every(([, args]) => !args.some(value => ['start', 'enable', 'restart', 'stop'].includes(value)))).toBe(true);
  });
  it('binds offline enabled user timers to their symlink, unit and drop-ins', async () => {
    const home = join(root, 'home'); const directory = join(home, '.config/systemd/user'); await mkdir(directory, { recursive: true });
    const timer = join(directory, 'later.timer'); await writeFile(timer, '[Timer]\nOnCalendar=daily\n');
    const service = join(directory, 'later.service'); await writeFile(service, '[Service]\nExecStart=/bin/true\n');
    const observed = await discoverSchedulerSources({ ...options(), accounts: [{ name: 'operator', uid: 1000, home }] });
    expect(observed.blockers.map(row => row.kind)).not.toContain('USER_TIMER_DEFINITION'); expect(observed.issues).toEqual([]);
    const wants = join(directory, 'timers.target.wants'); await mkdir(wants); await symlink(timer, join(wants, 'later.timer'));
    const enabled = await discoverSchedulerSources({ ...options(), accounts: [{ name: 'operator', uid: 1000, home }] });
    expect(enabled.blockers.map(row => row.kind)).not.toContain('USER_TIMER_DEFINITION');
    expect(enabled.issues).toEqual([]);
    const first = enabled.blockers.find(row => row.kind === 'USER_TIMER_OFFLINE_ENABLED')?.sourceSha256;
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    const dropIn = join(directory, 'later.timer.d'); await mkdir(dropIn); await writeFile(join(dropIn, 'override.conf'), '[Timer]\nPersistent=true\n');
    const changed = await discoverSchedulerSources({ ...options(), accounts: [{ name: 'operator', uid: 1000, home }] });
    expect(changed.blockers.find(row => row.kind === 'USER_TIMER_OFFLINE_ENABLED')?.sourceSha256).not.toBe(first);
    await writeFile(service, '[Service]\nExecStart=/bin/false\n');
    const changedService = await discoverSchedulerSources({ ...options(), accounts: [{ name: 'operator', uid: 1000, home }] });
    expect(changedService.blockers.find(row => row.kind === 'USER_TIMER_OFFLINE_ENABLED')?.sourceSha256)
      .not.toBe(changed.blockers.find(row => row.kind === 'USER_TIMER_OFFLINE_ENABLED')?.sourceSha256);
    await writeFile(timer, '[Timer]\nUnit=other.service\nOnCalendar=daily\n');
    const customTarget = await discoverSchedulerSources({ ...options(), accounts: [{ name: 'operator', uid: 1000, home }] });
    expect(customTarget.blockers.some(row => row.kind === 'USER_TIMER_OFFLINE_ENABLED')).toBe(false);
    expect(customTarget.issues.some(value => value.startsWith('USER_TIMER_IDENTITY_UNRECONCILABLE'))).toBe(true);
    await writeFile(timer, '[Timer]\nOnCalendar=daily\n');
    await rm(service);
    const absentService = await discoverSchedulerSources({ ...options(), accounts: [{ name: 'operator', uid: 1000, home }] });
    expect(absentService.issues.some(value => value.startsWith('USER_TIMER_IDENTITY_UNRECONCILABLE'))).toBe(true);
    await writeFile(service, '[Service]\nExecStart=/bin/true\n');
    await rm(timer);
    const unresolved = await discoverSchedulerSources({ ...options(), accounts: [{ name: 'operator', uid: 1000, home }] });
    expect(unresolved.issues.some(value => value.startsWith('USER_TIMER_IDENTITY_UNRECONCILABLE'))).toBe(true);
  });
  it('binds system timer units and drop-ins to bounded contents and member metadata', async () => {
    const units = join(root, 'system-units'); const dropIn = join(units, 'backup.timer.d'); await mkdir(dropIn, { recursive: true });
    const unit = join(units, 'backup.timer'); const override = join(dropIn, 'override.conf');
    await writeFile(unit, '[Timer]\nOnCalendar=daily\n'); await writeFile(override, '[Timer]\nPersistent=true\n');
    const service = join(units, 'backup.service'); await writeFile(service, '[Service]\nExecStart=/bin/true\n');
    // Fix the starting mode so the later chmod changes evidence under any caller umask.
    await chmod(override, 0o644);
    const run = async (_command: string, args: string[]) => {
      if (args.includes('user@*.service') || args.includes('list-units')) return '';
      if (args.includes('list-unit-files')) return 'backup.timer enabled enabled\n';
      if (args.includes('show') && args.includes('backup.service'))
        return `Id=backup.service\nNames=backup.service\nLoadState=loaded\nFragmentPath=${service}\nDropInPaths=\nExecStart={ path=/bin/true ; argv[]=/bin/true ; }\n`;
      if (args.includes('show')) return `Id=backup.timer\nNames=backup.timer\nLoadState=loaded\nFragmentPath=${unit}\nDropInPaths=${override}\nActiveState=inactive\nUnitFileState=enabled\nUnit=backup.service\n`;
      return '';
    };
    const first = await discoverSchedulerSources({ ...options(), run });
    expect(first.issues).toEqual([]); expect(first.blockers.filter(row => row.kind === 'SYSTEM_TIMER_DEFINITION')).toHaveLength(1);
    await writeFile(override, '[Timer]\nPersistent=false\n');
    const second = await discoverSchedulerSources({ ...options(), run });
    const prior = new Set(first.blockers.map(row => row.sourceSha256));
    expect(second.blockers.filter(row => prior.has(row.sourceSha256))).toHaveLength(0);
    await chmod(override, 0o600);
    const third = await discoverSchedulerSources({ ...options(), run });
    const secondDigests = new Set(second.blockers.map(row => row.sourceSha256));
    expect(third.blockers.filter(row => secondDigests.has(row.sourceSha256))).toHaveLength(0);
    await writeFile(service, '[Service]\nExecStart=/bin/false\n');
    const changedService = await discoverSchedulerSources({ ...options(), run });
    expect(changedService.blockers.find(row => row.kind === 'SYSTEM_TIMER_DEFINITION')?.sourceSha256)
      .not.toBe(third.blockers.find(row => row.kind === 'SYSTEM_TIMER_DEFINITION')?.sourceSha256);
    await rm(service);
    const missingService = await discoverSchedulerSources({ ...options(), run });
    expect(missingService.blockers.some(row => row.kind === 'SYSTEM_TIMER_DEFINITION')).toBe(false);
    expect(missingService.issues.some(value => value.startsWith('SYSTEM_TIMER_IDENTITY_UNRECONCILABLE'))).toBe(true);
  });
  it('keeps a timer source unreconcilable when its contents cannot be bound', async () => {
    const units = join(root, 'system-units'); await mkdir(units); const unit = join(units, 'blocked.timer'); execFileSync('/usr/bin/mkfifo', [unit]);
    const run = async (_command: string, args: string[]) => {
      if (args.includes('user@*.service') || args.includes('list-unit-files')) return '';
      if (args.includes('list-units')) return 'blocked.timer loaded active waiting Blocked\n';
      if (args.includes('show')) return `Id=blocked.timer\nNames=blocked.timer\nLoadState=loaded\nFragmentPath=${unit}\nDropInPaths=\nActiveState=active\nUnitFileState=disabled\nUnit=blocked.service\n`;
      return '';
    };
    const observed = await discoverSchedulerSources({ ...options(), run });
    expect(observed.blockers.some(row => row.kind === 'SYSTEM_TIMER_DEFINITION')).toBe(false);
    expect(observed.issues.some(value => value.startsWith('SYSTEM_TIMER_IDENTITY_UNRECONCILABLE'))).toBe(true);
  });
  it('binds an interpreter-backed service to its invoked local script bytes', async () => {
    const timer = join(root, 'script.timer'); const service = join(root, 'script.service'); const script = join(root, 'job.mjs');
    await writeFile(timer, '[Timer]\nOnCalendar=daily\n');
    await writeFile(service, '[Service]\nExecStart=/usr/bin/node job.mjs\n');
    await writeFile(script, 'console.log(1)\n');
    const run = async (_command: string, args: string[]) => {
      if (args.includes('user@*.service') || args.includes('list-unit-files')) return '';
      if (args.includes('list-units')) return 'script.timer loaded active waiting Script\n';
      if (args.includes('show') && args.includes('script.service'))
        return `Id=script.service\nNames=script.service\nLoadState=loaded\nFragmentPath=${service}\nDropInPaths=\nExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node ${script} ; }\n`;
      if (args.includes('show')) return `Id=script.timer\nNames=script.timer\nLoadState=loaded\nFragmentPath=${timer}\nDropInPaths=\nActiveState=active\nUnitFileState=disabled\nUnit=script.service\n`;
      return '';
    };
    const first = await discoverSchedulerSources({ ...options(), run });
    expect(first.issues).toEqual([]);
    await writeFile(script, 'console.log(2)\n');
    const changed = await discoverSchedulerSources({ ...options(), run });
    expect(changed.blockers[0]?.sourceSha256).not.toBe(first.blockers[0]?.sourceSha256);
    await rm(script);
    const missing = await discoverSchedulerSources({ ...options(), run });
    expect(missing.blockers).toEqual([]);
    expect(missing.issues.some(value => value.startsWith('SYSTEM_TIMER_IDENTITY_UNRECONCILABLE'))).toBe(true);
  });
  it('binds repeated service commands, nested variable braces, and a bounded large executable', async () => {
    const timer = join(root, 'multi.timer'); const service = join(root, 'multi.service');
    const binary = join(root, 'large-executable'); const script = join(root, 'mdcheck');
    const environment = join(root, 'first.env'); const optionalEnvironment = join(root, 'second.env');
    await writeFile(timer, '[Timer]\nOnCalendar=daily\n');
    await writeFile(service, '[Service]\nType=oneshot\n');
    await writeFile(binary, Buffer.alloc(300 * 1024, 1));
    await writeFile(script, '#!/bin/sh\nexit 0\n');
    await writeFile(environment, 'CHECK_DURATION=2\n');
    const run = async (_command: string, args: string[]) => {
      if (args.includes('user@*.service') || args.includes('list-unit-files')) return '';
      if (args.includes('list-units')) return 'multi.timer loaded active waiting Multi\n';
      if (args.includes('show') && args.includes('multi.service'))
        return `Id=multi.service\nNames=multi.service\nLoadState=loaded\nFragmentPath=${service}\nDropInPaths=\n`
          + `ExecStart={ path=${binary} ; argv[]=${binary} ; ignore_errors=no ; }\n`
          + `ExecStart={ path=${script} ; argv[]=${script} --duration \${MDADM_CHECK_DURATION} ; ignore_errors=no ; }\n`
          + `EnvironmentFiles=${environment} (ignore_errors=no)\nEnvironmentFiles=${optionalEnvironment} (ignore_errors=yes)\n`;
      if (args.includes('show')) return `Id=multi.timer\nNames=multi.timer\nLoadState=loaded\nFragmentPath=${timer}\nDropInPaths=\nActiveState=active\nUnitFileState=disabled\nUnit=multi.service\n`;
      return '';
    };
    const first = await discoverSchedulerSources({ ...options(), run });
    expect(first.issues).toEqual([]);
    expect(first.blockers.filter(row => row.kind === 'SYSTEM_TIMER_DEFINITION')).toHaveLength(1);
    await writeFile(binary, Buffer.alloc(300 * 1024, 2));
    const changed = await discoverSchedulerSources({ ...options(), run });
    expect(changed.blockers[0]?.sourceSha256).not.toBe(first.blockers[0]?.sourceSha256);
    await writeFile(script, '#!/bin/sh\nexit 1\n');
    const changedScript = await discoverSchedulerSources({ ...options(), run });
    expect(changedScript.blockers[0]?.sourceSha256).not.toBe(changed.blockers[0]?.sourceSha256);
    await writeFile(environment, 'CHECK_DURATION=3\n');
    const changedEnvironment = await discoverSchedulerSources({ ...options(), run });
    expect(changedEnvironment.blockers[0]?.sourceSha256).not.toBe(changedScript.blockers[0]?.sourceSha256);
    await writeFile(optionalEnvironment, 'OPTIONAL=present\n');
    const addedEnvironment = await discoverSchedulerSources({ ...options(), run });
    expect(addedEnvironment.blockers[0]?.sourceSha256).not.toBe(changedEnvironment.blockers[0]?.sourceSha256);
  });
  it('keeps PATH-resolved and inline shell timer commands unreconcilable', async () => {
    const timer = join(root, 'relative.timer'); const service = join(root, 'relative.service');
    await writeFile(timer, '[Timer]\nOnCalendar=daily\n'); await writeFile(service, '[Service]\nExecStart=find /tmp -delete\n');
    const run = async (_command: string, args: string[]) => {
      if (args.includes('user@*.service') || args.includes('list-unit-files')) return '';
      if (args.includes('list-units')) return 'relative.timer loaded active waiting Relative\n';
      if (args.includes('show') && args.includes('relative.service'))
        return `Id=relative.service\nNames=relative.service\nLoadState=loaded\nFragmentPath=${service}\nDropInPaths=\nExecStart={ path=find ; argv[]=find /tmp -delete ; ignore_errors=no ; }\n`;
      if (args.includes('show')) return `Id=relative.timer\nNames=relative.timer\nLoadState=loaded\nFragmentPath=${timer}\nDropInPaths=\nActiveState=active\nUnitFileState=disabled\nUnit=relative.service\n`;
      return '';
    };
    const observed = await discoverSchedulerSources({ ...options(), run });
    expect(observed.blockers.some(row => row.kind === 'SYSTEM_TIMER_DEFINITION')).toBe(false);
    expect(observed.issues.some(value => value.startsWith('SYSTEM_TIMER_IDENTITY_UNRECONCILABLE'))).toBe(true);
  });
  it('binds the exact mdmonitor shell condition and environment without accepting PATH injection', async () => {
    const timer = join(root, 'mdmonitor-oneshot.timer'); const service = join(root, 'mdmonitor-oneshot.service');
    const environment = join(root, 'mdadm.env');
    await writeFile(timer, '[Timer]\nOnCalendar=daily\n');
    await writeFile(service, '[Service]\nExecStart=sh -c condition\n');
    await writeFile(environment, 'AUTOSCAN=true\n');
    const run = async (command: string, args: string[]) => {
      if (command === '/usr/bin/systemd-path') return '/usr/bin:/bin\n';
      if (args.includes('show-environment')) return 'PATH=/usr/bin:/bin\n';
      if (args.includes('user@*.service') || args.includes('list-unit-files')) return '';
      if (args.includes('list-units')) return 'mdmonitor-oneshot.timer loaded active waiting MD monitor\n';
      if (args.includes('show') && args.includes('mdmonitor-oneshot.service'))
        return `Id=mdmonitor-oneshot.service\nNames=mdmonitor-oneshot.service\nLoadState=loaded\nFragmentPath=${service}\nDropInPaths=\n`
          + `EnvironmentFiles=${environment} (ignore_errors=no)\n`
          + 'ExecStart={ path=sh ; argv[]=sh -c [ "$AUTOSCAN" != "true" ] || /sbin/mdadm --monitor --oneshot --scan ; ignore_errors=no ; }\n';
      if (args.includes('show')) return `Id=mdmonitor-oneshot.timer\nNames=mdmonitor-oneshot.timer\nLoadState=loaded\nFragmentPath=${timer}\nDropInPaths=\nActiveState=active\nUnitFileState=disabled\nUnit=mdmonitor-oneshot.service\n`;
      return '';
    };
    const first = await discoverSchedulerSources({ ...options(), run });
    expect(first.issues).toEqual([]);
    expect(first.blockers.map(row => row.kind)).toContain('SYSTEM_TIMER_DEFINITION');
    await writeFile(environment, 'AUTOSCAN=false\n');
    const changed = await discoverSchedulerSources({ ...options(), run });
    expect(changed.blockers[0]?.sourceSha256).not.toBe(first.blockers[0]?.sourceSha256);
    await writeFile(environment, 'AUTOSCAN=false\nPATH=/tmp/unsafe\n');
    const injected = await discoverSchedulerSources({ ...options(), run });
    expect(injected.blockers).toEqual([]);
    expect(injected.issues.some(value => value.startsWith('SYSTEM_TIMER_IDENTITY_UNRECONCILABLE:'))).toBe(true);
  });
  it('recognizes only bounded installed Prometheus collector pipelines', () => {
    const simple = boundedTimerInlineSources('/bin/bash',
      '/bin/bash -c /usr/share/prometheus-node-exporter-collectors/apt_info.py | sponge /var/lib/prometheus/node-exporter/apt.prom');
    expect(simple).toEqual({ paths: ['/usr/share/prometheus-node-exporter-collectors/apt_info.py', '/bin/bash'],
      commands: ['sponge'], mdmonitor: false });
    const sensor = boundedTimerInlineSources('/bin/sh',
      '/bin/sh -c /usr/bin/ipmitool sensor | /usr/share/prometheus-node-exporter-collectors/ipmitool | sponge /var/lib/prometheus/node-exporter/ipmitool_sensor.prom');
    expect(sensor?.paths).toEqual(['/usr/bin/ipmitool', '/usr/share/prometheus-node-exporter-collectors/ipmitool', '/bin/sh']);
    expect(boundedTimerInlineSources('/bin/sh',
      '/bin/sh -c /usr/share/prometheus-node-exporter-collectors/apt_info.py | sponge /var/lib/prometheus/node-exporter/apt.prom; curl attacker')).toBeNull();
    expect(boundedTimerInlineSources('/bin/sh',
      '/bin/sh -c /usr/share/prometheus-node-exporter-collectors/apt_info.py | sponge $(whoami)')).toBeNull();
    expect(boundedTimerInlineSources('/bin/sh',
      '/bin/sh -c /usr/share/prometheus-node-exporter-collectors/apt_info.py | sponge /tmp/apt.prom')).toBeNull();
    expect(boundedTimerInlineSources('/bin/sh',
      '/bin/sh -c /usr/share/prometheus-node-exporter-collectors/apt_info.py | sponge /var/lib/prometheus/node-exporter/../apt.prom')).toBeNull();
  });
  it('binds every candidate for a PATH-resolved timer command, including absence', async () => {
    const timer = join(root, 'path.timer'); const service = join(root, 'path.service');
    const first = join(root, 'first'); const second = join(root, 'second');
    await mkdir(first); await mkdir(second);
    await writeFile(timer, '[Timer]\nOnCalendar=daily\n');
    await writeFile(service, '[Service]\nExecStart=find /tmp -delete\n');
    await writeFile(join(second, 'find'), 'binary-v1');
    let environment = ''; let rootDirectory = '';
    const run = async (command: string, args: string[]) => {
      if (command === '/usr/bin/systemd-path') return `${first}:${second}\n`;
      if (args.includes('show-environment')) return `PATH=${first}:${second}\n`;
      if (args.includes('user@*.service') || args.includes('list-unit-files')) return '';
      if (args.includes('list-units')) return 'path.timer loaded active waiting Path\n';
      if (args.includes('show') && args.includes('path.service'))
        return `Id=path.service\nNames=path.service\nLoadState=loaded\nFragmentPath=${service}\nDropInPaths=\n`
          + `Environment=${environment}\nRootDirectory=${rootDirectory}\n`
          + `ExecStart={ path=find ; argv[]=find /tmp -delete ; ignore_errors=no ; }\n`;
      if (args.includes('show')) return `Id=path.timer\nNames=path.timer\nLoadState=loaded\nFragmentPath=${timer}\nDropInPaths=\nActiveState=active\nUnitFileState=disabled\nUnit=path.service\n`;
      return '';
    };
    const initial = await discoverSchedulerSources({ ...options(), run });
    expect(initial.issues).toEqual([]);
    expect(initial.blockers.map(row => row.kind)).toContain('SYSTEM_TIMER_DEFINITION');
    await writeFile(join(second, 'find'), 'binary-v2');
    const changed = await discoverSchedulerSources({ ...options(), run });
    expect(changed.blockers[0]?.sourceSha256).not.toBe(initial.blockers[0]?.sourceSha256);
    await writeFile(join(first, 'find'), 'new earlier candidate');
    const appeared = await discoverSchedulerSources({ ...options(), run });
    expect(appeared.blockers[0]?.sourceSha256).not.toBe(changed.blockers[0]?.sourceSha256);
    environment = 'PATH=/elsewhere';
    const custom = await discoverSchedulerSources({ ...options(), run });
    expect(custom.blockers).toEqual([]);
    expect(custom.issues.some(value => value.startsWith('SYSTEM_TIMER_IDENTITY_UNRECONCILABLE'))).toBe(true);
    environment = ''; rootDirectory = '/other-root';
    const namespaced = await discoverSchedulerSources({ ...options(), run });
    expect(namespaced.blockers).toEqual([]);
    expect(namespaced.issues.some(value => value.startsWith('SYSTEM_TIMER_IDENTITY_UNRECONCILABLE'))).toBe(true);
  });
  it('retains an inline shell command even when its text names a script', async () => {
    const timer = join(root, 'shell.timer'); const service = join(root, 'shell.service');
    const script = join(root, 'named.sh'); await writeFile(timer, '[Timer]\nOnCalendar=daily\n');
    await writeFile(service, `[Service]\nExecStart=/bin/sh -c ${script}\n`); await writeFile(script, 'exit 0\n');
    const run = async (_command: string, args: string[]) => {
      if (args.includes('user@*.service') || args.includes('list-unit-files')) return '';
      if (args.includes('list-units')) return 'shell.timer loaded active waiting Shell\n';
      if (args.includes('show') && args.includes('shell.service'))
        return `Id=shell.service\nNames=shell.service\nLoadState=loaded\nFragmentPath=${service}\nDropInPaths=\n`
          + `ExecStart={ path=/bin/sh ; argv[]=/bin/sh -c ${script} ; ignore_errors=no ; }\n`;
      if (args.includes('show')) return `Id=shell.timer\nNames=shell.timer\nLoadState=loaded\nFragmentPath=${timer}\nDropInPaths=\nActiveState=active\nUnitFileState=disabled\nUnit=shell.service\n`;
      return '';
    };
    const observed = await discoverSchedulerSources({ ...options(), run });
    expect(observed.blockers).toEqual([]);
    expect(observed.issues.some(value => value.startsWith('SYSTEM_TIMER_IDENTITY_UNRECONCILABLE'))).toBe(true);
    expect(observed.issues.some(value => value.startsWith('SYSTEM_TIMER_INLINE_INTERPRETER_UNRESOLVED:'))).toBe(true);
    expect(observed.issues.every(value => !value.includes(script))).toBe(true);
  });
  it('finds custom process homes while keeping all other environment values private', async () => {
    const path = join(root, 'proc/42'); await mkdir(path); await writeFile(join(path, 'cmdline'), 'python\0/custom/hermes/gateway.py\0--hermes-home=/custom/profile\0');
    const fields = Array.from({ length: 19 }, () => '1'); fields[18] = '4242'; await writeFile(join(path, 'stat'), `42 (hermes gateway) S ${fields.join(' ')}`);
    await writeFile(join(path, 'environ'), 'HERMES_HOME=/another/profile\0PRIVATE_TOKEN=must-stay-private\0');
    const observed = await discoverSchedulerSources(options()); expect(observed.hermesRoots).toEqual(['/another/profile', '/custom/profile']);
    expect(observed.blockers.map(row => row.kind)).toContain('NATIVE_HERMES_RUNTIME_UNINSTRUMENTED'); expect(JSON.stringify(observed)).not.toContain('must-stay-private');
    fields[18] = '4243'; await writeFile(join(path, 'stat'), `42 (hermes gateway) S ${fields.join(' ')}`);
    const restarted = await discoverSchedulerSources(options());
    expect(restarted.blockers[0]?.sourceSha256).not.toBe(observed.blockers[0]?.sourceSha256);
    await rm(join(path, 'stat')); const unresolved = await discoverSchedulerSources(options());
    expect(unresolved.blockers.some(row => row.kind === 'NATIVE_HERMES_RUNTIME_UNINSTRUMENTED')).toBe(false);
    expect(unresolved.issues.some(value => value.startsWith('NATIVE_HERMES_RUNTIME_IDENTITY_UNRECONCILABLE'))).toBe(true);
  });
  it('accepts reviewed additional roots only from a private additive canonical record', async () => {
    const coverageRoot = join(root, 'coverage'); const extra = join(root, 'extra'); await mkdir(coverageRoot, { mode: 0o700 }); await mkdir(extra);
    await writeFile(join(coverageRoot, 'scheduler-coverage.json'), JSON.stringify({ version: 1, reviewRef: 'operator-review-fixture', additionalHermesHomes: [extra] }), { mode: 0o600 });
    expect((await discoverSchedulerSources({ ...options(), coverageRoot })).hermesRoots).toEqual([extra]);
    await writeFile(join(coverageRoot, 'scheduler-coverage.json'), JSON.stringify({ version: 1, reviewRef: 'fixture', additionalHermesHomes: [extra], exclude: ['/home'] }));
    expect((await discoverSchedulerSources({ ...options(), coverageRoot })).issues).toContain('REVIEWED_SCHEDULER_COVERAGE_INVALID');
  });
  it('finds named-profile pending claims even when their schedule is paused and claim timestamp is old', async () => {
    const home = join(root, 'home'); const cron = join(home, '.hermes/profiles/private/cron'); await mkdir(cron, { recursive: true });
    await writeFile(join(cron, 'jobs.json'), JSON.stringify([{ id: 'paused', enabled: false, paused: true, run_claim: { at: 1 } }]));
    const value = await schedulerInventory({ scheduler: new ManagedScheduler(join(root, 'journal')), homes: [home],
      spool: join(root, 'absent-spool'), systemCrontab: join(root, 'absent-cron'), systemDirectories: [], timers: quiet });
    expect(value.quiescent).toBe(false); expect(value.blockers.map(row => row.kind)).toContain('NATIVE_HERMES_UNSETTLED_CLAIMS');
  });
  it('retains foreign claim evidence after the source file is deleted', async () => {
    const home = join(root, 'home'); const cron = join(home, '.hermes/cron'); await mkdir(cron, { recursive: true });
    await writeFile(join(cron, 'jobs.json'), JSON.stringify([{ enabled: false, run_claim: { at: 1 } }]));
    const configuration = { scheduler: new ManagedScheduler(join(root, 'journal')), homes: [home], spool: join(root, 'absent-spool'),
      systemCrontab: join(root, 'absent-cron'), systemDirectories: [], timers: quiet };
    expect((await schedulerInventory(configuration)).quiescent).toBe(false);
    await rm(join(cron, 'jobs.json'));
    const later = await schedulerInventory({ ...configuration, scheduler: new ManagedScheduler(configuration.scheduler.root) });
    expect(later.quiescent).toBe(false); expect(later.blockers.map(row => row.kind)).toContain('NATIVE_HERMES_UNSETTLED_CLAIMS');
  });
  it('counts system crontab schedules without treating environment assignments as executions', async () => {
    const crontab = join(root, 'system-crontab');
    const raw = '# comment\nSHELL=/bin/sh\nMAILTO=\n* * * * * root /bin/true\n@daily root /bin/true\n@hourly root /bin/true\nunknown-line\n';
    await writeFile(crontab, raw);
    const inventory = (journal: string) => schedulerInventory({ scheduler: new ManagedScheduler(join(root, journal)),
      homes: [], spool: join(root, 'absent-spool'), systemCrontab: crontab,
      systemDirectories: [], timers: quiet, atSpools: [] });
    const current = await inventory('journal-crontab-current');
    const source = current.blockers.find(row => row.kind === 'SYSTEM_CRONTAB');
    expect(source).toMatchObject({ count: 4, sourceSha256: schedulerContentDigest(raw) });
    expect(current.supported).toBe(false); expect(current.quiescent).toBe(false);
    const historical = new ManagedScheduler(join(root, 'journal-crontab-historical'));
    await historical.observeDiscovery([], [{ kind: 'SYSTEM_CRONTAB', sourceSha256: schedulerContentDigest(raw), count: 5 }]);
    expect((await inventory('journal-crontab-historical')).blockers.find(row => row.kind === 'SYSTEM_CRONTAB')?.count).toBe(5);
    await writeFile(crontab, '# comment\nSHELL=/bin/sh\n');
    const environmentOnly = await inventory('journal-crontab-environment-only');
    expect(environmentOnly.blockers.find(row => row.kind === 'SYSTEM_CRONTAB')?.count).toBe(1);
    expect(environmentOnly.supported).toBe(false);
    await writeFile(crontab, '# comment\n');
    expect((await inventory('journal-crontab-comments-only')).blockers.some(row => row.kind === 'SYSTEM_CRONTAB')).toBe(false);
  });
  it('bounds bytes during source reads, including dishonest growing file metadata', async () => {
    const path = join(root, 'large'); await writeFile(path, 'x'.repeat(5000));
    await expect(boundedSchedulerRead(path, 4096)).rejects.toThrow('exceeded bound');
  });
  it('binds at jobs to bounded content and refuses an unbound queue', async () => {
    const at = join(root, 'at'); await mkdir(at); await writeFile(join(at, 'job-1'), '#!/bin/sh\necho first\n', { mode: 0o700 });
    const inventory = (journal: string) => schedulerInventory({ scheduler: new ManagedScheduler(join(root, journal)), homes: [],
      spool: join(root, 'absent-spool'), systemCrontab: join(root, 'absent-cron'), systemDirectories: [], timers: quiet, atSpools: [at] });
    const first = await inventory('journal-at-1'); const firstDigest = first.blockers.find(row => row.kind === 'NATIVE_AT_QUEUE')?.sourceSha256;
    await writeFile(join(at, 'job-1'), '#!/bin/sh\necho second\n', { mode: 0o700 });
    const second = await inventory('journal-at-2');
    expect(second.blockers.find(row => row.kind === 'NATIVE_AT_QUEUE')?.sourceSha256).not.toBe(firstDigest);
    await symlink('/missing/at-job', join(at, 'job-2'));
    const unsafe = await inventory('journal-at-3');
    expect(unsafe.blockers.some(row => row.kind === 'NATIVE_AT_QUEUE')).toBe(false);
    expect(unsafe.issues.some(value => value.startsWith('AT_JOB_IDENTITY_UNRECONCILABLE'))).toBe(true);
  });
  it('does not make volatile system timer runtime output eligible for signed settlement', async () => {
    const inventory = await schedulerInventory({ scheduler: new ManagedScheduler(join(root, 'journal-timer-runtime')), homes: [],
      spool: join(root, 'absent-spool'), systemCrontab: join(root, 'absent-cron'), systemDirectories: [],
      timers: async () => 'fixture.timer fixture.service\n' });
    expect(inventory.blockers.some(row => row.kind === 'SYSTEM_TIMERS')).toBe(false);
    expect(inventory.issues.some(value => value.startsWith('SYSTEM_TIMER_IDENTITY_UNRECONCILABLE'))).toBe(true);
  });
  it('keeps unavailable user-manager evidence pending rather than inferring absence', async () => {
    const observed = await discoverSchedulerSources({ ...options(), run: async () => { throw new Error('manager denied'); } });
    expect(observed.issues).toContain('USER_MANAGER_INVENTORY_UNAVAILABLE');
  });
});
