import { readFile, readdir, lstat, realpath, writeFile, chown, rename, rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { Hono } from 'hono';
import { parse as parseEnv } from 'dotenv';
import YAML from 'yaml';
import { z } from 'zod';
import { ardentPackageNames } from './ardent-packages.js';
import { contextAdoptionInput, contextRelease, inspectContextAdoption, manageContextAdoption } from './ardent-context-adoption.js';
import { childEnvironment } from '../utils/child-env.js';
import { managedExecution } from '../security/managed-context.js';
import { logger } from '../utils/logger.js';
import {
  ARDENT_SKILL_ARCHIVE_LIMITS, ARDENT_SKILL_RECEIPT_FILE, ardentDevelopmentNoteSchema, ardentMissionSubmitSchema, ardentPreviewSubmitSchema,
  ardentSessionOpenSchema, ardentSkillInstallNodeSchema, ardentSkillReceiptSchema, checkArdentSkillArchive, type ArdentSkillInstallResult,
} from '@hivemagnus/magnus-contracts';
import { ARDENT_AGENT_CAPABILITIES } from '../ardent-capabilities.js';
export { ardentPackageNames, DEFAULT_ARDENT_PACKAGE } from './ardent-packages.js';

// What this agent's Ardent bridge supports; the ping route reports the same level.
export { ARDENT_AGENT_CAPABILITIES };

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
    // `ardent init` profiles report the product name Ardent; profiles from before the standalone
    // runtime report Magnus Ardent. Anything else on the port is not this profile.
    const parsed = z.object({ profile: z.string(), product: z.enum(['Ardent', 'Magnus Ardent']) }).safeParse(identity);
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

export async function packageTreeDigest(packageRoot: string): Promise<string> {
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
  return { installed: version !== null, version, packageName, owner: root.owner, profiles, stagedPackage: staged, stagedPackageError,
    capabilities: ARDENT_AGENT_CAPABILITIES, checkedAt: new Date().toISOString() };
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

const allowedRead = /^(?:openapi|status|profile|config|config\/schema|providers|channels|peers|peers\/config|memory\/status|skills|sessions|tasks|tasks\/[0-9a-f-]{36}(?:\/events)?|jobs\/definitions\/status|sessions\/[0-9a-f-]{36}\/messages|identity\/(?:soul|identity)(?:\/history)?|artifacts\/[a-f0-9]{64}(?:\/manifest)?|tasks\/[0-9a-f-]{36}\/(?:stream|artifacts)|development)$/;
/** Streamed rather than buffered: a task's events and an artifact's bytes. */
const streamedRead = /^(?:artifacts\/[a-f0-9]{64}|tasks\/[0-9a-f-]{36}\/stream)$/;
/** Query parameters passed to the profile API, each with the values it may hold. */
const readQuery: Record<string, RegExp> = {
  after: /^[A-Za-z0-9_-]{1,400}$/, limit: /^\d{1,3}$/, kind: /^[a-z][a-z0-9_]{0,63}$/, context: /^(?:direct|mission|preview)$/,
};
/** Ardent closes a task stream after 60 seconds; a relay with no bytes for as long ends too. */
export const ARDENT_STREAM_IDLE_MS = 60_000;
const DEFAULT_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
/** Largest artifact the agent relays, from MAGNUS_AGENT_ARDENT_ARTIFACT_MAX_BYTES (default 64 MiB, at most 1 GiB). */
export function ardentArtifactMaxBytes(): number {
  const raw = process.env['MAGNUS_AGENT_ARDENT_ARTIFACT_MAX_BYTES'];
  if (raw === undefined || raw === '') return DEFAULT_ARTIFACT_MAX_BYTES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1024 * 1024 * 1024) throw new Error('MAGNUS_AGENT_ARDENT_ARTIFACT_MAX_BYTES must be an integer from 1 to 1073741824');
  return value;
}

/**
 * Relay an upstream body chunk by chunk, never buffering it. The upstream request
 * is aborted after `idleMs` without a chunk, past `maxBytes`, or when the reader
 * goes away. An idle stream ends cleanly when `idle` is 'close' (SSE clients
 * reconnect with their cursor) and fails when it is 'error', so a stalled
 * download can never look complete.
 */
export function relayBody(upstream: ReadableStream<Uint8Array>, abort: AbortController,
  options: { idleMs: number; maxBytes?: number; idle: 'close' | 'error' }): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idled = false;
  let total = 0;
  const stop = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const arm = () => {
    stop();
    timer = setTimeout(() => { idled = true; abort.abort(new Error('Ardent stream idle limit reached')); }, options.idleMs);
    timer.unref?.();
  };
  return new ReadableStream<Uint8Array>({
    start() { arm(); },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { stop(); controller.close(); return; }
        total += value.byteLength;
        if (options.maxBytes !== undefined && total > options.maxBytes) {
          stop();
          abort.abort(new Error('Ardent artifact exceeds size limit'));
          controller.error(new Error('Ardent artifact exceeds size limit'));
          return;
        }
        arm();
        controller.enqueue(value);
      } catch (error: unknown) {
        stop();
        if (idled && options.idle === 'close') controller.close();
        else controller.error(error instanceof Error ? error : new Error('Ardent stream failed'));
      }
    },
    cancel(reason) {
      stop();
      abort.abort(reason);
      return reader.cancel(reason).catch(() => undefined);
    },
  });
}

/** A bounded JSON answer from an upstream error, so a failure never streams an unbounded body. */
async function boundedError(response: Response): Promise<Response> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) { await reader.cancel().catch(() => undefined); return Response.json({ error: 'Ardent error response exceeds size limit' }, { status: 502 }); }
      chunks.push(value);
    }
  } catch { return Response.json({ error: 'Ardent error response was interrupted' }, { status: 502 }); }
  return new Response(Buffer.concat(chunks), { status: response.status, headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store' } });
}

/** Stream a task's SSE events or an artifact's bytes from the profile API without buffering them. */
async function relayArdentStream(port: number, token: string, suffix: string, request: Request, clientSignal: AbortSignal): Promise<Response> {
  const artifact = suffix.startsWith('artifacts/');
  const maxBytes = artifact ? ardentArtifactMaxBytes() : undefined;
  const url = new URL(`http://127.0.0.1:${port}/api/v1/${suffix}`);
  const after = new URL(request.url).searchParams.get('after');
  if (!artifact && after !== null) {
    if (!/^\d{1,15}$/.test(after)) return Response.json({ error: 'Invalid stream cursor' }, { status: 400 });
    url.searchParams.set('after', after);
  }
  const lastEventId = request.headers.get('last-event-id');
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: artifact ? 'application/octet-stream' : 'text/event-stream' };
  if (!artifact && lastEventId !== null && /^\d{1,15}$/.test(lastEventId)) headers['Last-Event-ID'] = lastEventId;
  const abort = new AbortController();
  const onClientAbort = () => abort.abort(clientSignal.reason);
  if (clientSignal.aborted) abort.abort(clientSignal.reason);
  else clientSignal.addEventListener('abort', onClientAbort, { once: true });
  const connect = setTimeout(() => abort.abort(new Error('Ardent stream did not answer')), 10_000);
  let response: Response;
  try { response = await fetch(url, { headers, redirect: 'error', signal: abort.signal }); }
  finally { clearTimeout(connect); }
  if (!response.ok || !response.body) { clientSignal.removeEventListener('abort', onClientAbort); return boundedError(response); }
  const type = response.headers.get('content-type') ?? '';
  if (artifact ? !type.startsWith('application/octet-stream') : !type.startsWith('text/event-stream')) {
    abort.abort();
    clientSignal.removeEventListener('abort', onClientAbort);
    return Response.json({ error: 'Ardent stream response type differs' }, { status: 502 });
  }
  const length = Number(response.headers.get('content-length') ?? Number.NaN);
  if (maxBytes !== undefined && Number.isFinite(length) && length > maxBytes) {
    abort.abort();
    clientSignal.removeEventListener('abort', onClientAbort);
    return Response.json({ error: 'Ardent artifact exceeds size limit' }, { status: 502 });
  }
  const body = relayBody(response.body, abort, { idleMs: ARDENT_STREAM_IDLE_MS, idle: artifact ? 'error' : 'close', ...(maxBytes !== undefined ? { maxBytes } : {}) });
  return new Response(body, { status: 200, headers: artifact
    ? { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(Number.isFinite(length) ? { 'Content-Length': String(length) } : {}) }
    : { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' } });
}
const actionInput = z.object({
  profile: profileName,
  action: z.enum(['profile-create', 'session-open', 'hivemem-credential-set', 'hivemem-credential-reload', 'config-validate', 'config-save', 'peer-validate', 'peer-save', 'identity-save', 'identity-restore', 'provider-test', 'channel-test', 'peer-test', 'memory-search', 'task-submit', 'task-cancel', 'mission-submit', 'task-pause', 'task-resume', 'preview-submit', 'development-note', 'skill-set', 'service-start', 'service-stop', 'service-restart', 'package-install', 'context-stage', 'context-adopt', 'context-rollback', 'skill-install']),
  target: z.string().max(128).optional(),
  body: z.unknown().optional(),
}).strict();
const actionRoutes: Record<z.infer<typeof actionInput>['action'], { method: 'POST' | 'PUT'; path: (target?: string) => string; target?: RegExp }> = {
  'profile-create': { method: 'POST', path: () => '' },
  'session-open': { method: 'POST', path: () => 'sessions' },
  'hivemem-credential-set': { method: 'POST', path: () => '' },
  // Ardent re-reads only memory.token_env from the profile's .env. Older Ardent answers 404; Magnus then restarts the service.
  'hivemem-credential-reload': { method: 'POST', path: () => 'memory/credential/reload' },
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
  'mission-submit': { method: 'POST', path: () => 'missions' },
  'task-pause': { method: 'POST', path: target => `tasks/${target}/pause`, target: /^[0-9a-f-]{36}$/ },
  'task-resume': { method: 'POST', path: target => `tasks/${target}/resume`, target: /^[0-9a-f-]{36}$/ },
  'preview-submit': { method: 'POST', path: () => 'preview/tasks' },
  'development-note': { method: 'POST', path: () => 'development' },
  'skill-set': { method: 'PUT', path: target => `skills/${target}`, target: /^[A-Za-z0-9_-]{1,100}$/ },
  'service-start': { method: 'POST', path: () => '' },
  'service-stop': { method: 'POST', path: () => '' },
  'service-restart': { method: 'POST', path: () => '' },
  'package-install': { method: 'POST', path: () => '' },
  'context-stage': { method: 'POST', path: () => '' },
  'context-adopt': { method: 'POST', path: () => '' },
  'context-rollback': { method: 'POST', path: () => '' },
  'skill-install': { method: 'POST', path: () => '' },
};

/**
 * The command that runs `args` as the Ardent owner. It runs in the owner's home: the agent's own
 * working directory is root-only (mode 0700 on suite installs), and Node resolves `node -e`
 * scripts and npm resolves project config from the working directory, which the owner must read.
 */
export function ownerCommand(root: ArdentRoot, uid: number, args: string[], timeout = 100_000): { file: string; args: string[]; options: { cwd: string; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv } } {
  const bus = `/run/user/${uid}/bus`;
  return { file: '/usr/sbin/runuser', args: ['-u', root.owner, '--', '/usr/bin/env',
    `XDG_RUNTIME_DIR=/run/user/${uid}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=${bus}`, ...args],
  options: { cwd: root.home, timeout, maxBuffer: 32 * 1024, env: childEnvironment() } };
}

/**
 * An action failure whose effect is not known: a request that may have reached
 * Ardent without a complete answer, or an owner command the agent had to stop.
 * The action route answers it with 503, which keeps the managed command owner
 * uncertain; every other failure finished, and is answered as settled.
 */
export class ArdentOutcomeUncertain extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'ArdentOutcomeUncertain'; }
}

async function runAsOwner(root: ArdentRoot, args: string[], timeout = 100_000, input?: Buffer): Promise<string> {
  const accounts = await readFile('/etc/passwd', 'utf8');
  const fields = accounts.split('\n').map(line => line.split(':')).find(parts => parts[0] === root.owner);
  const uid = Number(fields?.[2]);
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('Ardent owner UID is unavailable');
  const command = ownerCommand(root, uid, args, timeout);
  return new Promise<string>((resolve, reject) => {
    const child = execFile(command.file, command.args, command.options, (error, stdout) => {
      if (!error) { resolve(stdout); return; }
      // A child stopped by its timeout or output cap may have handed work on (systemd keeps a started job).
      if (error.killed || error.signal) reject(new ArdentOutcomeUncertain(`Ardent owner command was stopped (${error.signal ?? 'killed'}) before it finished`));
      else reject(new Error(`Ardent owner command failed: ${error.code ?? 'unknown'}`));
    });
    if (input) child.stdin?.end(input);
  });
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

export function ardentServiceCommand(action: 'service-start' | 'service-stop' | 'service-restart', preserveEnablement = false): string[] {
  return action === 'service-start' ? preserveEnablement ? ['start'] : ['enable', '--now']
    : action === 'service-stop' ? preserveEnablement ? ['stop'] : ['disable', '--now'] : ['restart'];
}

async function serviceAction(root: ArdentRoot, profile: string, action: 'service-start' | 'service-stop' | 'service-restart', preserveEnablement = false): Promise<object> {
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
  const command = ardentServiceCommand(action, preserveEnablement);
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
  if (await lstat(join(root.install, 'context-adoption.json')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }))
    throw new Error('Resolve the context adoption before replacing the entire Ardent runtime');
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

/** The profile environment key that carries the agent's HiveMem token (also renewable by credential renewal). */
export const ARDENT_HIVEMEM_TOKEN_ENV = 'ARDENT_HIVEMEM_TOKEN';
const jwt = z.string().max(8192).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

/**
 * Set one key in a profile's private `.env`, keeping every other line, its
 * owner and mode 0600. The file is replaced atomically, never followed through
 * a symlink, and never left world- or group-readable.
 */
export async function writeProfileCredential(dir: string, key: typeof ARDENT_HIVEMEM_TOKEN_ENV, value: string): Promise<void> {
  jwt.parse(value);
  const file = join(dir, '.env');
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 64_000 || (info.mode & 0o077) !== 0) throw new Error('Ardent credential file is invalid');
  const kept = (await readFile(file, 'utf8')).split(/\r?\n/).filter(line => !line.startsWith(`${key}=`));
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  const temporary = join(dir, `.${randomUUID()}.env`);
  try {
    await writeFile(temporary, [...kept, `${key}=${value}`, ''].join('\n'), { mode: 0o600, flag: 'wx' });
    await chown(temporary, info.uid, info.gid);
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

async function setHiveMemCredential(root: ArdentRoot, profile: string, body: unknown): Promise<object> {
  if (process.getuid?.() !== 0) throw new Error('Ardent credential management requires a root node manager');
  const input = z.object({ token: jwt }).strict().parse(body);
  const { dir } = await profileConfig(root.root, profile);
  await writeProfileCredential(dir, ARDENT_HIVEMEM_TOKEN_ENV, input.token);
  // Report only that the key is set: the token never leaves the node again.
  return { profile, tokenEnv: ARDENT_HIVEMEM_TOKEN_ENV, configured: true, activationRequired: true };
}

function connectionRefused(error: unknown): boolean {
  for (let current = error, depth = 0; current && typeof current === 'object' && depth < 4; current = (current as { cause?: unknown }).cause, depth++)
    if ((current as { code?: unknown }).code === 'ECONNREFUSED') return true;
  return false;
}

/** Ardent's own error text from a JSON error body, bounded, or nothing. */
function upstreamMessage(body: ArrayBuffer): string {
  try {
    const value = JSON.parse(Buffer.from(body).toString('utf8')) as { error?: unknown };
    const text = typeof value.error === 'string' ? value.error : (value.error as { message?: unknown } | undefined)?.message;
    return typeof text === 'string' && text ? `: ${text.slice(0, 160)}` : '';
  } catch { return ''; } // no-reason-needed: a non-JSON body adds no detail to the message
}

/** A skill installation refused before anything changed: 400 for an archive that fails its checks, 409 for a name a local skill holds. */
export class SkillInstallRefused extends Error {
  constructor(readonly status: 400 | 409, message: string) { super(message); this.name = 'SkillInstallRefused'; }
}
/** The owner command's exit status when the skill directory is not one Magnus installed. */
const SKILL_CONFLICT_EXIT = 3;
/**
 * Runs as the Ardent owner, never as root, so nothing in the owner's tree can redirect a write: reads the
 * checked archive from stdin, extracts it with tar into a hidden staging directory beside the skill,
 * makes it private to the owner, writes the receipt and swaps the directory in, restoring the previous
 * copy if the swap fails.
 * Arguments: skills directory, skill name, receipt JSON. Ardent ignores names that start with a dot.
 */
export const SKILL_INSTALL_SCRIPT = [
  "const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');",
  'const [root,name,receipt]=process.argv.slice(1);',
  'const archive=fs.readFileSync(0);',
  'fs.mkdirSync(root,{recursive:true,mode:0o700});',
  "const dest=path.join(root,name),stage=path.join(root,'.hiveskills-'+crypto.randomUUID()),old=path.join(root,'.hiveskills-old-'+crypto.randomUUID());",
  "let existing=null;try{existing=fs.lstatSync(dest)}catch(error){if(error.code!=='ENOENT')throw error}",
  `if(existing){let marker=null;try{marker=fs.lstatSync(path.join(dest,'${ARDENT_SKILL_RECEIPT_FILE}'))}catch{}if(!existing.isDirectory()||!marker||!marker.isFile())process.exit(${SKILL_CONFLICT_EXIT})}`,
  'fs.mkdirSync(stage,{mode:0o700});',
  'try{',
  "cp.execFileSync('/usr/bin/tar',['-xzf','-','-C',stage,'--no-same-owner','--no-same-permissions'],{input:archive,stdio:['pipe','ignore','ignore'],timeout:60000});",
  // Archive modes are not trusted: directories become 0700 and files 0600, like the HiveSkills Hermes bridge.
  'const own=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const item=path.join(dir,entry.name);if(entry.isDirectory()){fs.chmodSync(item,0o700);own(item)}else fs.chmodSync(item,0o600)}};own(stage);',
  `fs.writeFileSync(path.join(stage,'${ARDENT_SKILL_RECEIPT_FILE}'),receipt,{flag:'wx',mode:0o600});`,
  'if(existing)fs.renameSync(dest,old);',
  'try{fs.renameSync(stage,dest)}catch(error){if(existing)fs.renameSync(old,dest);throw error}',
  '}finally{fs.rmSync(stage,{recursive:true,force:true});fs.rmSync(old,{recursive:true,force:true})}',
].join('\n');
const skillSettings = z.object({ skills: z.object({
  directories: z.array(z.string().regex(/^[A-Za-z0-9._/-]+$/)).min(1).max(16).optional(), enabled: z.array(z.string()).optional(),
}).passthrough().optional() }).passthrough();

/** Runs an owner command with the archive on stdin; tests substitute one that runs as the test user. */
export type SkillOwnerRunner = (root: ArdentRoot, args: string[], timeout: number, input: Buffer) => Promise<string>;

/**
 * Install a HiveSkills release the control API fetched and checked: verify its digest and contents again,
 * install it as the owner into the profile's first skill directory, and optionally enable it through
 * Ardent's skills API with the caller's configuration revision. Replaces only a skill Magnus installed.
 */
export async function installSkill(root: ArdentRoot, profile: string, body: unknown, runOwner?: SkillOwnerRunner): Promise<ArdentSkillInstallResult> {
  const input = ardentSkillInstallNodeSchema.parse(body);
  const archive = Buffer.from(input.archive_base64, 'base64');
  if (archive.length > ARDENT_SKILL_ARCHIVE_LIMITS.archiveBytes) throw new SkillInstallRefused(400, 'Skill archive exceeds the size limit');
  if (createHash('sha256').update(archive).digest('hex') !== input.sha256) throw new SkillInstallRefused(400, 'Skill archive digest differs from the catalog release');
  let files: number;
  try {
    const tar = gunzipSync(archive, { maxOutputLength: ARDENT_SKILL_ARCHIVE_LIMITS.unpackedBytes });
    files = checkArdentSkillArchive(new Uint8Array(tar), input.name, source => YAML.parse(source) as unknown).files;
  } catch (error: unknown) {
    throw new SkillInstallRefused(400, `Skill archive is invalid: ${error instanceof Error ? error.message : 'unreadable'}`.slice(0, 200));
  }
  if (!runOwner && process.getuid?.() !== 0) throw new Error('Ardent skill installation requires a root node manager');
  const { config, dir } = await profileConfig(root.root, profile);
  const settings = skillSettings.parse(config).skills;
  const directory = settings?.directories?.[0] ?? 'skills';
  if (directory.startsWith('/') || directory.split('/').includes('..')) throw new Error('Ardent skill directory escapes the profile');
  const skillsRoot = join(dir, directory);
  const existingRoot = await realpath(skillsRoot).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existingRoot && !within(await realpath(dir), existingRoot)) throw new Error('Ardent skill directory escapes the profile');
  const destination = join(skillsRoot, input.name);
  const conflict = new SkillInstallRefused(409, `The profile has a skill named ${input.name} that Magnus did not install; rename or remove it first`);
  let prior: string | undefined;
  const info = await lstat(destination).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (info) {
    const receipt = join(destination, ARDENT_SKILL_RECEIPT_FILE);
    const receiptInfo = await lstat(receipt).catch(() => undefined);
    if (!info.isDirectory() || !receiptInfo?.isFile() || receiptInfo.size > 4096) throw conflict;
    try { prior = ardentSkillReceiptSchema.parse(JSON.parse(await readFile(receipt, 'utf8')) as unknown).sha256; }
    catch { prior = undefined; } // no-reason-needed: an unreadable receipt only means the release is installed again
  }
  const skillMdPresent = info ? await lstat(join(destination, 'SKILL.md')).then(entry => entry.isFile(), () => false) : false;
  const changed = prior !== input.sha256 || !skillMdPresent;
  if (changed) {
    const receipt = JSON.stringify({ schema_version: 1, source: 'hiveskills', name: input.name, version: input.version, sha256: input.sha256, installed_at: new Date().toISOString() });
    try { await (runOwner ?? runAsOwner)(root, ['/usr/bin/node', '-e', SKILL_INSTALL_SCRIPT, skillsRoot, input.name, receipt], 90_000, archive); }
    catch (error: unknown) {
      if (error instanceof Error && error.message.endsWith(`failed: ${SKILL_CONFLICT_EXIT}`)) throw conflict;
      throw error;
    }
  }
  let enabled = settings?.enabled?.includes(input.name) ?? false;
  let revision: string | null = null;
  let enableError: string | null = null;
  if (input.enable && !enabled) {
    if (!await probe(config.api.port, dir, config.api.token_env, profile)) enableError = 'The profile is not running; enable the skill once it is';
    else {
      const token = await managementToken(dir, config.api.token_env);
      let response: Response;
      let answer: ArrayBuffer;
      try {
        response = await fetch(`http://127.0.0.1:${config.api.port}/api/v1/skills/${input.name}`, {
          method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true, revision: input.revision }), redirect: 'error', signal: AbortSignal.timeout(15_000),
        });
        answer = await response.arrayBuffer();
      } catch (error: unknown) {
        if (!connectionRefused(error)) throw new ArdentOutcomeUncertain('Ardent did not answer the skill enable request completely', { cause: error });
        response = new Response(null, { status: 503 });
        answer = new ArrayBuffer(0);
      }
      let reply: unknown = null;
      try { reply = JSON.parse(Buffer.from(answer).toString('utf8')) as unknown; } catch { reply = null; } // no-reason-needed: a body that is not JSON is not a saved revision
      const saved = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(response.ok ? reply : null);
      if (saved.success) { enabled = true; revision = saved.data.revision; }
      else enableError = response.status === 409 ? 'The Ardent configuration changed since it was read; enable the skill from the list'
        : `Ardent answered the skill enable request with HTTP ${response.status}${upstreamMessage(answer)}`.slice(0, 200);
    }
  }
  return { source: 'hiveskills', name: input.name, version: input.version, sha256: input.sha256, files, changed, enabled, revision,
    enable_error: enableError, activation_required: changed || revision !== null };
}

export function createArdentRoutes(resolveRoot: () => Promise<ArdentRoot> = ardentRoot): Hono {
  const routes = new Hono();
  routes.get('/state', async c => {
    try { return c.json({ success: true, data: await readArdentState(await resolveRoot()) }); }
    catch (error: unknown) { return c.json({ success: false, error: error instanceof Error ? error.message.slice(0, 200) : 'Ardent inventory failed' }, 503); }
  });
  routes.get('/profiles/:name/context', async c => {
    try {
      const root = await resolveRoot();
      const profile = profileName.parse(c.req.param('name'));
      await profileConfig(root.root, profile);
      const name = await installedPackageName(root.install);
      if (!name) throw new Error('No supported Ardent runtime is installed');
      const release = await contextRelease();
      const unit = join(root.home, '.config/systemd/user', `ardent@${profile}.service`);
      const unitInfo = await lstat(unit);
      if (!unitInfo.isFile() || unitInfo.isSymbolicLink()) throw new Error('Ardent service unit is unsafe');
      const serviceUnitMatches = await readFile(unit, 'utf8') === ardentUserUnit(root, profile, name);
      return c.json({ schema_version: 1, engine_version: release.bundle.engine_version, bundle_sha256: release.sha256,
        base_sha256: await packageTreeDigest(packageDir(root.install, name)),
        policy_sha256: createHash('sha256').update(await readFile(join(root.root, 'model-policy/active.json'))).digest('hex'),
        config_sha256: createHash('sha256').update(await readFile(join(root.root, 'profiles', profile, 'config.yaml'))).digest('hex'),
        single_profile: JSON.stringify(await safeProfiles(root.root)) === JSON.stringify([profile]), service_unit_matches: serviceUnitMatches });
    } catch (error: unknown) {
      return c.json({ error: error instanceof Error ? error.message.slice(0, 200) : 'Context adoption preflight unavailable' }, 503);
    }
  });
  routes.get('/profiles/:name/context/:releaseId', async c => {
    try {
      return c.json(await inspectContextAdoption(await resolveRoot(), profileName.parse(c.req.param('name')), c.req.param('releaseId')));
    } catch (error: unknown) {
      return c.json({ error: error instanceof Error ? error.message.slice(0, 200) : 'Context adoption journal unavailable' }, 503);
    }
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
      if (streamedRead.test(suffix)) return await relayArdentStream(config.api.port, token, suffix, c.req.raw, c.req.raw.signal);
      const url = new URL(`http://127.0.0.1:${config.api.port}/${suffix === 'openapi' ? 'openapi.json' : `api/v1/${suffix}`}`);
      for (const [key, pattern] of Object.entries(readQuery)) {
        const value = c.req.query(key);
        if (value === undefined) continue;
        if (!pattern.test(value)) return c.json({ error: `Invalid ${key} query` }, 400);
        url.searchParams.set(key, value);
      }
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      const body = await response.arrayBuffer();
      if (body.byteLength > 2 * 1024 * 1024) return c.json({ error: 'Ardent management response exceeds size limit' }, 502);
      return new Response(new Uint8Array(body), { status: response.status, headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    } catch (error: unknown) {
      return c.json({ error: error instanceof Error ? error.message.slice(0, 200) : 'Ardent profile unavailable' }, 503);
    }
  });
  routes.post('/action', async c => {
    const parsed = actionInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid Ardent action' }, 400);
    const input = parsed.data;
    if (input.action === 'task-submit' && !z.object({ prompt: z.string().trim().min(1).max(16000), idempotency_key: z.string().guid(), session_id: z.string().guid().optional() }).strict().safeParse(input.body).success)
      return c.json({ error: 'Task submission requires a bounded prompt and idempotency key' }, 400);
    if (input.action === 'session-open' && !ardentSessionOpenSchema.safeParse(input.body).success)
      return c.json({ error: 'Session open requires a bounded key and a known context' }, 400);
    if (input.action === 'mission-submit' && !ardentMissionSubmitSchema.safeParse(input.body).success)
      return c.json({ error: 'Mission submission requires an objective, a team mission and an idempotency key within bounds' }, 400);
    if (input.action === 'preview-submit' && !ardentPreviewSubmitSchema.safeParse(input.body).success)
      return c.json({ error: 'Preview submission requires a bounded prompt and known overrides' }, 400);
    if (input.action === 'development-note' && !ardentDevelopmentNoteSchema.safeParse(input.body).success)
      return c.json({ error: 'Development note requires a kind, title and body within bounds' }, 400);
    if ((input.action === 'task-pause' || input.action === 'task-resume') && input.body !== undefined
      && !z.object({}).strict().safeParse(input.body).success) return c.json({ error: 'Task pause and resume take no body' }, 400);
    if (input.action === 'hivemem-credential-reload' && input.body !== undefined && !z.object({}).strict().safeParse(input.body).success)
      return c.json({ error: 'Credential reload takes no body; the token is read from the profile .env' }, 400);
    if (input.action === 'memory-search' && !z.object({ query: z.string().trim().min(1).max(1000) }).strict().safeParse(input.body).success)
      return c.json({ error: 'Memory search requires a bounded query' }, 400);
    if (input.action === 'skill-install' && !ardentSkillInstallNodeSchema.safeParse(input.body).success)
      return c.json({ error: 'Skill installation requires a HiveSkills release, its digest and its archive within bounds' }, 400);
    const route = actionRoutes[input.action];
    if (route.target ? !input.target || !route.target.test(input.target) : input.target !== undefined)
      return c.json({ error: 'Invalid Ardent action target' }, 400);
    const body = JSON.stringify(input.body ?? {});
    // A preview may carry a full soul and identity (128 KiB each) and a skill installation its archive (1 MiB, base64);
    // everything else, missions included, stays under 200 KB.
    const limit = input.action === 'preview-submit' ? 300_000 : input.action === 'skill-install' ? 1_500_000 : 200_000;
    if (Buffer.byteLength(body) > limit) return c.json({ error: 'Ardent action exceeds size limit' }, 413);
    try {
      const root = await resolveRoot();
      if (input.action === 'context-stage' || input.action === 'context-adopt' || input.action === 'context-rollback') {
        if (!managedExecution.getStore()) return c.json({ error: 'Context adoption requires a signed managed resource claim' }, 409);
        if (!contextAdoptionInput.safeParse(input.body).success) return c.json({ error: 'Context adoption requires exact release, source and policy pins' }, 400);
        await profileConfig(root.root, input.profile);
        return c.json(await manageContextAdoption(root, input.profile, input.action, input.body, {
          packageName: async () => { const name = await installedPackageName(root.install); if (!name) throw new Error('Ardent runtime is absent'); return name; },
          treeDigest: packageTreeDigest, profiles: () => safeProfiles(root.root),
          service: action => serviceAction(root, input.profile, action, true),
          checkService: async () => {
            const name = await installedPackageName(root.install);
            if (!name) throw new Error('Ardent runtime is absent');
            const path = join(root.home, '.config/systemd/user', `ardent@${input.profile}.service`);
            const info = await lstat(path);
            if (!info.isFile() || info.isSymbolicLink() || await readFile(path, 'utf8') !== ardentUserUnit(root, input.profile, name))
              throw new Error('Existing Ardent service does not match the reviewed managed unit');
          }
        }));
      }
      if (input.action === 'package-install') return c.json(await installPackage(root));
      if (input.action === 'profile-create') return c.json(await createProfile(root, input.profile, input.body));
      if (input.action === 'hivemem-credential-set') return c.json(await setHiveMemCredential(root, input.profile, input.body));
      if (input.action === 'skill-install') return c.json(await installSkill(root, input.profile, input.body));
      if (input.action === 'service-start' || input.action === 'service-stop' || input.action === 'service-restart') {
        return c.json(await serviceAction(root, input.profile, input.action));
      }
      const { config, dir } = await profileConfig(root.root, input.profile);
      if (!await probe(config.api.port, dir, config.api.token_env, input.profile)) throw new Error('Ardent management listener identity differs or is unavailable');
      const token = await managementToken(dir, config.api.token_env);
      const path = route.path(input.target);
      let response: Response;
      let result: ArrayBuffer;
      try {
        response = await fetch(`http://127.0.0.1:${config.api.port}/api/v1/${path}`, {
          method: route.method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body, redirect: 'error', signal: AbortSignal.timeout(input.action === 'provider-test' ? 30_000 : 15_000),
        });
        result = await response.arrayBuffer();
      } catch (error: unknown) {
        // A refused connection carried nothing. Anything later may have reached Ardent.
        if (connectionRefused(error)) throw new Error('Ardent management listener refused the connection');
        throw new ArdentOutcomeUncertain(`Ardent did not answer the ${input.action} request completely`, { cause: error });
      }
      if (result.byteLength > 2 * 1024 * 1024) return c.json({ error: 'Ardent action response exceeds size limit' }, 502);
      // Ardent answered in full, so its request is over even when it failed.
      if (response.status >= 500) return c.json({ success: false, error: { code: 'ARDENT_ACTION_FAILED',
        message: `Ardent answered ${input.action} with HTTP ${response.status}${upstreamMessage(result)}` } }, 424);
      // The signed managed HTTP receipt proves durable task admission, never
      // completion of the asynchronous model run. Return 200 for that bounded
      // admission so the node ledger can settle the synchronous operation.
      const status = ['task-submit', 'mission-submit', 'preview-submit'].includes(input.action) && response.status === 202 ? 200 : response.status;
      return new Response(new Uint8Array(result), { status, headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store' } });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message.slice(0, 200) : 'Ardent action unavailable';
      // Nothing changed: answer the refusal with its own status, so the caller can tell the person why.
      if (error instanceof SkillInstallRefused)
        return c.json({ success: false, error: { code: error.status === 409 ? 'SKILL_CONFLICT' : 'SKILL_ARCHIVE_INVALID', message } }, error.status);
      // Context adoption keeps its own journal and recovery, so its failures stay uncertain here.
      if (error instanceof ArdentOutcomeUncertain || input.action.startsWith('context-')) {
        logger.warn(`Ardent ${input.action} on ${input.profile} has an unknown outcome: ${message}`);
        return c.json({ error: message }, 503);
      }
      // The handler finished: answer a settled failure, so the managed command owner is released.
      return c.json({ success: false, error: { code: 'ARDENT_ACTION_FAILED', message } }, 422);
    }
  });
  return routes;
}

export const ardentRoutes = createArdentRoutes();
