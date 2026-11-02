import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pruneBackups } from './database.js';
import { appendMissing } from './env-file.js';
import { init, type InitOptions } from './init.js';
import type { Io, RunOptions, RunResult } from './io.js';
import { ArgsError, parseArgs } from './main.js';
import { acquireLock, parseLock, Project, type ProjectState } from './project.js';
import { automaticCandidates, fetchRegistryCatalog, pickTarget, releaseFor, resolveRegistry } from './release.js';
import { restore } from './restore.js';
import { rollback } from './rollback.js';
import { composeProjectName, refreshUnit, serverUnit } from './templates.js';
import { upgrade, UpgradeError, type UpgradeOptions } from './upgrade.js';

const manifest = (version: string, extra: Record<string, unknown> = {}) => ({
  schema: 1,
  version,
  engines: { node: '^24.22.1 || ^26.13.0' },
  components: {
    '@hivemagnus/magnus-server': version,
    '@hivemagnus/magnus-ui': version,
    '@hivemagnus/magnus-contracts': version,
    '@hivemagnus/magnus-agent': version,
  },
  engineProtocol: 1,
  agent: { selfUpgradeProtocol: 1, minLauncher: 1 },
  summary: `Release ${version}`,
  ...extra,
});

interface Host {
  io: Io;
  calls: string[];
  logs: string[];
  /** Version the fake server reports after the next restart. */
  serves: { version: string | null };
  /** Migrations every version after 1.0.3 packages; migrate applies them. */
  pending: Array<{ name: string; impact: string; note: string }>;
  applied: Set<string>;
  failed: string[];
  failHealthFor: Set<string>;
  failRestartFor: Set<string>;
  /** Replaces the `check --format json` output. */
  checkOutput?: string;
  /** Called while `migrate` runs. */
  onMigrate?: () => void;
  onRestart?: () => void;
  busOk: boolean;
  free: number;
}

function fakeServerInstall(dir: string): void {
  for (const bin of [['magnus-server', 'dist', 'cli.js'], ['magnus-ui', 'bin', 'magnus-ui.mjs'], ['magnus', 'dist', 'cli.js']]) {
    const path = join(dir, 'node_modules', '@hivemagnus', ...bin);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '');
  }
  if (!existsSync(join(dir, 'package.json'))) writeFileSync(join(dir, 'package.json'), '{}');
}

function makeProject(state: Partial<ProjectState> = {}): Project {
  const dir = mkdtempSync(join(tmpdir(), 'magnus-project-'));
  mkdirSync(join(dir, 'config'));
  writeFileSync(join(dir, 'config', 'magnus-server.env'), 'API_SECRET=x\n');
  writeFileSync(join(dir, 'config', 'magnus-ui.env'), 'API_SECRET=x\n');
  fakeServerInstall(join(dir, 'versions', '1.0.3'));
  const project = new Project(dir, {
    schema: 1, createdAt: '2026-11-01T00:00:00.000Z', supervisor: 'systemd', scope: 'user', components: ['server', 'ui'],
    units: { server: 'magnus-server', ui: 'magnus-ui' },
    envFiles: { server: 'config/magnus-server.env', ui: 'config/magnus-ui.env' },
    database: { kind: 'external' }, ports: { server: 4000, ui: 3000 },
    current: '1.0.3', previous: null, keepVersions: 3, history: [], ...state,
  });
  project.switchCurrent('1.0.3');
  project.save();
  return project;
}

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });

function makeHost(project: Project, versions: Record<string, unknown>, packument: Record<string, unknown> = {}): Host {
  let clock = Date.parse('2026-11-01T00:00:00Z');
  const host: Host = {
    io: undefined as unknown as Io, calls: [], logs: [], serves: { version: '1.0.3' }, pending: [], applied: new Set(), failed: [],
    failHealthFor: new Set(), failRestartFor: new Set(), busOk: true, free: 1e15,
  };
  const writeRuntime = (version: string | null) => {
    mkdirSync(project.path('run'), { recursive: true });
    writeFileSync(project.path('run', 'server-runtime.json'), JSON.stringify({ version, pid: 42, port: 4000, startedAt: new Date(clock).toISOString() }));
  };
  host.io = {
    run: async (command: string, args: readonly string[], options: RunOptions = {}) => {
      const binIndex = args.findIndex((arg) => arg.endsWith(join('magnus-server', 'dist', 'cli.js')));
      if (binIndex >= 0) {
        const version = args[binIndex]!.split('/versions/')[1]?.split('/')[0] ?? 'current';
        const sub = args[binIndex + 1];
        host.calls.push(`server ${version} ${sub}`);
        const isNew = version !== '1.0.3';
        if (sub === '--version') return ok(version);
        if (sub === 'migrations') {
          const packaged = ['0_base', ...(isNew ? host.pending.map((m) => m.name) : [])];
          return ok(JSON.stringify({
            packaged, applied: ['0_base', ...host.applied], failed: host.failed,
            pending: isNew ? host.pending.filter((m) => !host.applied.has(m.name)) : [],
          }));
        }
        if (sub === 'backup') return ok(JSON.stringify({ file: join(project.dir, 'backups', 'x.dump') }));
        if (sub === 'check') return host.checkOutput !== undefined ? { code: 1, stdout: host.checkOutput, stderr: '' } : ok(JSON.stringify({ results: [{ name: 'secrets', status: 'pass', message: '' }] }));
        if (sub === 'migrate') {
          host.onMigrate?.();
          for (const migration of host.pending) host.applied.add(migration.name);
        }
        return ok();
      }
      host.calls.push(`${command} ${args.join(' ')}`);
      if (args[0] === '--version' && (command === process.execPath || command.endsWith('/node'))) return ok('v24.22.1');
      if (args.includes('-e')) return ok();
      if (command === 'pg_dump' && args[0] === '--version') return ok('pg_dump (PostgreSQL) 17.4');
      if (args.includes('install') && options.cwd) fakeServerInstall(options.cwd);
      if (command === 'npm' && args[0] === 'config') return ok('');
      if (command === 'systemctl' && args.includes('show-environment')) return host.busOk ? ok('PATH=/usr/bin') : { code: 1, stdout: '', stderr: 'Failed to connect to bus' };
      if (command === 'systemctl' && args.includes('restart') && args.at(-1) === 'magnus-server.service') {
        const linked = project.linkedVersion();
        host.onRestart?.();
        if (linked && host.failRestartFor.has(linked)) return { code: 1, stdout: '', stderr: 'Job for magnus-server.service failed' };
        host.serves.version = linked;
        writeRuntime(linked);
      }
      return ok();
    },
    fetch: (async () => new Response(JSON.stringify({ versions, ...packument }), { status: 200 })) as typeof fetch,
    now: () => new Date(clock),
    sleep: async (ms: number) => { clock += ms; },
    log: (line: string) => { host.logs.push(line); },
    warn: (line: string) => { host.logs.push(line); },
    confirm: async () => false,
    probe: async () => (host.serves.version && host.failHealthFor.has(host.serves.version) ? 503 : 200),
    freeBytes: () => host.free,
    env: { XDG_CONFIG_HOME: join(project.dir, 'xdg') },
    nodeVersion: 'v24.22.1',
    isRoot: false,
    uid: process.getuid?.() ?? null,
    platform: 'linux',
  };
  return host;
}

const options = (project: Project, extra: Partial<UpgradeOptions> = {}): UpgradeOptions => ({
  dir: project.dir, dryRun: false, allowMajor: false, yes: false, generateSecrets: false, registry: 'https://registry.example.com',
  healthTimeoutMs: 10_000, resume: false, ...extra,
});

const registry = (...releases: Array<ReturnType<typeof manifest>>) =>
  Object.fromEntries([['1.0.3', {}], ...releases.map((m) => [m.version, { magnusRelease: m }])]);

const rollbackOptions = (project: Project, extra: Partial<Parameters<typeof rollback>[1]> = {}) =>
  ({ dir: project.dir, restoreDb: false, yes: false, healthTimeoutMs: 10_000, ...extra });

describe('magnus upgrade', () => {
  it('checks, backs up, migrates, switches and records a healthy upgrade', async () => {
    const project = makeProject();
    const host = makeHost(project, registry(manifest('1.1.0')));
    host.pending = [{ name: '20261101000000_x', impact: 'fast', note: '' }];
    expect(await upgrade(host.io, options(project))).toBe(0);
    const order = host.calls.filter((call) => call.startsWith('server 1.1.0') || call.startsWith('systemctl --user restart'));
    expect(order).toEqual(['server 1.1.0 migrations', 'server 1.1.0 --version', 'server 1.1.0 check', 'server 1.1.0 backup', 'server 1.1.0 migrate',
      'systemctl --user restart magnus-server.service', 'systemctl --user restart magnus-ui.service']);
    const saved = Project.load(project.dir);
    expect(saved.state).toMatchObject({ current: '1.1.0', previous: '1.0.3' });
    expect(saved.state.inProgress).toBeUndefined();
    expect(saved.state.history.at(-1)).toMatchObject({ result: 'ok', migrations: ['20261101000000_x'] });
    expect(readlinkSync(project.path('current'))).toBe(join('versions', '1.1.0'));
    expect(readFileSync(project.envFile('server'), 'utf8')).toMatch(/^MAGNUS_RUNTIME_FILE=.*run\/server-runtime\.json$/m);
    expect(existsSync(`${project.envFile('server')}.bak`)).toBe(true);
  });

  it('switches back and prints the restore command when the new version is unhealthy', async () => {
    const project = makeProject();
    const host = makeHost(project, registry(manifest('1.1.0')));
    host.pending = [{ name: '20261101000000_x', impact: 'fast', note: '' }];
    host.failHealthFor.add('1.1.0');
    expect(await upgrade(host.io, options(project))).toBe(1);
    const saved = Project.load(project.dir);
    expect(saved.state.current).toBe('1.0.3');
    expect(saved.state.inProgress).toBeUndefined();
    expect(saved.state.history.at(-1)).toMatchObject({ result: 'reverted' });
    expect(readlinkSync(project.path('current'))).toBe(join('versions', '1.0.3'));
    expect(host.logs.join('\n')).toMatch(/magnus restore .*x\.dump --dir /);
  });

  it('treats a failing restart like a failed health check and switches back', async () => {
    const project = makeProject();
    const host = makeHost(project, registry(manifest('1.1.0')));
    host.failRestartFor.add('1.1.0');
    expect(await upgrade(host.io, options(project))).toBe(1);
    expect(Project.load(project.dir).state).toMatchObject({ current: '1.0.3' });
    expect(Project.load(project.dir).state.inProgress).toBeUndefined();
    expect(host.logs.join('\n')).toMatch(/the restart failed.*switching back/s);
    expect(host.serves.version).toBe('1.0.3');
  });

  it('lets a running migration finish on SIGTERM, then stops before switching', async () => {
    const project = makeProject();
    const host = makeHost(project, registry(manifest('1.1.0')));
    host.pending = [{ name: 'm1', impact: 'fast', note: '' }];
    host.onMigrate = () => { process.emit('SIGTERM'); };
    expect(await upgrade(host.io, options(project))).toBe(130);
    expect(host.applied.has('m1')).toBe(true);
    const saved = Project.load(project.dir);
    expect(saved.state.current).toBe('1.0.3');
    expect(saved.state.inProgress).toBeUndefined();
    expect(saved.state.history.at(-1)).toMatchObject({ result: 'failed', reason: 'interrupted (SIGTERM)' });
    expect(host.calls.some((call) => call.includes('restart'))).toBe(false);
    expect(host.logs.join('\n')).toMatch(/magnus restore/);
    expect(process.listenerCount('SIGTERM')).toBe(0);
  });

  it('switches back when interrupted while waiting for health', async () => {
    const project = makeProject();
    const host = makeHost(project, registry(manifest('1.1.0')));
    host.failHealthFor.add('1.1.0');
    host.onRestart = () => { if (project.linkedVersion() === '1.1.0') process.emit('SIGINT'); };
    expect(await upgrade(host.io, options(project))).toBe(1);
    expect(Project.load(project.dir).state.history.at(-1)).toMatchObject({ result: 'reverted', reason: expect.stringMatching(/interrupted/) });
    expect(host.serves.version).toBe('1.0.3');
  });

  it('refuses to run over an interrupted upgrade and can resume it or roll it back', async () => {
    const project = makeProject();
    const host = makeHost(project, registry(manifest('1.1.0')));
    fakeServerInstall(project.versionDir('1.1.0'));
    project.switchCurrent('1.1.0');
    project.state.inProgress = { phase: 'health', from: '1.0.3', to: '1.1.0', migrations: ['m1'], oneWay: [], startedAt: '2026-11-01T00:00:00Z', pid: 1,
      backup: join(project.dir, 'backups', 'pre.dump') };
    project.save();
    await expect(upgrade(host.io, options(project))).rejects.toThrow(/interrupted during "health".*upgrade --resume.*rollback.*--restore-db/s);
    expect(await upgrade(host.io, options(project, { resume: true }))).toBe(0);
    const saved = Project.load(project.dir);
    expect(saved.state).toMatchObject({ current: '1.1.0', previous: '1.0.3' });
    expect(saved.state.inProgress).toBeUndefined();
    expect(saved.state.history.at(-1)).toMatchObject({ result: 'ok', backup: join(project.dir, 'backups', 'pre.dump') });

    const other = makeProject();
    const otherHost = makeHost(other, registry(manifest('1.1.0')));
    fakeServerInstall(other.versionDir('1.1.0'));
    other.switchCurrent('1.1.0');
    other.state.inProgress = { phase: 'restart', from: '1.0.3', to: '1.1.0', migrations: [], oneWay: [], startedAt: '2026-11-01T00:00:00Z', pid: 1 };
    other.save();
    expect(await rollback(otherHost.io, rollbackOptions(other))).toBe(0);
    expect(Project.load(other.dir).state.current).toBe('1.0.3');
    expect(Project.load(other.dir).state.inProgress).toBeUndefined();
    expect(readlinkSync(other.path('current'))).toBe(join('versions', '1.0.3'));
  });

  it('runs check and a start-up smoke test before the backup; a crashing check fails', async () => {
    const project = makeProject();
    const host = makeHost(project, registry(manifest('1.1.0')));
    host.pending = [{ name: 'm1', impact: 'fast', note: '' }];
    host.checkOutput = 'Startup error: Cannot find module';
    await expect(upgrade(host.io, options(project))).rejects.toThrow(/1\.0\.3 is still serving.*check` crashed or printed no results/s);
    expect(host.calls).not.toContain('server 1.1.0 backup');
    expect(host.calls.some((call) => call.includes('-e'))).toBe(true);
    host.checkOutput = JSON.stringify({ results: [{ name: 'secrets', status: 'fail', message: 'JWT_SECRET too short' }] });
    await expect(upgrade(host.io, options(project))).rejects.toThrow(/JWT_SECRET too short/);
    expect(host.applied.size).toBe(0);
  });

  it('refuses a database with failed migrations before any backup', async () => {
    const project = makeProject();
    const host = makeHost(project, registry(manifest('1.1.0')));
    host.failed = ['m0'];
    await expect(upgrade(host.io, options(project))).rejects.toThrow(/m0 failed earlier.*prisma migrate resolve/s);
    expect(host.calls).not.toContain('server 1.1.0 backup');
  });

  it('does not start the old version over one-way migrations after a failed upgrade', async () => {
    const project = makeProject();
    const host = makeHost(project, registry(manifest('1.1.0')));
    host.pending = [{ name: 'drop', impact: 'one-way', note: 'drops a column' }];
    host.failHealthFor.add('1.1.0');
    expect(await upgrade(host.io, options(project, { yes: true }))).toBe(1);
    expect(host.serves.version).toBe('1.1.0');
    expect(host.calls).toContain('systemctl --user stop magnus-server.service');
    expect(host.logs.join('\n')).toMatch(/NOT serving \(not started: 1\.1\.0 applied one-way migration\(s\) drop.*magnus restore/s);
    expect(Project.load(project.dir).state.history.at(-1)).toMatchObject({ result: 'reverted', oneWay: ['drop'] });
  });

  it('never crosses a major version or downgrades', async () => {
    const project = makeProject();
    const host = makeHost(project, registry(manifest('1.1.0'), manifest('2.0.0')));
    expect(await upgrade(host.io, options(project, { dryRun: true }))).toBe(0);
    expect(host.logs.join('\n')).toMatch(/Upgrade 1\.0\.3 -> 1\.1\.0/);
    await expect(upgrade(host.io, options(project, { to: '2.0.0' }))).rejects.toThrow(/crosses a major version/);
    const older = makeProject({ current: '1.1.0' });
    fakeServerInstall(older.versionDir('1.1.0'));
    await expect(upgrade(makeHost(older, registry(manifest('1.1.0'))).io, options(older, { to: '1.0.3' }))).rejects.toThrow(/use rollback/);
  });

  it('names the stepping stone when minUpgradeFrom blocks the path', async () => {
    const project = makeProject();
    const host = makeHost(project, registry(manifest('1.1.0'), manifest('1.2.0', { minUpgradeFrom: '1.1.0' })));
    await expect(upgrade(host.io, options(project, { to: '1.2.0' }))).rejects.toThrow(/magnus upgrade --to 1\.1\.0/);
  });

  it('reports an available major instead of taking it', async () => {
    const project = makeProject({ current: '1.1.0' });
    fakeServerInstall(project.versionDir('1.1.0'));
    const host = makeHost(project, registry(manifest('1.1.0'), manifest('2.0.0')));
    expect(await upgrade(host.io, options(project))).toBe(0);
    expect(host.logs.join('\n')).toMatch(/2\.0\.0 is available\. Major upgrades are never automatic/);
  });

  it('stops before installing when a new required setting is missing, and can generate secrets', async () => {
    const env = [{ name: 'EXAMPLE_SIGNING_KEY', component: 'server', secret: true, description: 'Signs examples.' }];
    const project = makeProject();
    const host = makeHost(project, registry(manifest('1.1.0', { newRequiredEnv: env })));
    await expect(upgrade(host.io, options(project))).rejects.toThrow(/EXAMPLE_SIGNING_KEY.*--generate-secrets/s);
    expect(host.calls.some((call) => call.includes('install'))).toBe(false);
    expect(await upgrade(host.io, options(project, { generateSecrets: true }))).toBe(0);
    expect(readFileSync(project.envFile('server'), 'utf8')).toMatch(/^EXAMPLE_SIGNING_KEY=[0-9a-f]{64}$/m);
  });

  it('refuses slow or one-way migrations without confirmation, before any backup', async () => {
    const project = makeProject();
    const host = makeHost(project, registry(manifest('1.1.0', { migrations: [{ name: 'y', impact: 'one-way', note: 'drops a column' }] })));
    host.pending = [{ name: 'y', impact: 'one-way', note: 'drops a column' }];
    await expect(upgrade(host.io, options(project))).rejects.toThrow(UpgradeError);
    expect(host.calls).not.toContain('server 1.1.0 backup');
    expect(host.logs.join('\n')).toMatch(/ONE-WAY/);
  });

  it('checks the Node.js the services run, not the one running magnus', async () => {
    const project = makeProject();
    const host = makeHost(project, registry(manifest('1.1.0', { engines: { node: '^26.13.0' } })));
    await expect(upgrade(host.io, options(project))).rejects.toThrow(/needs Node\.js \^26\.13\.0; the services run .*--node/);
    mkdirSync(project.path('units'));
    writeFileSync(project.path('units', 'magnus-server.service'), serverUnit({ project, nodePath: '/opt/node-22/bin/node', afterUnits: [] }));
    const fresh = Project.load(project.dir);
    expect(fresh.nodePath()).toBe('/opt/node-22/bin/node');
  });

  it('--node rewrites the generated units, here and in the systemd unit directory', async () => {
    const project = makeProject();
    const old = '# Generated by `magnus init`\n[Unit]\nDescription=Magnus server\n\n[Service]\n'
      + `ExecStart=/usr/bin/node ${project.bin('current', 'magnus-server')} start\n`;
    const installed = join(project.dir, 'xdg', 'systemd', 'user');
    for (const dir of [project.path('units'), installed]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'magnus-server.service'), old);
    }
    const host = makeHost(project, registry(manifest('1.1.0')));
    expect(await upgrade(host.io, options(project, { nodePath: process.execPath }))).toBe(0);
    for (const dir of [project.path('units'), installed]) {
      const unit = readFileSync(join(dir, 'magnus-server.service'), 'utf8');
      expect(unit).toContain(`ExecStart=${process.execPath} `);
      expect(unit).toContain('StartLimitBurst=3');
    }
    expect(Project.load(project.dir).state.nodePath).toBe(process.execPath);
  });

  it('uses the release manifest\'s allowScripts for the install', async () => {
    const project = makeProject();
    const host = makeHost(project, registry(manifest('1.1.0', { allowScripts: { 'example-native': true } })));
    expect(await upgrade(host.io, options(project))).toBe(0);
    const pins = JSON.parse(readFileSync(join(project.versionDir('1.1.0'), 'package.json'), 'utf8')) as { allowScripts: unknown };
    expect(pins.allowScripts).toEqual({ 'example-native': true });
  });

  it('stops before changing anything without disk space or a session bus', async () => {
    const project = makeProject();
    const host = makeHost(project, registry(manifest('1.1.0')));
    host.free = 10 * 1024 ** 2;
    await expect(upgrade(host.io, options(project))).rejects.toThrow(/MiB|GiB free/);
    expect(host.calls.some((call) => call.includes('install'))).toBe(false);
    host.free = 1e15;
    host.busOk = false;
    expect(await upgrade(host.io, options(project, { dryRun: true }))).toBe(1);
    expect(host.logs.join('\n')).toMatch(/session bus/);
    await expect(upgrade(host.io, options(project))).rejects.toThrow(/session bus/);
    expect(existsSync(project.versionDir('1.1.0'))).toBe(false);
  });

  it('refuses user units for another account (sudo) and a project it does not own', async () => {
    const project = makeProject();
    const host = makeHost(project, registry(manifest('1.1.0')));
    host.io.uid = (host.io.uid ?? 0) + 1;
    await expect(upgrade(host.io, options(project))).rejects.toThrow(/belongs to uid .*without sudo/);
  });

  it('a dry run changes nothing', async () => {
    const project = makeProject();
    const host = makeHost(project, registry(manifest('1.1.0')));
    mkdirSync(project.path('versions', '1.0.9.tmp'), { recursive: true });
    expect(await upgrade(host.io, options(project, { dryRun: true }))).toBe(0);
    expect(existsSync(project.versionDir('1.1.0'))).toBe(false);
    expect(existsSync(project.path('versions', '1.0.9.tmp'))).toBe(true);
    expect(Project.load(project.dir).state.current).toBe('1.0.3');
    expect(host.logs.join('\n')).toMatch(/Prerequisites look fine/);
  });

  it('one upgrade at a time, naming the lock file', async () => {
    const project = makeProject();
    const held = acquireLock(project.path('run', 'upgrade.lock'));
    try {
      await expect(upgrade(makeHost(project, registry(manifest('1.1.0'))).io, options(project))).rejects.toThrow(/holds the lock .*upgrade\.lock.*--break-lock/);
    } finally {
      held();
    }
  });
});

describe('release catalog', () => {
  it('refuses a manifest it cannot read instead of guessing one', async () => {
    const project = makeProject();
    const host = makeHost(project, { '1.0.3': {}, '1.1.0': { magnusRelease: { schema: 2, version: '1.1.0' } }, '1.1.1': {} });
    const catalog = await fetchRegistryCatalog(host.io, 'https://registry.example.com');
    expect(() => releaseFor(catalog, '1.1.0')).toThrow(/newer format.*npx @hivemagnus\/magnus@latest upgrade/);
    expect(() => releaseFor(catalog, '1.1.1')).toThrow(/no release manifest/);
    expect(releaseFor(catalog, '1.0.3').components['@hivemagnus/magnus-server']).toBe('1.0.3');
  });

  it('treats a missing package as an error, not as "already on the newest"', async () => {
    const project = makeProject();
    const host = makeHost(project, {});
    host.io.fetch = (async () => new Response('{}', { status: 404 })) as typeof fetch;
    await expect(upgrade(host.io, options(project))).rejects.toThrow(/has no @hivemagnus\/magnus \(404/);
  });

  it('skips deprecated releases and never passes dist-tags.latest on its own', async () => {
    const project = makeProject();
    const host = makeHost(project, registry(manifest('1.1.0'), manifest('1.1.1'), manifest('1.2.0-rc.1'), manifest('1.3.0')),
      { 'dist-tags': { latest: '1.1.1' } });
    const catalog = await fetchRegistryCatalog(host.io, 'https://registry.example.com');
    expect(pickTarget(catalog, '1.0.3')).toBe('1.1.1');
    catalog.deprecated = new Set(['1.1.1']);
    expect(pickTarget(catalog, '1.0.3')).toBe('1.1.0');
    expect(pickTarget(catalog, '1.0.3', '1.3.0')).toBe('1.3.0');
    expect(automaticCandidates(catalog)).not.toContain('1.3.0');
  });

  it('falls back to npm\'s configured registry', async () => {
    const project = makeProject();
    const host = makeHost(project, {});
    expect(await resolveRegistry(host.io, undefined, async () => 'https://npm.example.com/')).toBe('https://npm.example.com/');
    expect(await resolveRegistry({ ...host.io, env: { MAGNUS_UPDATE_REGISTRY: 'https://mirror.example.com' } }, undefined, async () => 'x')).toBe('https://mirror.example.com');
    expect(await resolveRegistry(host.io, undefined, async () => null)).toBe('https://registry.npmjs.org');
  });
});

describe('magnus rollback', () => {
  it('switches back and only restores the dump when asked', async () => {
    const project = makeProject();
    const host = makeHost(project, registry(manifest('1.1.0')));
    host.pending = [{ name: 'm1', impact: 'fast', note: '' }];
    expect(await upgrade(host.io, options(project))).toBe(0);
    host.logs.length = 0;
    expect(await rollback(host.io, rollbackOptions(project))).toBe(0);
    expect(host.logs.join('\n')).toMatch(/1 migration\(s\) that 1\.0\.3 does not know: m1.*re-run with --restore-db/s);
    expect(host.calls.some((call) => call.startsWith('pg_restore'))).toBe(false);
    expect(Project.load(project.dir).state).toMatchObject({ current: '1.0.3', previous: null });
  });

  it('restores the pre-upgrade dump with --restore-db --yes into a clean schema, without the password in argv', async () => {
    const project = makeProject();
    writeFileSync(project.envFile('server'), 'DATABASE_URL=postgresql://magnus:secret-value@db.example.com:5432/magnus\n');
    const host = makeHost(project, registry(manifest('1.1.0')));
    host.pending = [{ name: 'm1', impact: 'fast', note: '' }];
    expect(await upgrade(host.io, options(project))).toBe(0);
    mkdirSync(project.path('backups'), { recursive: true });
    writeFileSync(join(project.dir, 'backups', 'x.dump'), 'PGDMP');
    expect(await rollback(host.io, rollbackOptions(project, { restoreDb: true, yes: true }))).toBe(0);
    const restoreCall = host.calls.find((call) => call.startsWith('pg_restore --single-transaction'));
    expect(restoreCall).toMatch(/-d postgresql:\/\/magnus@db\.example\.com:5432\/magnus/);
    expect(host.calls.join('\n')).not.toMatch(/secret-value/);
    const swap = host.calls.findIndex((call) => call.startsWith('psql') && call.includes('RENAME TO'));
    expect(swap).toBeGreaterThan(host.calls.indexOf('systemctl --user stop magnus-ui.service'));
    expect(swap).toBeLessThan(host.calls.indexOf(restoreCall!));
  });

  it('refuses old code over unknown one-way migrations unless --restore-db or --force', async () => {
    const project = makeProject();
    const host = makeHost(project, registry(manifest('1.1.0')));
    host.pending = [{ name: 'drop', impact: 'one-way', note: '' }];
    expect(await upgrade(host.io, options(project, { yes: true }))).toBe(0);
    await expect(rollback(host.io, rollbackOptions(project))).rejects.toThrow(/drop is one-way.*--restore-db.*--force/s);
    expect(Project.load(project.dir).state.current).toBe('1.1.0');
    expect(await rollback(host.io, rollbackOptions(project, { force: true }))).toBe(0);
  });

  it('says when --restore-db cannot be honoured', async () => {
    const project = makeProject();
    const host = makeHost(project, registry(manifest('1.1.0')));
    expect(await upgrade(host.io, options(project))).toBe(0);
    await expect(rollback(host.io, rollbackOptions(project, { restoreDb: true, yes: true }))).rejects.toThrow(/cannot be honoured: no dump/);
  });

  it('starts the services again when the restore fails', async () => {
    const project = makeProject();
    writeFileSync(project.envFile('server'), 'DATABASE_URL=postgresql://magnus@db.example.com/magnus\n');
    const host = makeHost(project, registry(manifest('1.1.0')));
    host.pending = [{ name: 'm1', impact: 'fast', note: '' }];
    expect(await upgrade(host.io, options(project))).toBe(0);
    mkdirSync(project.path('backups'), { recursive: true });
    writeFileSync(join(project.dir, 'backups', 'x.dump'), 'PGDMP');
    const run = host.io.run;
    host.io.run = async (command, args, runOptions) => (command === 'pg_restore' && args.includes('--single-transaction')
      ? { code: 1, stdout: '', stderr: 'pg_restore: error: boom' } : run(command, args, runOptions));
    await expect(rollback(host.io, rollbackOptions(project, { restoreDb: true, yes: true }))).rejects.toThrow(/restore of .* failed.*started again/s);
    expect(host.calls.filter((call) => call === 'systemctl --user restart magnus-server.service').length).toBeGreaterThan(1);
    expect(host.calls.some((call) => call.startsWith('psql') && call.includes('DROP SCHEMA public CASCADE'))).toBe(true);
    expect(Project.load(project.dir).state.current).toBe('1.1.0');
  });
});

describe('magnus restore', () => {
  it('stops the services, restores and starts the serving version', async () => {
    const project = makeProject();
    writeFileSync(project.envFile('server'), 'DATABASE_URL=postgresql://magnus@db.example.com/magnus\n');
    const host = makeHost(project, {});
    mkdirSync(project.path('backups'));
    const file = join(project.dir, 'backups', 'a.dump');
    writeFileSync(file, 'PGDMP');
    await expect(restore(host.io, { dir: project.dir, file, yes: false, healthTimeoutMs: 10_000 })).rejects.toThrow(/not confirmed/);
    expect(await restore(host.io, { dir: project.dir, file, yes: true, healthTimeoutMs: 10_000 })).toBe(0);
    const stop = host.calls.indexOf('systemctl --user stop magnus-server.service');
    const restored = host.calls.findIndex((call) => call.startsWith('pg_restore --single-transaction'));
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(restored).toBeGreaterThan(stop);
    expect(host.calls.lastIndexOf('systemctl --user restart magnus-server.service')).toBeGreaterThan(restored);
    expect(Project.load(project.dir).state.history.at(-1)).toMatchObject({ action: 'restore', result: 'ok' });
  });
});

describe('locks', () => {
  it('takes over a stale lock, hands it to a child and never removes a lock it no longer holds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magnus-lock-'));
    const path = join(dir, 'upgrade.lock');
    writeFileSync(path, `${2 ** 22 + 4321}\n`);
    const parent = acquireLock(path);
    expect(parseLock(readFileSync(path, 'utf8'))).toMatchObject({ pid: process.pid, token: parent.token });
    expect(() => acquireLock(path)).toThrow(/holds the lock/);
    const child = acquireLock(path, { inheritToken: parent.token });
    parent();
    expect(existsSync(path)).toBe(true);
    child();
    expect(existsSync(path)).toBe(false);
    writeFileSync(path, `${process.pid}\n${JSON.stringify({ bootId: 'another-boot', startTime: '1', token: 'x', command: 'magnus upgrade' })}\n`);
    acquireLock(path)();
    const live = acquireLock(path);
    acquireLock(path, { breakLock: true })();
    live();
  });
});

describe('generated files', () => {
  it('units carry a start limit, and older units are brought up to date', () => {
    const project = makeProject({ scope: 'system' });
    const unit = serverUnit({ project, nodePath: '/usr/bin/node', afterUnits: [], extraWritable: ['/srv/magnus-data'] });
    expect(unit).toMatch(/StartLimitIntervalSec=300\nStartLimitBurst=3/);
    expect(unit).toMatch(/ReadWritePaths=\/srv\/magnus-data/);
    const old = '# Generated by `magnus init`\n[Unit]\nDescription=Magnus server\n\n[Service]\nExecStart=/usr/bin/node /x/cli.js start\n';
    const refreshed = refreshUnit(old, '/opt/node-24/bin/node');
    expect(refreshed).toBe('# Generated by `magnus init`\n[Unit]\nDescription=Magnus server\nStartLimitIntervalSec=300\nStartLimitBurst=3\n\n[Service]\nExecStart=/opt/node-24/bin/node /x/cli.js start\n');
    expect(refreshUnit(refreshed, '/opt/node-24/bin/node')).toBe(refreshed);
  });

  it('compose project names are per project', () => {
    expect(composeProjectName('/opt/magnus')).toMatch(/^magnus-deps-magnus-[a-z0-9]+$/);
    expect(composeProjectName('/opt/magnus')).not.toBe(composeProjectName('/srv/magnus'));
    expect(makeProject().composeProject()).toBe('magnus-deps');
  });

  it('env files are rewritten atomically with their mode and a .bak', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magnus-env-'));
    const file = join(dir, 'server.env');
    writeFileSync(file, 'A=1\n', { mode: 0o640 });
    expect(appendMissing(file, [{ name: 'A', value: '2' }, { name: 'B', value: '3' }], 'note')).toEqual(['B']);
    expect(readFileSync(file, 'utf8')).toBe('A=1\n\n# note\nB=3\n');
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(readFileSync(`${file}.bak`, 'utf8')).toBe('A=1\n');
  });

  it('a broken state file names itself and the backup copy', () => {
    const project = makeProject();
    project.save();
    writeFileSync(Project.file(project.dir), '{ broken');
    expect(() => Project.load(project.dir)).toThrow(/magnus-project\.json is not valid JSON.*magnus-project\.json\.bak/s);
  });

  it('prunes old dumps but keeps the newest per label and the protected one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magnus-dumps-'));
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(dir, `${i}.dump`), 'PGDMP');
      writeFileSync(join(dir, `${i}.dump.json`), JSON.stringify({ label: i === 0 ? 'other' : 'same', createdAt: `2026-11-0${i + 1}T00:00:00Z` }));
    }
    expect(pruneBackups(dir, 1).map((file) => file.slice(dir.length + 1))).toEqual(['2.dump', '1.dump']);
    expect(existsSync(join(dir, '0.dump'))).toBe(true);
  });
});

describe('init', () => {
  it('refuses systemd off Linux before writing anything', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'magnus-init-')), 'project');
    const host = makeHost(makeProject(), {});
    host.io.platform = 'darwin';
    const initOptions = { dir, system: false, supervisor: 'systemd', registry: 'https://registry.example.com', serverPort: 4000, uiPort: 3000,
      postgresPort: 5432, redisPort: 6379, adminUser: 'admin', ui: true, start: true, autoMigrate: true, healthTimeoutMs: 1000 } as InitOptions;
    await expect(init(host.io, initOptions)).rejects.toThrow(/need Linux.*--supervisor none/s);
    expect(existsSync(dir)).toBe(false);
  });
});

describe('magnus arguments', () => {
  it('parses values, flags and rejects unknown options', () => {
    const parsed = parseArgs(['upgrade', '--to=1.1.0', '--dry-run', '--dir', '/opt/magnus']);
    expect(parsed.command).toBe('upgrade');
    expect(parsed.values.get('--to')).toBe('1.1.0');
    expect(parsed.flags.has('--dry-run')).toBe(true);
    expect(parseArgs(['init', '--version', '1.0.3']).values.get('--version')).toBe('1.0.3');
    expect(parseArgs(['--version']).command).toBe('version');
    expect(parseArgs(['restore', '/opt/magnus/backups/a.dump', '--yes']).args).toEqual(['/opt/magnus/backups/a.dump']);
    expect(parseArgs(['upgrade', '--node', '/opt/node/bin/node', '--break-lock']).values.get('--node')).toBe('/opt/node/bin/node');
    expect(() => parseArgs(['upgrade', '--frobnicate'])).toThrow(ArgsError);
    expect(() => parseArgs(['upgrade', '--to'])).toThrow(ArgsError);
  });
});

describe('installing from --source', async () => {
  const { overridesFor } = await import('./install.js');
  const { releaseManifestSchema } = await import('@hivemagnus/magnus-contracts');
  it('pins sibling tarballs of the release, and the engine release only inside the engine', () => {
    const tarballs = new Map([
      ['@hivemagnus/magnus-skills@1.1.0', '/packs/skills-1.1.0.tgz'],
      ['@hivemagnus/magnus-contracts@1.1.0', '/packs/contracts-1.1.0.tgz'],
      ['@hivemagnus/magnus@1.1.0', '/packs/magnus-1.1.0.tgz'],
    ]);
    const catalog = { versions: ['1.1.0'], manifests: new Map(), tarballs };
    expect(overridesFor(releaseManifestSchema.parse(manifest('1.1.0')), catalog, '1.1.0')).toEqual({
      '@hivemagnus/magnus-skills': 'file:/packs/skills-1.1.0.tgz',
      '@hivemagnus/magnus-contracts': 'file:/packs/contracts-1.1.0.tgz',
    });
    // Installing 1.0.3 from the registry with a 1.1.0 engine from --source.
    expect(overridesFor(releaseManifestSchema.parse(manifest('1.0.3')), catalog, '1.1.0')).toEqual({
      '@hivemagnus/magnus': { '@hivemagnus/magnus-skills': 'file:/packs/skills-1.1.0.tgz', '@hivemagnus/magnus-contracts': 'file:/packs/contracts-1.1.0.tgz' },
    });
  });
});

describe('health after a restart', async () => {
  const { waitForHealthy } = await import('./health.js');
  it('does not accept the previous server as a pre-1.1 target that is still starting', async () => {
    const project = makeProject();
    const host = makeHost(project, {});
    mkdirSync(project.path('run'), { recursive: true });
    // The 1.1.0 server that is being replaced is still alive (this test process stands in for it).
    writeFileSync(project.path('run', 'server-runtime.json'), JSON.stringify({ version: '1.1.0', pid: process.pid, port: 4000, startedAt: '2026-10-31T00:00:00.000Z' }));
    const stale = await waitForHealthy(host.io, project, { version: '1.0.3', startedAfter: host.io.now(), timeoutMs: 6_000 });
    expect(stale).toMatchObject({ ok: false, detail: expect.stringMatching(/no server has started since the restart \(the last one ran 1\.1\.0\)/) });
    writeFileSync(project.path('run', 'server-runtime.json'), JSON.stringify({ version: '1.1.0', pid: 2 ** 22 + 12345, port: 4000, startedAt: '2026-10-31T00:00:00.000Z' }));
    expect((await waitForHealthy(host.io, project, { version: '1.0.3', startedAfter: host.io.now(), timeoutMs: 6_000 })).ok).toBe(true);
  });

  it('finds a server started without the unit (MAGNUS_HOME/run) and probes its port and bind address', async () => {
    const project = makeProject({ supervisor: 'none' });
    const host = makeHost(project, {});
    const probed: string[] = [];
    host.io.probe = async (url) => { probed.push(url); return 200; };
    mkdirSync(project.path('data', 'run'), { recursive: true });
    writeFileSync(project.path('data', 'run', 'server-runtime.json'), JSON.stringify({ version: '1.1.0', pid: 7, port: 4443, host: '192.0.2.10', startedAt: host.io.now().toISOString() }));
    expect((await waitForHealthy(host.io, project, { version: '1.1.0', startedAfter: host.io.now(), timeoutMs: 6_000 })).ok).toBe(true);
    expect(probed[0]).toBe('https://192.0.2.10:4443/api/v1/health');
  });
});
