/**
 * `magnus adopt`: turn an existing npm install (1.0.x or later) into a
 * managed project so `magnus upgrade` can take over. The env files stay where
 * they are; the same version is installed under versions/ and new units point
 * at ./current. Nothing running is touched unless --install-units is given.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isVersion } from '@hivemagnus/magnus-contracts';
import { readEnvFile } from './env-file.js';
import { installVersion, publishPins } from './install.js';
import type { Io } from './io.js';
import { acquireLock, Project, type Component, type ProjectState, type Supervisor } from './project.js';
import { releaseFor } from './release.js';
import { enableServices, unitDirectory } from './supervisor.js';
import { serverUnit, uiUnit } from './templates.js';
import { loadCatalog, UpgradeError } from './upgrade.js';
import { defaultProjectDir } from './init.js';

export interface AdoptOptions {
  dir?: string;
  serverEnvFile: string;
  uiEnvFile?: string;
  version?: string;
  system: boolean;
  serviceUser?: string;
  supervisor: Supervisor;
  installUnits: boolean;
  source?: string;
  registry: string;
}

async function detectVersion(io: Io): Promise<string | null> {
  const result = await io.run('magnus-server', ['--version'], { capture: true }).catch(() => null);
  const version = result?.code === 0 ? result.stdout.trim() : '';
  return isVersion(version) ? version : null;
}

export async function adopt(io: Io, options: AdoptOptions): Promise<number> {
  if (options.system && !options.serviceUser) throw new UpgradeError('--system needs --service-user <account the services run as>.');
  const serverEnvFile = resolve(options.serverEnvFile);
  if (!existsSync(serverEnvFile)) throw new UpgradeError(`--server-env-file ${serverEnvFile} does not exist`);
  const uiEnvFile = options.uiEnvFile ? resolve(options.uiEnvFile) : undefined;
  if (uiEnvFile && !existsSync(uiEnvFile)) throw new UpgradeError(`--ui-env-file ${uiEnvFile} does not exist`);
  const dir = resolve(options.dir ?? defaultProjectDir(io, options.system));
  if (Project.exists(dir)) throw new UpgradeError(`${dir} already holds a Magnus project.`);
  const version = options.version ?? await detectVersion(io);
  if (!version) throw new UpgradeError('Could not detect the installed version; pass --version X.Y.Z (the output of `magnus-server --version`).');

  const serverEnv = readEnvFile(serverEnvFile);
  const uiEnv = uiEnvFile ? readEnvFile(uiEnvFile) : {};
  const components: Component[] = uiEnvFile ? ['server', 'ui'] : ['server'];
  const state: ProjectState = {
    schema: 1,
    createdAt: io.now().toISOString(),
    supervisor: options.supervisor,
    scope: options.system ? 'system' : 'user',
    components,
    units: { server: 'magnus-server', ui: 'magnus-ui' },
    envFiles: { server: serverEnvFile, ui: uiEnvFile ?? join('config', 'magnus-ui.env') },
    database: { kind: 'external' },
    ports: { server: Number(serverEnv['CONTROL_API_PORT'] ?? 4000), ui: Number(uiEnv['PORT'] ?? 3000) },
    current: null,
    previous: null,
    keepVersions: 3,
    history: [],
  };
  mkdirSync(dir, { recursive: true });
  const project = new Project(dir, state);
  const release = acquireLock(project.path('run', 'upgrade.lock'));
  try {
    for (const sub of ['backups', 'run', 'versions', 'units', 'ui-data']) mkdirSync(project.path(sub), { recursive: true, mode: 0o750 });
    const catalog = await loadCatalog(io, options);
    io.log(`Adopting Magnus ${version} into ${dir} (env files stay in place)`);
    await installVersion(io, project, releaseFor(catalog, version), catalog);
    project.switchCurrent(version);
    project.state.current = version;
    project.record({ action: 'adopt', from: null, to: version, at: io.now().toISOString(), result: 'ok', migrations: [] });
    publishPins(project, version);
    project.save();

    const unitOptions = { project, nodePath: process.execPath, serviceUser: options.serviceUser, afterUnits: [] };
    const units: Record<string, string> = { 'magnus-server.service': serverUnit(unitOptions) };
    if (uiEnvFile) units['magnus-ui.service'] = uiUnit(unitOptions);
    for (const [name, content] of Object.entries(units)) writeFileSync(project.path('units', name), content);

    const target = unitDirectory(project, io.env);
    if (options.installUnits && options.supervisor === 'systemd') {
      mkdirSync(target, { recursive: true });
      for (const [name, content] of Object.entries(units)) writeFileSync(join(target, name), content);
      await enableServices(io, project);
      io.log(`Installed ${Object.keys(units).join(', ')} into ${target}. Stop and disable your old units, then: systemctl ${options.system ? '' : '--user '}restart ${Object.keys(units).join(' ')}`);
    } else {
      io.log([
        `Generated units in ${project.path('units')}. To switch over:`,
        '  1. stop and disable the units that run your current install',
        `  2. copy ${project.path('units')}/*.service to ${target}/ and run: systemctl ${options.system ? '' : '--user '}daemon-reload`,
        `  3. systemctl ${options.system ? '' : '--user '}enable --now ${Object.keys(units).join(' ')}`,
        `Then upgrade with: magnus upgrade --dir ${dir}`,
      ].join('\n'));
    }
    return 0;
  } finally {
    release();
  }
}
