import { readFile, readdir, lstat, realpath, writeFile, chown, rename, rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { Hono } from 'hono';
import { parse as parseEnv } from 'dotenv';
import YAML from 'yaml';
import { z } from 'zod';
import { ardentPackageNames } from './ardent-packages.js';

export { ardentPackageNames, DEFAULT_ARDENT_PACKAGE } from './ardent-packages.js';

const profileName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const configSummary = z.object({
  schema_version: z.literal(1), profile: profileName, name: z.string().min(1),
  execution: z.object({ backend: z.enum(['llamacpp', 'codex']) }).passthrough(),
  api: z.object({ host: z.string(), port: z.number().int().min(1).max(65535), token_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }).passthrough(),
  a2a: z.object({ enabled: z.boolean() }).passthrough(),
  channels: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/), z.object({ enabled: z.boolean() }).passthrough()).default({}),
}).passthrough();
const acceptedPackageName = z.string().refine(name => ardentPackageNames().includes(name), 'Ardent package name is not accepted by MAGNUS_AGENT_ARDENT_PACKAGES');
const packageVersion = z.object({ name: acceptedPackageName, version: z.string() });
const installedPackageReceipt = z.object({
  schemaVersion: z.literal(1), name: acceptedPackageName,
  version: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  packageTreeSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
/** Package directory of an accepted Ardent package name inside an install prefix. */
function packageDir(install: string, name: string): string {
  if (!ardentPackageNames().includes(name)) throw new Error('Ardent package name is not accepted by MAGNUS_AGENT_ARDENT_PACKAGES');
  return join(install, 'node_modules', ...name.split('/'));
}
/** The accepted Ardent package installed under `install`, in preference order. */
async function installedPackageName(install: string): Promise<string | null> {
  for (const name of ardentPackageNames()) {
    try {
      const installed = packageVersion.parse(JSON.parse(await readFile(join(packageDir(install, name), 'package.json'), 'utf8')) as unknown);
      if (installed.name === name) return name;
    } catch { /* Try the next accepted name. */ }
  }
  return null;
}
async function installedCli(install: string): Promise<string> {
  return join(packageDir(install, await installedPackageName(install) ?? ardentPackageNames()[0]!), 'dist/cli.js');
}
type ConfigSummary = z.infer<typeof configSummary>;
/** Channel name -> enabled, for every channel the profile config declares. */
function channelStates(config: ConfigSummary): Record<string, boolean> {
  return Object.fromEntries(Object.entries(config.channels).map(([name, channel]) => [name, channel.enabled]));
}
type ArdentRoot = { owner: string; home: string; root: string; install: string };

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function ardentRoot(): Promise<ArdentRoot> {
  const owner = process.env['ARDENT_OWNER_USER'] ?? process.env['HERMES_USER'] ?? (process.getuid?.() === 0 ? '' : userInfo().username);
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(owner)) throw new Error('Ardent owner user is not configured');
  const accounts = await readFile('/etc/passwd', 'utf8');
  const account = accounts.split('\n').map(line => line.split(':')).find(fields => fields[0] === owner);
  const home = account?.[5];
  if (!home || !isAbsolute(home) || home === '/') throw new Error('Ardent owner home is unavailable');
  const root = process.env['ARDENT_HOME'] ?? join(home, '.ardent');
  const install = process.env['ARDENT_INSTALL_DIR'] ?? join(home, '.local/share/ardent');
  if (!isAbsolute(root) || !isAbsolute(install) || !within(home, root) || !within(home, install)) throw new Error('Ardent paths must stay under the owner home');
  return { owner, home, root, install };
}

async function safeProfiles(root: string): Promise<string[]> {
  const profiles = join(root, 'profiles');
  try {
    const real = await realpath(profiles);
    if (!within(root, real)) throw new Error('Ardent profile directory escapes its home');
    const entries = await readdir(profiles, { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory() && profileName.safeParse(entry.name).success).map(entry => entry.name).sort();
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function profileConfig(root: string, name: string): Promise<{ config: ConfigSummary; dir: string }> {
  profileName.parse(name);
  const dir = join(root, 'profiles', name);
  const file = join(dir, 'config.yaml');
  const [directory, metadata] = await Promise.all([realpath(dir), lstat(file)]);
  if (!within(join(root, 'profiles'), directory) || metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('Invalid Ardent profile path');
  const text = await readFile(file, 'utf8');
  if (Buffer.byteLength(text) > 200_000) throw new Error('Ardent config exceeds size limit');
  const value: unknown = YAML.parse(text, { uniqueKeys: true });
  const config = configSummary.parse(value);
  if (config.profile !== name || !['127.0.0.1', '::1', 'localhost'].includes(config.api.host)) throw new Error('Ardent profile or management bind differs');
  return { config, dir };
}

async function probe(port: number, dir: string, tokenEnv: string, profile: string): Promise<boolean> {
  try {
    const token = await managementToken(dir, tokenEnv);
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/profile`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const identity: unknown = await response.json();
    const parsed = z.object({ profile: z.string(), product: z.literal('Magnus Ardent') }).safeParse(identity);
    return parsed.success && parsed.data.profile === profile;
  } catch { return false; }
}

async function stagedPackage(): Promise<{ name: string; version: string; sha256: string } | null> {
  const archive = process.env['ARDENT_STAGED_PACKAGE'] ?? '/opt/magnus-agent/ardent-package.tgz';
  if (!isAbsolute(archive)) throw new Error('Ardent staged package path must be absolute');
  const sidecar = join(dirname(archive), 'ardent-package.json');
  const manifestPath = join(dirname(archive), 'component-manifest.json');
  const metadata = await lstat(archive).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!metadata) return null;
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 5 * 1024 * 1024) throw new Error('Staged Ardent package is unsafe');
  const [sidecarInfo, manifestInfo] = await Promise.all([lstat(sidecar), lstat(manifestPath)]);
  if (![sidecarInfo, manifestInfo].every(info => info.isFile() && !info.isSymbolicLink() && info.size < 1024 * 1024)) throw new Error('Staged Ardent manifest is unsafe');
  const manifest = z.object({ component: z.literal('agent'), files: z.array(z.object({ path: z.string(), sha256: z.string() })) }).parse(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown);
  const entry = (path: string) => manifest.files.find(item => item.path === path)?.sha256;
  const sidecarBytes = await readFile(sidecar);
  if (createHash('sha256').update(sidecarBytes).digest('hex') !== entry('ardent-package.json')) throw new Error('Staged Ardent package sidecar differs from release manifest');
  const details = z.object({ name: acceptedPackageName, version: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).parse(JSON.parse(sidecarBytes.toString('utf8')) as unknown);
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  if (digest !== details.sha256 || digest !== entry('ardent-package.tgz')) throw new Error('Staged Ardent package differs from release manifest');
  return { name: details.name, version: details.version, sha256: digest };
}

async function packageTreeDigest(packageRoot: string): Promise<string> {
  const entries: string[] = [];
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, child.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error('Installed Ardent package contains a symlink');
      if (info.isDirectory()) { await visit(path); continue; }
      if (!info.isFile() || info.size > 5 * 1024 * 1024) throw new Error('Installed Ardent package entry is unsafe');
      totalBytes += info.size;
      if (totalBytes > 20 * 1024 * 1024 || entries.length >= 2000) throw new Error('Installed Ardent package exceeds digest bounds');
      const sha256 = createHash('sha256').update(await readFile(path)).digest('hex');
      entries.push(`${relative(packageRoot, path).split(sep).join('/')} ${sha256}\n`);
    }
  };
  await visit(packageRoot);
  if (!entries.length) throw new Error('Installed Ardent package is empty');
  return createHash('sha256').update(entries.sort().join('')).digest('hex');
}

export async function verifiedInstalledArdentPackage(install: string, staged: { name?: string; version: string; sha256: string }): Promise<boolean> {
  const receiptPath = join(install, 'package-receipt.json');
  const metadata = await lstat(receiptPath).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!metadata) return false;
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096) throw new Error('Installed Ardent package receipt is unsafe');
  const receipt = installedPackageReceipt.safeParse(JSON.parse(await readFile(receiptPath, 'utf8')) as unknown);
  if (!receipt.success || receipt.data.version !== staged.version || receipt.data.sha256 !== staged.sha256) return false;
  if (staged.name !== undefined && receipt.data.name !== staged.name) return false;
  return await packageTreeDigest(packageDir(install, receipt.data.name)) === receipt.data.packageTreeSha256;
}

export async function readArdentState(target?: ArdentRoot): Promise<object> {
  const root = target ?? await ardentRoot();
  let version: string | null = null;
  let packageName: string | null = null;
  try {
    packageName = await installedPackageName(root.install);
    if (packageName) {
      const installed: unknown = JSON.parse(await readFile(join(packageDir(root.install, packageName), 'package.json'), 'utf8'));
      version = packageVersion.parse(installed).version;
    }
  } catch { /* An uninstalled package is a normal inventory state. */ }
  const profiles = await Promise.all((await safeProfiles(root.root)).map(async name => {
    try {
      const { config, dir } = await profileConfig(root.root, name);
      return { id: name, name: config.name, backend: config.execution.backend, apiPort: config.api.port,
        running: await probe(config.api.port, dir, config.api.token_env, name), a2aEnabled: config.a2a.enabled,
        channels: channelStates(config), error: null };
    } catch (error: unknown) {
      return { id: name, name, backend: null, apiPort: null, running: false, a2aEnabled: false,
        channels: {}, error: error instanceof Error ? error.message.slice(0, 200) : 'Profile inspection failed' };
    }
  }));
  let staged: Awaited<ReturnType<typeof stagedPackage>> = null;
  let stagedPackageError: string | null = null;
  try { staged = await stagedPackage(); }
  catch (error: unknown) { stagedPackageError = error instanceof Error ? error.message.slice(0, 200) : 'Staged package unavailable'; }
  return { installed: version !== null, version, packageName, owner: root.owner, profiles, stagedPackage: staged, stagedPackageError, checkedAt: new Date().toISOString() };
}

async function managementToken(dir: string, envName: string): Promise<string> {
  const processToken = process.env[envName];
  if (processToken) return processToken;
  const file = join(dir, '.env');
  const metadata = await lstat(file);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 64_000 || (metadata.mode & 0o077) !== 0) throw new Error('Ardent credential file is invalid');
  const token = parseEnv(await readFile(file))[envName];
  if (!token) throw new Error('Ardent management credential is unavailable');
  return token;
}

const allowedRead = /^(?:openapi|status|profile|config|config\/schema|providers|channels|peers|peers\/config|memory\/status|skills|sessions|tasks|tasks\/[0-9a-f-]{36}(?:\/events)?|jobs\/definitions\/status|sessions\/[0-9a-f-]{36}\/messages|identity\/(?:soul|identity)(?:\/history)?|artifacts\/[a-f0-9]{64})$/;
const actionInput = z.object({
  profile: profileName,
  action: z.enum(['profile-create', 'profile-import-hermes', 'config-validate', 'config-save', 'peer-validate', 'peer-save', 'identity-save', 'identity-restore', 'provider-test', 'channel-test', 'peer-test', 'memory-search', 'task-submit', 'task-cancel', 'skill-set', 'service-start', 'service-stop', 'service-restart', 'package-install']),
  target: z.string().max(128).optional(),
  body: z.unknown().optional(),
}).strict();
const actionRoutes: Record<z.infer<typeof actionInput>['action'], { method: 'POST' | 'PUT'; path: (target?: string) => string; target?: RegExp }> = {
  'profile-create': { method: 'POST', path: () => '' },
  'profile-import-hermes': { method: 'POST', path: () => '' },
  'config-validate': { method: 'POST', path: () => 'config/validate' },
  'config-save': { method: 'PUT', path: () => 'config' },
  'peer-validate': { method: 'POST', path: () => 'peers/validate' },
  'peer-save': { method: 'PUT', path: () => 'peers/config' },
  'identity-save': { method: 'PUT', path: target => `identity/${target}`, target: /^(soul|identity)$/ },
  'identity-restore': { method: 'POST', path: target => `identity/${target}/restore`, target: /^(soul|identity)$/ },
  'provider-test': { method: 'POST', path: () => 'providers/test' },
  'channel-test': { method: 'POST', path: target => `channels/${target}/test`, target: /^[a-z][a-z0-9_-]{0,31}$/ },
  'peer-test': { method: 'POST', path: target => `peers/${target}/test`, target: /^[A-Za-z0-9_-]{1,64}$/ },
  'memory-search': { method: 'POST', path: () => 'memory/search' },
  'task-submit': { method: 'POST', path: () => 'tasks' },
  'task-cancel': { method: 'POST', path: target => `tasks/${target}/cancel`, target: /^[0-9a-f-]{36}$/ },
  'skill-set': { method: 'PUT', path: target => `skills/${target}`, target: /^[A-Za-z0-9_-]{1,100}$/ },
  'service-start': { method: 'POST', path: () => '' },
  'service-stop': { method: 'POST', path: () => '' },
  'service-restart': { method: 'POST', path: () => '' },
  'package-install': { method: 'POST', path: () => '' },
};

async function runAsOwner(root: ArdentRoot, args: string[], timeout = 100_000): Promise<string> {
  const accounts = await readFile('/etc/passwd', 'utf8');
  const fields = accounts.split('\n').map(line => line.split(':')).find(parts => parts[0] === root.owner);
  const uid = Number(fields?.[2]);
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('Ardent owner UID is unavailable');
  const bus = `/run/user/${uid}/bus`;
  return new Promise<string>((resolve, reject) => execFile('/usr/sbin/runuser', ['-u', root.owner, '--', '/usr/bin/env',
    `XDG_RUNTIME_DIR=/run/user/${uid}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=${bus}`, ...args],
  { timeout, maxBuffer: 32 * 1024 }, (error, stdout) => error ? reject(new Error(`Ardent owner command failed: ${error.code ?? 'unknown'}`)) : resolve(stdout)));
}

export async function hermesTrafficConsumersDisabled(home: string): Promise<boolean> {
  try {
    const configPath = join(home, '.hermes/config.yaml');
    const envPath = join(home, '.hermes/.env');
    const [configInfo, envInfo] = await Promise.all([lstat(configPath), lstat(envPath)]);
    if ([configInfo, envInfo].some(info => !info.isFile() || info.isSymbolicLink() || info.size > 262_144)) return false;
    const config: unknown = YAML.parse(await readFile(configPath, 'utf8'), { uniqueKeys: true });
    const parsed = z.object({ telegram: z.object({ enabled: z.literal(false) }),
      mattermost: z.object({ enabled: z.literal(false) }), a2a: z.object({ enabled: z.literal(false) }) }).passthrough().safeParse(config);
    if (!parsed.success) return false;
    const env = await readFile(envPath, 'utf8');
    return env.split(/\r?\n/).filter(line => /^A2A_PORT=/.test(line)).length === 1 &&
      env.split(/\r?\n/).some(line => /^A2A_PORT=\s*$/.test(line));
  } catch { return false; }
}

export function ardentUserUnit(root: ArdentRoot, profile: string, packageName = ardentPackageNames()[0]!): string {
  profileName.parse(profile);
  const safe = /^[A-Za-z0-9_./-]+$/;
  if (![root.home, root.root, root.install].every(path => safe.test(path))) throw new Error('Ardent service paths contain unsupported characters');
  return `[Unit]\nDescription=Magnus Ardent ${profile}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${join(root.root, 'profiles', profile)}\nEnvironment=ARDENT_HOME=${root.root}\nExecStart=/usr/bin/node ${join(packageDir(root.install, packageName), 'dist/cli.js')} --profile ${profile} gateway run\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=75\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`;
}

async function serviceAction(root: ArdentRoot, profile: string, action: 'service-start' | 'service-stop' | 'service-restart'): Promise<object> {
  if (process.getuid?.() !== 0) throw new Error('Ardent service management requires a root node manager');
  const { config, dir } = await profileConfig(root.root, profile);
  const requested = Object.entries(channelStates(config)).filter(([, enabled]) => enabled).map(([name]) => name);
  if (action !== 'service-stop' && requested.length > 0) {
    const hermesActive = await runAsOwner(root, ['/usr/bin/systemctl', '--user', 'is-active', '--quiet', 'hermes-gateway.service'], 10_000)
      .then(() => true, () => false);
    if (hermesActive && !(await hermesTrafficConsumersDisabled(root.home)))
      throw new Error('Hermes gateway still owns messaging channels; disable its consumers before starting Ardent consumers');
    const state = await readArdentState(root) as { profiles: Array<{ id: string; running: boolean; channels: Record<string, boolean> }> };
    const conflict = state.profiles.find(item => item.id !== profile && item.running &&
      requested.some(channel => item.channels[channel] === true));
    if (conflict) throw new Error(`Ardent profile ${conflict.id} already owns a requested channel`);
  }
  const unit = `ardent@${profile}.service`;
  const path = join(root.home, '.config/systemd/user', unit);
  const expected = ardentUserUnit(root, profile, await installedPackageName(root.install) ?? undefined);
  const metadata = await lstat(path).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (metadata && (metadata.isSymbolicLink() || !metadata.isFile())) throw new Error('Managed Ardent user service path is unsafe');
  const existing = await readFile(path, 'utf8').catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing !== undefined && existing !== expected) throw new Error('Existing Ardent user service differs from the managed unit');
  if (action !== 'service-start' && existing === undefined) throw new Error('Managed Ardent user service is not installed');
  if (action === 'service-start' && existing === undefined) {
    const script = await installedCli(root.install);
    const scriptInfo = await lstat(script);
    if (!scriptInfo.isFile() || scriptInfo.isSymbolicLink()) throw new Error('Ardent package executable is unavailable');
    await runAsOwner(root, ['/usr/bin/mkdir', '-p', join(root.home, '.config/systemd/user')], 10_000);
    const parent = await realpath(join(root.home, '.config/systemd/user'));
    if (!within(await realpath(root.home), parent)) throw new Error('Ardent service directory escapes the owner home');
    await writeFile(path, expected, { mode: 0o644, flag: 'wx' });
    const fields = (await readFile('/etc/passwd', 'utf8')).split('\n').map(line => line.split(':')).find(parts => parts[0] === root.owner);
    await chown(path, Number(fields?.[2]), Number(fields?.[3]));
    await runAsOwner(root, ['/usr/bin/systemctl', '--user', 'daemon-reload'], 10_000);
  }
  const command = action === 'service-start' ? ['enable', '--now'] : action === 'service-stop' ? ['disable', '--now'] : ['restart'];
  await runAsOwner(root, ['/usr/bin/systemctl', '--user', ...command, unit]);
  let running = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    running = await probe(config.api.port, dir, config.api.token_env, profile);
    if (running === (action !== 'service-stop')) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (running !== (action !== 'service-stop')) throw new Error(`Ardent profile did not reach ${action === 'service-stop' ? 'stopped' : 'running'} state`);
  return { service: unit, profile, running };
}

async function installPackage(root: ArdentRoot): Promise<object> {
  if (process.getuid?.() !== 0) throw new Error('Ardent package installation requires a root node manager');
  const staged = await stagedPackage();
  if (!staged) throw new Error('No verified Ardent package is staged with this node agent release');
  const before = await readArdentState(root) as { version: string | null; profiles: Array<{ id: string; running: boolean }> };
  if (before.version === staged.version && await verifiedInstalledArdentPackage(root.install, staged))
    return { installed: true, version: staged.version, changed: false };
  for (const profile of before.profiles) {
    if (profile.running) throw new Error(`Ardent profile ${profile.id} is running; stop it before updating the package`);
    const lock = join(root.root, 'profiles', profile.id, 'state/gateway.lock');
    const lockInfo = await lstat(lock).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (lockInfo) throw new Error(`Ardent profile ${profile.id} has an execution lock; inspect it before package installation`);
  }
  const archive = process.env['ARDENT_STAGED_PACKAGE'] ?? '/opt/magnus-agent/ardent-package.tgz';
  const stage = join(dirname(root.install), `.ardent-install-${randomUUID()}`);
  const previous = `${root.install}.previous`;
  if (!within(root.home, stage) || !within(root.home, previous)) throw new Error('Ardent install staging path escapes owner home');
  const priorInfo = await lstat(root.install).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (priorInfo && (priorInfo.isSymbolicLink() || !priorInfo.isDirectory())) throw new Error('Ardent installation path is unsafe');
  if (priorInfo && await lstat(previous).then(() => true).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  })) throw new Error('Previous Ardent package checkpoint must be resolved before another update');
  await runAsOwner(root, ['/usr/bin/mkdir', '-p', stage], 10_000);
  let movedPrior = false;
  let installed = false;
  try {
    await runAsOwner(root, ['/usr/bin/npm', 'install', '--prefix', stage, '--omit=dev', '--no-audit', '--no-fund', '--no-save', archive], 9 * 60_000);
    const packageFile = join(packageDir(stage, staged.name), 'package.json');
    const candidate = packageVersion.parse(JSON.parse(await readFile(packageFile, 'utf8')) as unknown);
    if (candidate.name !== staged.name || candidate.version !== staged.version) throw new Error('Staged Ardent package name or version differs');
    await runAsOwner(root, ['/usr/bin/node', '-e', "const Database=require(process.argv[1]);new Database(':memory:').close()", join(stage, 'node_modules/better-sqlite3')], 10_000);
    const packageTreeSha256 = await packageTreeDigest(packageDir(stage, staged.name));
    await writeFile(join(stage, 'package-receipt.json'), `${JSON.stringify({
      schemaVersion: 1, name: staged.name, version: staged.version, sha256: staged.sha256, packageTreeSha256,
    })}\n`, { mode: 0o644 });
    if (priorInfo) { await rename(root.install, previous); movedPrior = true; }
    await rename(stage, root.install); installed = true;
    const after = await readArdentState(root) as { version: string | null };
    if (after.version !== staged.version) throw new Error('Installed Ardent package version differs from the verified staged artifact');
    if (!await verifiedInstalledArdentPackage(root.install, staged)) throw new Error('Installed Ardent package differs from its verified receipt');
    return { installed: true, version: after.version, changed: true, previousAvailable: movedPrior };
  } catch (error: unknown) {
    if (movedPrior) {
      if (installed) await rename(root.install, stage);
      await rename(previous, root.install);
    }
    throw error;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

async function createProfile(root: ArdentRoot, profile: string, body: unknown): Promise<object> {
  if (process.getuid?.() !== 0) throw new Error('Ardent profile creation requires a root node manager');
  const input = z.object({ api_port: z.number().int().min(1024).max(65535) }).strict().parse(body);
  const installed = await readArdentState(root) as { version: string | null };
  if (!installed.version) throw new Error('Install the verified Ardent package before creating a profile');
  const names = await safeProfiles(root.root);
  if (names.includes(profile)) throw new Error('Ardent profile already exists');
  for (const name of names) {
    const current = await profileConfig(root.root, name);
    if (current.config.api.port === input.api_port) throw new Error(`API port is already assigned to profile ${name}`);
  }
  const script = await installedCli(root.install);
  const metadata = await lstat(script);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Installed Ardent CLI is unsafe');
  await runAsOwner(root, ['/usr/bin/env', `ARDENT_HOME=${root.root}`, '/usr/bin/node', script,
    '--profile', profile, 'init', '--non-interactive', '--api-port', String(input.api_port)], 30_000);
  const created = await profileConfig(root.root, profile);
  if (created.config.api.port !== input.api_port) throw new Error('Created profile API port differs');
  return { profile, apiPort: input.api_port, initialized: true };
}

async function importHermesProfile(root: ArdentRoot, profile: string, body: unknown): Promise<object> {
  if (process.getuid?.() !== 0) throw new Error('Ardent profile import requires a root node manager');
  profileName.parse(profile);
  const input = z.object({ apply: z.boolean(), expected_source_revision: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().parse(body);
  if (input.apply && !input.expected_source_revision) throw new Error('Profile import apply requires a pinned source revision from preview');
  const state = await readArdentState(root) as { version: string | null; profiles: Array<{ id: string; running: boolean }> };
  if (!state.version) throw new Error('Install the verified Ardent package before importing a profile');
  if (state.profiles.some(item => item.id === profile && item.running)) throw new Error('Stop the Ardent profile service before importing its profile');
  const source = join(root.home, '.hermes');
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('Hermes source home is unsafe');
  const script = await installedCli(root.install);
  const scriptInfo = await lstat(script);
  if (!scriptInfo.isFile() || scriptInfo.isSymbolicLink()) throw new Error('Installed Ardent CLI is unsafe');
  const stdout = await runAsOwner(root, ['/usr/bin/env', `ARDENT_HOME=${root.root}`, '/usr/bin/node', script,
    'import', 'hermes', '--source', source, '--profile', profile, '--profile-path', join(root.root, 'profiles', profile),
    '--non-interactive', ...(input.expected_source_revision ? ['--expected-source-revision', input.expected_source_revision] : []),
    input.apply ? '--apply' : '--dry-run'], 60_000);
  return z.object({ source: z.literal(source), role: z.literal(profile), applied: z.literal(input.apply), imported: z.array(z.string()),
    omitted: z.array(z.string()), incompatible: z.array(z.string()), source_persona_sha256: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough()
    .parse(JSON.parse(stdout) as unknown);
}

export function createArdentRoutes(resolveRoot: () => Promise<ArdentRoot> = ardentRoot): Hono {
  const routes = new Hono();
  routes.get('/state', async c => {
    try { return c.json({ success: true, data: await readArdentState(await resolveRoot()) }); }
    catch (error: unknown) { return c.json({ success: false, error: error instanceof Error ? error.message.slice(0, 200) : 'Ardent inventory failed' }, 503); }
  });
  routes.get('/profiles/:name/api/*', async c => {
    try {
      const target = await resolveRoot();
      const name = profileName.parse(c.req.param('name'));
      const suffix = c.req.path.split(`/profiles/${name}/api/`)[1] ?? '';
      if (!allowedRead.test(suffix)) return c.json({ error: 'Ardent management path is not allowed' }, 404);
      const { config, dir } = await profileConfig(target.root, name);
      if (!await probe(config.api.port, dir, config.api.token_env, name)) throw new Error('Ardent management listener identity differs or is unavailable');
      const token = await managementToken(dir, config.api.token_env);
      const url = new URL(`http://127.0.0.1:${config.api.port}/${suffix === 'openapi' ? 'openapi.json' : `api/v1/${suffix}`}`);
      for (const key of ['after', 'limit']) {
        const value = c.req.query(key);
        if (value !== undefined) url.searchParams.set(key, value);
      }
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      const body = await response.arrayBuffer();
      if (body.byteLength > 2 * 1024 * 1024) return c.json({ error: 'Ardent management response exceeds size limit' }, 502);
      return new Response(new Uint8Array(body), { status: response.status, headers: { 'Content-Type': suffix.startsWith('artifacts/') && response.ok ? 'application/octet-stream' : response.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    } catch (error: unknown) {
      return c.json({ error: error instanceof Error ? error.message.slice(0, 200) : 'Ardent profile unavailable' }, 503);
    }
  });
  routes.post('/action', async c => {
    const parsed = actionInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid Ardent action' }, 400);
    const input = parsed.data;
    if (input.action === 'task-submit' && !z.object({ prompt: z.string().trim().min(1).max(4000), idempotency_key: z.string().guid() }).strict().safeParse(input.body).success)
      return c.json({ error: 'Task submission requires a bounded prompt and idempotency key' }, 400);
    if (input.action === 'memory-search' && !z.object({ query: z.string().trim().min(1).max(1000) }).strict().safeParse(input.body).success)
      return c.json({ error: 'Memory search requires a bounded query' }, 400);
    const route = actionRoutes[input.action];
    if (route.target ? !input.target || !route.target.test(input.target) : input.target !== undefined)
      return c.json({ error: 'Invalid Ardent action target' }, 400);
    const body = JSON.stringify(input.body ?? {});
    if (Buffer.byteLength(body) > 200_000) return c.json({ error: 'Ardent action exceeds size limit' }, 413);
    try {
      const root = await resolveRoot();
      if (input.action === 'package-install') return c.json(await installPackage(root));
      if (input.action === 'profile-create') return c.json(await createProfile(root, input.profile, input.body));
      if (input.action === 'profile-import-hermes') return c.json(await importHermesProfile(root, input.profile, input.body));
      if (input.action === 'service-start' || input.action === 'service-stop' || input.action === 'service-restart') {
        return c.json(await serviceAction(root, input.profile, input.action));
      }
      const { config, dir } = await profileConfig(root.root, input.profile);
      if (!await probe(config.api.port, dir, config.api.token_env, input.profile)) throw new Error('Ardent management listener identity differs or is unavailable');
      const token = await managementToken(dir, config.api.token_env);
      const path = route.path(input.target);
      const response = await fetch(`http://127.0.0.1:${config.api.port}/api/v1/${path}`, {
        method: route.method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body, redirect: 'error', signal: AbortSignal.timeout(input.action === 'provider-test' ? 30_000 : 15_000),
      });
      const result = await response.arrayBuffer();
      if (result.byteLength > 2 * 1024 * 1024) return c.json({ error: 'Ardent action response exceeds size limit' }, 502);
      // The signed managed HTTP receipt proves durable task admission, never
      // completion of the asynchronous model run. Return 200 for that bounded
      // admission so the node ledger can settle the synchronous operation.
      const status = input.action === 'task-submit' && response.status === 202 ? 200 : response.status;
      return new Response(new Uint8Array(result), { status, headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store' } });
    } catch (error: unknown) {
      return c.json({ error: error instanceof Error ? error.message.slice(0, 200) : 'Ardent action unavailable' }, 503);
    }
  });
  return routes;
}

export const ardentRoutes = createArdentRoutes();
