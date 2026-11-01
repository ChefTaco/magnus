import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Io, RunOptions, RunResult } from './io.js';
import { ArgsError, parseArgs } from './main.js';
import { acquireLock, Project, type ProjectState } from './project.js';
import { rollback } from './rollback.js';
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
  pending: Array<{ name: string; impact: string; note: string }>;
  failHealthFor: Set<string>;
}

function fakeServerInstall(dir: string): void {
  for (const bin of [['magnus-server', 'dist', 'cli.js'], ['magnus-ui', 'bin', 'magnus-ui.mjs'], ['magnus', 'dist', 'cli.js']]) {
    const path = join(dir, 'node_modules', '@hivemagnus', ...bin);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '');
  }
  writeFileSync(join(dir, 'package.json'), '{}');
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

function makeHost(project: Project, versions: Record<string, unknown>): Host {
  let clock = Date.parse('2026-11-01T00:00:00Z');
  const host: Host = { io: undefined as unknown as Io, calls: [], logs: [], serves: { version: '1.0.3' }, pending: [], failHealthFor: new Set() };
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
  host.io = {
    run: async (command: string, args: readonly string[], options: RunOptions = {}) => {
      const binIndex = args.findIndex((arg) => arg.endsWith(join('magnus-server', 'dist', 'cli.js')));
      if (command === process.execPath && binIndex >= 0) {
        const sub = args[binIndex + 1];
        host.calls.push(`server ${args[binIndex].split('/versions/')[1]?.split('/')[0]} ${sub}`);
        if (sub === 'migrations') return ok(JSON.stringify({ pending: host.pending }));
        if (sub === 'backup') return ok(JSON.stringify({ file: join(project.dir, 'backups', 'x.dump') }));
        if (sub === 'check') return ok(JSON.stringify({ results: [{ name: 'secrets', status: 'pass', message: '' }] }));
        return ok();
      }
      host.calls.push(`${command} ${args.join(' ')}`);
      if (command === 'npm' && args[0] === 'install' && options.cwd) fakeServerInstall(options.cwd);
      if (command === 'systemctl' && args.includes('restart') && args.at(-1) === 'magnus-server.service') {
        const linked = project.linkedVersion();
        host.serves.version = linked;
        mkdirSync(project.path('run'), { recursive: true });
        writeFileSync(project.path('run', 'server-runtime.json'), JSON.stringify({ version: linked, pid: 42, port: 4000, startedAt: new Date(clock).toISOString() }));
      }
      return ok();
    },
    fetch: (async () => new Response(JSON.stringify({ versions }), { status: 200 })) as typeof fetch,
    now: () => new Date(clock),
    sleep: async (ms: number) => { clock += ms; },
    log: (line: string) => { host.logs.push(line); },
    warn: (line: string) => { host.logs.push(line); },
    confirm: async () => false,
    probe: async () => (host.serves.version && host.failHealthFor.has(host.serves.version) ? 503 : 200),
    env: {},
    nodeVersion: 'v24.22.1',
    isRoot: false,
  };
  return host;
}

const options = (project: Project, extra: Partial<UpgradeOptions> = {}): UpgradeOptions => ({
  dir: project.dir, dryRun: false, allowMajor: false, yes: false, generateSecrets: false, registry: 'https://registry.example.com',
  healthTimeoutMs: 10_000, resume: false, ...extra,
});

const registry = (...releases: Array<ReturnType<typeof manifest>>) =>
  Object.fromEntries([['1.0.3', {}], ...releases.map((m) => [m.version, { magnusRelease: m }])]);

describe('magnus upgrade', () => {
  it('backs up, migrates, switches and records a healthy upgrade', async () => {
    const project = makeProject();
    const host = makeHost(project, registry(manifest('1.1.0')));
    host.pending = [{ name: '20261101000000_x', impact: 'fast', note: '' }];
    expect(await upgrade(host.io, options(project))).toBe(0);
    const order = host.calls.filter((call) => call.startsWith('server 1.1.0') || call.startsWith('systemctl --user restart'));
    expect(order).toEqual(['server 1.1.0 migrations', 'server 1.1.0 backup', 'server 1.1.0 migrate', 'server 1.1.0 check',
      'systemctl --user restart magnus-server.service', 'systemctl --user restart magnus-ui.service']);
    const saved = Project.load(project.dir);
    expect(saved.state).toMatchObject({ current: '1.1.0', previous: '1.0.3' });
    expect(saved.state.history.at(-1)).toMatchObject({ result: 'ok', migrations: ['20261101000000_x'] });
    expect(readlinkSync(project.path('current'))).toBe(join('versions', '1.1.0'));
    const pins = JSON.parse(readFileSync(project.path('package.json'), 'utf8')) as Record<string, unknown>;
    expect(pins).toBeDefined();
  });

  it('switches back and prints the restore command when the new version is unhealthy', async () => {
    const project = makeProject();
    const host = makeHost(project, registry(manifest('1.1.0')));
    host.pending = [{ name: '20261101000000_x', impact: 'fast', note: '' }];
    host.failHealthFor.add('1.1.0');
    expect(await upgrade(host.io, options(project))).toBe(1);
    const saved = Project.load(project.dir);
    expect(saved.state.current).toBe('1.0.3');
    expect(saved.state.history.at(-1)).toMatchObject({ result: 'reverted' });
    expect(readlinkSync(project.path('current'))).toBe(join('versions', '1.0.3'));
    expect(host.logs.join('\n')).toMatch(/pg_restore --clean --if-exists --no-owner -d "\$DATABASE_URL"/);
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
    expect(host.calls.some((call) => call.startsWith('npm'))).toBe(false);
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

  it('refuses a Node.js version outside the target engines', async () => {
    const project = makeProject();
    const host = makeHost(project, registry(manifest('1.1.0', { engines: { node: '^26.13.0' } })));
    await expect(upgrade(host.io, options(project))).rejects.toThrow(/needs Node\.js \^26\.13\.0/);
  });

  it('a dry run changes nothing', async () => {
    const project = makeProject();
    const host = makeHost(project, registry(manifest('1.1.0')));
    expect(await upgrade(host.io, options(project, { dryRun: true }))).toBe(0);
    expect(existsSync(project.versionDir('1.1.0'))).toBe(false);
    expect(Project.load(project.dir).state.current).toBe('1.0.3');
  });

  it('one upgrade at a time', async () => {
    const project = makeProject();
    const held = acquireLock(project.path('run', 'upgrade.lock'));
    try {
      await expect(upgrade(makeHost(project, registry(manifest('1.1.0'))).io, options(project))).rejects.toThrow(/holds/);
    } finally {
      held();
    }
  });
});

describe('magnus rollback', () => {
  it('switches back and only restores the dump when asked', async () => {
    const project = makeProject();
    const host = makeHost(project, registry(manifest('1.1.0')));
    host.pending = [{ name: 'm1', impact: 'fast', note: '' }];
    expect(await upgrade(host.io, options(project))).toBe(0);
    host.logs.length = 0;
    expect(await rollback(host.io, { dir: project.dir, restoreDb: false, yes: false, healthTimeoutMs: 10_000 })).toBe(0);
    expect(host.logs.join('\n')).toMatch(/applied 1 migration\(s\).*re-run with --restore-db/s);
    expect(host.calls.some((call) => call.startsWith('pg_restore'))).toBe(false);
    expect(Project.load(project.dir).state).toMatchObject({ current: '1.0.3', previous: null });
  });

  it('restores the pre-upgrade dump with --restore-db --yes', async () => {
    const project = makeProject();
    writeFileSync(project.envFile('server'), 'DATABASE_URL=postgresql://magnus:secret-value@db.example.com:5432/magnus\n');
    const host = makeHost(project, registry(manifest('1.1.0')));
    host.pending = [{ name: 'm1', impact: 'fast', note: '' }];
    expect(await upgrade(host.io, options(project))).toBe(0);
    expect(await rollback(host.io, { dir: project.dir, restoreDb: true, yes: true, healthTimeoutMs: 10_000 })).toBe(0);
    const restore = host.calls.find((call) => call.startsWith('pg_restore'));
    expect(restore).toMatch(/-d postgresql:\/\/magnus@db\.example\.com:5432\/magnus/);
    expect(restore).not.toMatch(/secret-value/);
    expect(host.calls.indexOf('systemctl --user stop magnus-ui.service')).toBeLessThan(host.calls.indexOf(restore!));
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
    expect(() => parseArgs(['upgrade', '--force'])).toThrow(ArgsError);
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
});
