/**
 * `magnus init`: create a managed single-node project (server + console),
 * generate its secrets and TLS certificate, install the pinned release,
 * migrate, and start it under systemd.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { latestVersion, satisfiesRange } from '@hivemagnus/magnus-contracts';
import { generateSecret, readEnvFile } from './env-file.js';
import { waitForHealthy } from './health.js';
import { chownForService, installVersion, publishPins, serverCli } from './install.js';
import { mustRun, type Io } from './io.js';
import { acquireLock, Project, type Component, type DatabaseConfig, type ProjectState, type Supervisor } from './project.js';
import { ownPackage, releaseFor } from './release.js';
import { enableServices, restartServices, unitDirectory } from './supervisor.js';
import { depsCompose, depsEnv, serverEnv, serverUnit, uiEnv, uiUnit } from './templates.js';
import { loadCatalog, UpgradeError } from './upgrade.js';

export interface InitOptions {
  dir?: string;
  system: boolean;
  serviceUser?: string;
  supervisor: Supervisor;
  version?: string;
  source?: string;
  registry: string;
  databaseUrl?: string;
  redisUrl?: string;
  serverPort: number;
  uiPort: number;
  /** Loopback ports for the bundled PostgreSQL and Redis. */
  postgresPort: number;
  redisPort: number;
  publicHost?: string;
  adminUser: string;
  adminPassword?: string;
  tlsCert?: string;
  tlsKey?: string;
  ui: boolean;
  start: boolean;
  autoMigrate: boolean;
  healthTimeoutMs: number;
}

export function defaultProjectDir(io: Io, system: boolean): string {
  return system ? '/opt/magnus' : join(io.env['HOME'] ?? '.', '.magnus');
}

async function selfSignedCertificate(io: Io, dir: string, host: string): Promise<{ cert: string; key: string }> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const cert = join(dir, 'server.crt');
  const key = join(dir, 'server.key');
  await mustRun(io, 'openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '825',
    '-subj', `/CN=${host}`, '-addext', `subjectAltName=DNS:${host},DNS:localhost,IP:127.0.0.1`,
    '-keyout', key, '-out', cert], { capture: true }).catch((error: unknown) => {
    throw new UpgradeError(`Could not create a self-signed certificate (is openssl installed?). Pass --tls-cert and --tls-key instead. ${error instanceof Error ? error.message : String(error)}`);
  });
  return { cert, key };
}

async function hashPassword(io: Io, project: Project, version: string, password: string): Promise<string> {
  // argon2 comes with the server install; nothing extra is downloaded.
  const { stdout } = await mustRun(io, process.execPath, ['--input-type=module', '-e',
    "import argon2 from 'argon2'; console.log(await argon2.hash(process.env.MAGNUS_INIT_PASSWORD, { type: argon2.argon2id }))"],
  { cwd: project.versionDir(version), capture: true, env: { ...io.env, MAGNUS_INIT_PASSWORD: password } });
  return stdout.trim();
}

async function startDeps(io: Io, project: Project): Promise<void> {
  const args = ['compose', '-f', project.path('deps.compose.yml'), '--env-file', project.path('config', 'deps.env'), 'up', '-d', '--wait'];
  io.log('  starting PostgreSQL and Redis (docker compose)');
  await mustRun(io, 'docker', args, { capture: true });
}

export async function init(io: Io, options: InitOptions): Promise<number> {
  if (options.system && !io.isRoot) throw new UpgradeError('--system installs system services; run as root.');
  if (options.system && !options.serviceUser) throw new UpgradeError('--system needs --service-user <existing account> to run the services as.');
  const dir = resolve(options.dir ?? defaultProjectDir(io, options.system));
  if (Project.exists(dir)) throw new UpgradeError(`${dir} already holds a Magnus project. Use \`magnus upgrade\` or \`magnus status\`.`);

  const catalog = await loadCatalog(io, options);
  const own = ownPackage();
  const version = options.version
    ?? latestVersion(catalog.versions, { sameMajorAs: own.version })
    ?? own.version;
  const manifest = releaseFor(catalog, version);
  if (!satisfiesRange(io.nodeVersion, manifest.engines.node)) {
    throw new UpgradeError(`Magnus ${version} needs Node.js ${manifest.engines.node}; this is ${io.nodeVersion}.`);
  }

  const host = options.publicHost ?? hostname();
  const components: Component[] = options.ui ? ['server', 'ui'] : ['server'];
  let database: DatabaseConfig = { kind: 'external' };
  const deps = !options.databaseUrl || !options.redisUrl;
  if (deps) database = { kind: 'compose', composeFile: 'deps.compose.yml', service: 'postgres', user: 'magnus', database: 'magnus' };
  const state: ProjectState = {
    schema: 1,
    createdAt: io.now().toISOString(),
    supervisor: options.supervisor,
    scope: options.system ? 'system' : 'user',
    components,
    units: { server: 'magnus-server', ui: 'magnus-ui' },
    envFiles: { server: join('config', 'magnus-server.env'), ui: join('config', 'magnus-ui.env') },
    database,
    ports: { server: options.serverPort, ui: options.uiPort },
    current: null,
    previous: null,
    keepVersions: 3,
    history: [],
  };
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const project = new Project(dir, state);
  const release = acquireLock(project.path('run', 'upgrade.lock'));
  try {
    for (const sub of ['config', 'backups', 'run', 'versions', 'units', 'ui-data']) {
      mkdirSync(project.path(sub), { recursive: true, mode: sub === 'versions' || sub === 'units' ? 0o755 : 0o700 });
    }
    io.log(`Creating a Magnus ${version} project in ${dir}`);

    let databaseUrl = options.databaseUrl;
    let redisUrl = options.redisUrl;
    if (deps) {
      const postgresPassword = randomBytes(24).toString('hex');
      const redisPassword = randomBytes(24).toString('hex');
      writeFileSync(project.path('deps.compose.yml'), depsCompose());
      writeFileSync(project.path('config', 'deps.env'), depsEnv({ postgresPort: options.postgresPort, redisPort: options.redisPort, postgresPassword, redisPassword }), { mode: 0o600 });
      databaseUrl ??= `postgresql://magnus:${postgresPassword}@127.0.0.1:${options.postgresPort}/magnus`;
      redisUrl ??= `redis://:${redisPassword}@127.0.0.1:${options.redisPort}`;
      await startDeps(io, project);
    }

    const tls = options.tlsCert && options.tlsKey
      ? { cert: resolve(options.tlsCert), key: resolve(options.tlsKey), selfSigned: false }
      : { ...await selfSignedCertificate(io, project.path('config', 'tls'), host), selfSigned: true };

    await installVersion(io, project, manifest, catalog);

    const uiOrigin = `https://${host}:${options.uiPort}`;
    writeFileSync(project.envFile('server'), serverEnv({
      databaseUrl: databaseUrl!, redisUrl: redisUrl!, port: options.serverPort, publicUrl: `https://${host}:${options.serverPort}`,
      uiOrigin, tlsCert: tls.cert, tlsKey: tls.key, home: dir, autoMigrate: options.autoMigrate,
    }, {}), { mode: 0o600 });
    const password = options.adminPassword ?? randomBytes(12).toString('base64url');
    if (options.ui) {
      const apiSecret = readEnvFile(project.envFile('server'))['API_SECRET'] ?? generateSecret();
      writeFileSync(project.envFile('ui'), uiEnv({
        serverUrl: `https://127.0.0.1:${options.serverPort}`, serverCa: tls.selfSigned ? tls.cert : undefined, redisUrl: redisUrl!,
        publicOrigin: uiOrigin, port: options.uiPort, tlsCert: tls.cert, tlsKey: tls.key, adminUser: options.adminUser,
        adminPasswordHash: await hashPassword(io, project, version, password),
      }, apiSecret), { mode: 0o600 });
    }

    io.log('  applying database migrations');
    await serverCli(io, project, version, ['migrate']);
    project.switchCurrent(version);
    project.state.current = version;
    project.record({ action: 'init', from: null, to: version, at: io.now().toISOString(), result: 'ok', migrations: [] });
    publishPins(project, version);
    project.save();

    if (options.system && options.serviceUser) {
      await chownForService(io, options.serviceUser, [
        project.path('config'), project.envFile('server'), project.envFile('ui'), project.path('backups'), project.path('run'),
        project.path('ui-data'), ...(tls.selfSigned ? [project.path('config', 'tls'), tls.cert, tls.key] : []),
      ]);
    }

    const afterUnits = deps ? ['docker.service'] : [];
    // With the self-signed certificate, agents on this host can reuse it; the server must trust it to call them.
    const unitOptions = { project, nodePath: process.execPath, serviceUser: options.serviceUser, afterUnits,
      ...(tls.selfSigned ? { extraCaFile: tls.cert } : {}) };
    const units: Record<string, string> = { [`${state.units.server}.service`]: serverUnit(unitOptions) };
    if (options.ui) units[`${state.units.ui}.service`] = uiUnit(unitOptions);
    for (const [name, content] of Object.entries(units)) writeFileSync(project.path('units', name), content);

    if (options.supervisor === 'systemd') {
      const target = unitDirectory(project, io.env);
      mkdirSync(target, { recursive: true });
      for (const [name, content] of Object.entries(units)) writeFileSync(join(target, name), content);
      await enableServices(io, project);
      if (!options.system) {
        io.log(`  user services start at boot only with lingering enabled: loginctl enable-linger ${io.env['USER'] ?? '$USER'}`);
      }
    }

    if (options.start) {
      const startedAt = io.now();
      await restartServices(io, project);
      const health = await waitForHealthy(io, project, { version, startedAfter: startedAt, timeoutMs: options.healthTimeoutMs });
      if (!health.ok) {
        io.warn(`Magnus ${version} is installed but ${health.detail}. Check: ${project.state.supervisor === 'systemd' ? `journalctl ${options.system ? '' : '--user '}-u magnus-server -n 100` : 'your service logs'}`);
        return 1;
      }
      io.log(`  ${health.detail}`);
    } else if (options.supervisor === 'none') {
      io.log(`Start the server and console with the ExecStart lines in ${project.path('units')}/*.service, under your own supervisor.`);
    }

    io.log([
      '',
      `Magnus ${version} is ready.`,
      `  Server:  https://${host}:${options.serverPort}  (agents connect here)`,
      ...(options.ui ? [
        `  Console: ${uiOrigin}`,
        `  Login:   ${options.adminUser} / ${options.adminPassword ? '(the password you chose)' : `${password}   <- shown once; change it in ${project.envFile('ui')}`}`,
      ] : []),
      ...(tls.selfSigned ? [`  TLS:     self-signed certificate in ${project.path('config', 'tls')} (replace it for production)`] : []),
      '',
      `Upgrade later with:  magnus upgrade --dir ${dir}   (or: magnus-server upgrade)`,
      `Settings:            ${project.path('config')}`,
      `Automatic migrations at startup are ${options.autoMigrate ? 'on' : 'off'} (MAGNUS_AUTO_MIGRATE in ${project.envFile('server')}).`,
    ].join('\n'));
    if (existsSync(project.path('deps.compose.yml'))) io.log(`PostgreSQL and Redis run from ${project.path('deps.compose.yml')}.`);
    return 0;
  } finally {
    release();
  }
}
