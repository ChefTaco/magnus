import { readFile, readdir, lstat, realpath, writeFile, chown, rename, rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
  ARDENT_CONTENT_HEADER_PATTERNS, ARDENT_IF_RANGE_PATTERN, ARDENT_TASK_FILTER_QUERY, ardentCredentialReloadSchema, ARDENT_INSTANCE_REF_ENV, ARDENT_INSTANCE_REF_PATTERN, ARDENT_RANGE_PATTERN, ardentInstanceRef, ARDENT_SKILL_ARCHIVE_LIMITS, ARDENT_SKILL_RECEIPT_FILE,
  ardentArtifactImportSchema, ardentMediaType, ardentTraceHeaders, ardentDevelopmentNoteSchema, ardentMissionSubmitSchema,
  ardentPreviewSubmitSchema, ardentProfileCapabilities, ardentSessionOpenSchema, ardentSkillInstallNodeSchema, ardentSkillReceiptSchema,
  ardentTaskRecoveryDecisionSchema, checkArdentSkillArchive, parseArdentExecutionContext, type ArdentSkillInstallResult,
} from '@hivemagnus/magnus-contracts';
import { ARDENT_AGENT_CAPABILITIES } from '../ardent-capabilities.js';
import { ARDENT_EXTENSION_MANIFEST, assertArdentPluginsRetained, readArdentExtensionBundle, summarizeArdentExtensionBundle, validateArdentExtensionLock, type ArdentRetainedExtension } from './ardent-extensions.js';
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
  plugins: z.array(z.string().min(1).max(500)).max(32).default([]),
}).passthrough();
const acceptedPackageName = z.string().refine(name => ardentPackageNames().includes(name), 'Ardent package name is not accepted by MAGNUS_AGENT_ARDENT_PACKAGES');
const packageVersion = z.object({ name: acceptedPackageName, version: z.string() });
const installedPackageReceipt = z.object({
  schemaVersion: z.literal(1), name: acceptedPackageName,
  version: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  packageTreeSha256: z.string().regex(/^[a-f0-9]{64}$/),
  extensionBundleSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
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
export type ArdentRoot = { owner: string; home: string; root: string; install: string };

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export async function ardentRoot(): Promise<ArdentRoot> {
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

export async function profileConfig(root: string, name: string): Promise<{ config: ConfigSummary; dir: string }> {
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
  try { return await probeWith(port, await managementToken(dir, tokenEnv), profile); } catch { return false; }
}

/** Whether the profile's management API on `port` is this profile and accepts `token`. */
async function probeWith(port: number, token: string, profile: string): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/profile`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const identity: unknown = await response.json();
    // `ardent init` profiles report the product name Ardent; profiles from before the standalone
    // runtime report Magnus Ardent. Anything else on the port is not this profile.
    const parsed = z.object({ profile: z.string(), product: z.enum(['Ardent', 'Magnus Ardent']) }).safeParse(identity);
    return parsed.success && parsed.data.profile === profile;
  } catch { return false; }
}

/**
 * The profile's GET /api/v1/status, bounded, or undefined when it does not answer. Ardent 3.2.0 adds the
 * `recovery` counts and `capabilities.artifact_transfer` the inventory derives profile capabilities from.
 */
async function profileStatus(port: number, dir: string, tokenEnv: string): Promise<unknown> {
  try {
    const token = await managementToken(dir, tokenEnv);
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/status`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(1500) });
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); return undefined; }
    const body = await response.arrayBuffer();
    if (body.byteLength > 256 * 1024) return undefined;
    return JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
  } catch { return undefined; } // no-reason-needed: an unreadable status leaves the profile at its package version's capabilities
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

async function optionalStat(path: string) {
  return lstat(path).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
}

export async function verifiedPackageReceipt(install: string): Promise<z.infer<typeof installedPackageReceipt> | null> {
  const directory = await optionalStat(install);
  if (!directory) return null;
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Ardent installation path is unsafe');
  const receiptPath = join(install, 'package-receipt.json');
  const metadata = await optionalStat(receiptPath);
  if (!metadata) return null;
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096) throw new Error('Installed Ardent package receipt is unsafe');
  const receipt = installedPackageReceipt.safeParse(JSON.parse(await readFile(receiptPath, 'utf8')) as unknown);
  if (!receipt.success) return null;
  const root = packageDir(install, receipt.data.name);
  const expected = packageDir(await realpath(install), receipt.data.name);
  if (await realpath(root) !== expected) throw new Error('Installed Ardent package path is unsafe');
  if (await packageTreeDigest(root) !== receipt.data.packageTreeSha256) return null;
  const manifest = packageVersion.safeParse(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as unknown);
  if (!manifest.success || manifest.data.name !== receipt.data.name || manifest.data.version !== receipt.data.version) return null;
  await readArdentExtensionBundle(install, directory.uid, receipt.data.extensionBundleSha256, packageTreeDigest);
  return receipt.data;
}

export async function verifiedInstalledArdentPackage(install: string, staged: { name?: string; version: string; sha256: string }): Promise<boolean> {
  const receipt = await verifiedPackageReceipt(install);
  return receipt !== null && receipt.version === staged.version && receipt.sha256 === staged.sha256
    && (staged.name === undefined || receipt.name === staged.name);
}

/** Publish a verified candidate without overwriting any earlier checkpoint. */
export async function promoteArdentPackage(
  install: string, stage: string, staged: { name: string; version: string; sha256: string },
  move: (from: string, to: string) => Promise<void> = rename,
): Promise<{ previousAvailable: boolean; olderCheckpointRetained: boolean }> {
  if (!await verifiedInstalledArdentPackage(stage, staged)) throw new Error('Candidate Ardent package differs from its verified receipt');
  const previous = `${install}.previous`;
  const active = await optionalStat(install);
  if (active && (!active.isDirectory() || active.isSymbolicLink())) throw new Error('Ardent installation path is unsafe');
  const older = await optionalStat(previous);
  if (older && (!active || !await verifiedPackageReceipt(install) || !await verifiedPackageReceipt(previous))) {
    throw new Error('Ardent package checkpoint or active receipt cannot be verified; retain both for recovery');
  }
  const archive = older ? `${previous}.${randomUUID()}` : null;
  let archived = false;
  let movedPrior = false;
  let installed = false;
  try {
    if (archive) { await move(previous, archive); archived = true; }
    if (active) { await move(install, previous); movedPrior = true; }
    await move(stage, install); installed = true;
    if (!await verifiedInstalledArdentPackage(install, staged)) throw new Error('Installed Ardent package differs from its verified receipt');
    return { previousAvailable: movedPrior, olderCheckpointRetained: archived };
  } catch (error: unknown) {
    if (installed) await move(install, stage);
    if (movedPrior) await move(previous, install);
    if (archived && archive) await move(archive, previous);
    throw error;
  }
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
      const running = await probe(config.api.port, dir, config.api.token_env, name);
      // A running profile reports what it serves; a stopped one gets what its installed package offers.
      const status = running ? await profileStatus(config.api.port, dir, config.api.token_env) : undefined;
      return { id: name, name: config.name, backend: config.execution.backend, apiPort: config.api.port,
        running, a2aEnabled: config.a2a.enabled, channels: channelStates(config), error: null,
        ...ardentProfileCapabilities(status, version, ARDENT_AGENT_CAPABILITIES) };
    } catch (error: unknown) {
      return { id: name, name, backend: null, apiPort: null, running: false, a2aEnabled: false,
        channels: {}, error: error instanceof Error ? error.message.slice(0, 200) : 'Profile inspection failed',
        ...ardentProfileCapabilities(undefined, version, ARDENT_AGENT_CAPABILITIES) };
    }
  }));
  let staged: Awaited<ReturnType<typeof stagedPackage>> = null;
  let stagedPackageError: string | null = null;
  try { staged = await stagedPackage(); }
  catch (error: unknown) { stagedPackageError = error instanceof Error ? error.message.slice(0, 200) : 'Staged package unavailable'; }
  let extensions: ArdentRetainedExtension[] | null = [];
  let extensionsError: string | null = null;
  if (version !== null) {
    try { extensions = await retainedExtensions(root); }
    catch (error: unknown) { extensions = null; extensionsError = error instanceof Error ? error.message.slice(0, 200) : 'Retained extensions unavailable'; }
  }
  return { installed: version !== null, version, packageName, owner: root.owner, profiles, stagedPackage: staged, stagedPackageError,
    extensions, extensionsError, capabilities: ARDENT_AGENT_CAPABILITIES, checkedAt: new Date().toISOString() };
}

/** The reviewed extensions retained beside the installed runtime, bound to its package receipt. */
async function retainedExtensions(root: ArdentRoot): Promise<ArdentRetainedExtension[]> {
  const receiptPath = join(root.install, 'package-receipt.json');
  const metadata = await optionalStat(receiptPath);
  if (!metadata) return [];
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096) throw new Error('Installed Ardent package receipt is unsafe');
  const receipt = installedPackageReceipt.safeParse(JSON.parse(await readFile(receiptPath, 'utf8')) as unknown);
  if (!receipt.success) throw new Error('Installed Ardent package receipt is unreadable');
  return summarizeArdentExtensionBundle(root.install, (await lstat(root.home)).uid, receipt.data.extensionBundleSha256);
}

/**
 * The receipts of the HiveSkills releases Magnus installed on a profile (`.hiveskills.json` in each skill
 * directory of the profile's first skills directory). A skill without a readable receipt is a local skill
 * and is left out. Read only.
 */
export async function readSkillReceipts(root: ArdentRoot, profile: string): Promise<{ schema_version: 1; skills: Array<{ name: string; version: string; sha256: string }> }> {
  const { config, dir } = await profileConfig(root.root, profile);
  const directory = skillSettings.parse(config).skills?.directories?.[0] ?? 'skills';
  if (directory.startsWith('/') || directory.split('/').includes('..')) throw new Error('Ardent skill directory escapes the profile');
  const skillsRoot = join(dir, directory);
  const real = await realpath(skillsRoot).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!real) return { schema_version: 1, skills: [] };
  if (!within(await realpath(dir), real)) throw new Error('Ardent skill directory escapes the profile');
  const skills: Array<{ name: string; version: string; sha256: string }> = [];
  for (const entry of (await readdir(real, { withFileTypes: true })).slice(0, 500)) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(entry.name)) continue;
    const receipt = join(real, entry.name, ARDENT_SKILL_RECEIPT_FILE);
    const info = await optionalStat(receipt);
    if (!info?.isFile() || info.size > 4096) continue;
    try {
      const parsed = ardentSkillReceiptSchema.parse(JSON.parse(await readFile(receipt, 'utf8')) as unknown);
      if (parsed.name === entry.name) skills.push({ name: parsed.name, version: parsed.version, sha256: parsed.sha256 });
    } catch { /* no-reason-needed: an unreadable receipt marks a skill Magnus cannot vouch for, which is left out */ }
  }
  return { schema_version: 1, skills: skills.sort((left, right) => left.name.localeCompare(right.name)) };
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

const allowedRead = /^(?:openapi|status|profile|config|config\/schema|providers|channels|peers|peers\/config|memory\/status|skills|sessions|tasks|tasks\/[0-9a-f-]{36}(?:\/events|\/recovery|\/lineage)?|jobs\/definitions\/status|sessions\/[0-9a-f-]{36}\/messages|identity\/(?:soul|identity)(?:\/history)?|artifacts\/[a-f0-9]{64}(?:\/manifest|\/manifest\/v2|\/content|\/renditions)?|artifacts\/imports(?:\/[a-f0-9]{32})?|tasks\/[0-9a-f-]{36}\/(?:stream|artifacts)|development|metrics)$/;
/** Streamed rather than buffered: a task's events and an artifact's bytes (v1 octet stream, v2 content). */
const streamedRead = /^(?:artifacts\/[a-f0-9]{64}(?:\/content)?|tasks\/[0-9a-f-]{36}\/stream)$/;
/** Artifact transfer v2 content, relayed with its range and representation headers. */
const contentRead = /^artifacts\/[a-f0-9]{64}\/content$/;
/** The x-hive-execution value for a validated context, or undefined when it would exceed 2 KiB. */
function executionHeader(execution: unknown): string | undefined {
  const value = Buffer.from(JSON.stringify(execution), 'utf8').toString('base64url');
  return value.length <= 2048 ? value : undefined;
}
const RANGE = ARDENT_RANGE_PATTERN;
const IF_RANGE = ARDENT_IF_RANGE_PATTERN;
const CONTENT_HEADERS = ARDENT_CONTENT_HEADER_PATTERNS;
export { ardentMediaType, ardentTraceHeaders };
/** Query parameters passed to the profile API, each with the values it may hold. */
const readQuery: Record<string, RegExp> = {
  after: /^[A-Za-z0-9_-]{1,400}$/, limit: /^\d{1,3}$/, kind: /^[a-z][a-z0-9_]{0,63}$/, context: /^(?:direct|mission|preview)$/,
};
/** The task list adds Ardent 3.4.0's filters (state, caller, since, until and the peer and scheduled contexts). */
const taskListQuery: Record<string, RegExp> = { ...readQuery, ...ARDENT_TASK_FILTER_QUERY };
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
  const content = contentRead.test(suffix);
  const maxBytes = artifact ? ardentArtifactMaxBytes() : undefined;
  const url = new URL(`http://127.0.0.1:${port}/api/v1/${suffix}`);
  const after = new URL(request.url).searchParams.get('after');
  if (!artifact && after !== null) {
    if (!/^\d{1,15}$/.test(after)) return Response.json({ error: 'Invalid stream cursor' }, { status: 400 });
    url.searchParams.set('after', after);
  }
  const lastEventId = request.headers.get('last-event-id');
  const headers: Record<string, string> = { ...ardentTraceHeaders(name => request.headers.get(name)), Authorization: `Bearer ${token}`,
    Accept: content ? '*/*' : artifact ? 'application/octet-stream' : 'text/event-stream' };
  if (!artifact && lastEventId !== null && /^\d{1,15}$/.test(lastEventId)) headers['Last-Event-ID'] = lastEventId;
  if (content) {
    const range = request.headers.get('range');
    const ifRange = request.headers.get('if-range');
    if ((range !== null && !RANGE.test(range)) || (ifRange !== null && !IF_RANGE.test(ifRange)))
      return Response.json({ error: 'Invalid Range or If-Range' }, { status: 400 });
    if (range !== null) headers['Range'] = range;
    if (ifRange !== null) headers['If-Range'] = ifRange;
    return relayArdentContent(url, headers, maxBytes ?? DEFAULT_ARTIFACT_MAX_BYTES, clientSignal);
  }
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
/**
 * Relay artifact transfer v2 content: 200 for the whole artifact, 206 for one range, 416 when the range
 * is unsatisfiable. The real media type and the range, ETag, digest and disposition headers pass through;
 * the whole artifact (Content-Range's size, or the length of a full answer) stays under the cap.
 */
async function relayArdentContent(url: URL, headers: Record<string, string>, maxBytes: number, clientSignal: AbortSignal): Promise<Response> {
  const abort = new AbortController();
  const onClientAbort = () => abort.abort(clientSignal.reason);
  if (clientSignal.aborted) abort.abort(clientSignal.reason);
  else clientSignal.addEventListener('abort', onClientAbort, { once: true });
  const connect = setTimeout(() => abort.abort(new Error('Ardent stream did not answer')), 10_000);
  let response: Response;
  try { response = await fetch(url, { headers, redirect: 'error', signal: abort.signal }); }
  finally { clearTimeout(connect); }
  const passed = (names: string[]) => {
    const out: Record<string, string> = {};
    for (const name of names) {
      const value = response.headers.get(name);
      if (value !== null && CONTENT_HEADERS[name]!.test(value)) out[name] = value;
    }
    return out;
  };
  if (response.status === 416) {
    clientSignal.removeEventListener('abort', onClientAbort);
    const refused = await boundedError(response);
    return new Response(refused.body, { status: 416, headers: { ...Object.fromEntries(refused.headers), ...passed(['content-range', 'accept-ranges', 'etag']) } });
  }
  if (!response.ok || !response.body || (response.status !== 200 && response.status !== 206)) {
    clientSignal.removeEventListener('abort', onClientAbort);
    if (response.ok) { abort.abort(); return Response.json({ error: 'Ardent content answer is not 200 or 206' }, { status: 502 }); }
    return boundedError(response);
  }
  const length = Number(response.headers.get('content-length') ?? Number.NaN);
  const range = /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15})$/.exec(response.headers.get('content-range') ?? '');
  const total = response.status === 206 ? Number(range?.[3] ?? Number.NaN) : length;
  if (response.status === 206 && !range) {
    abort.abort();
    clientSignal.removeEventListener('abort', onClientAbort);
    return Response.json({ error: 'Ardent partial content has no valid Content-Range' }, { status: 502 });
  }
  if ((Number.isFinite(total) && total > maxBytes) || (Number.isFinite(length) && length > maxBytes)) {
    abort.abort();
    clientSignal.removeEventListener('abort', onClientAbort);
    return Response.json({ error: 'Ardent artifact exceeds size limit' }, { status: 502 });
  }
  const body = relayBody(response.body, abort, { idleMs: ARDENT_STREAM_IDLE_MS, idle: 'error', maxBytes });
  return new Response(body, { status: response.status, headers: {
    'Content-Type': ardentMediaType(response.headers.get('content-type')), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    ...(Number.isFinite(length) ? { 'Content-Length': String(length) } : {}),
    ...passed(['content-range', 'accept-ranges', 'etag', 'repr-digest', 'x-content-sha256', 'content-disposition']),
  } });
}
const actionInput = z.object({
  profile: profileName,
  action: z.enum(['profile-create', 'session-open', 'hivemem-credential-set', 'hivemem-credential-reload', 'config-validate', 'config-save', 'peer-validate', 'peer-save', 'identity-save', 'identity-restore', 'provider-test', 'channel-test', 'peer-test', 'memory-search', 'task-submit', 'task-cancel', 'mission-submit', 'task-pause', 'task-resume', 'preview-submit', 'development-note', 'skill-set', 'service-start', 'service-stop', 'service-restart', 'package-install', 'context-stage', 'context-adopt', 'context-rollback', 'skill-install', 'task-recovery', 'artifact-import', 'instance-ref-set', 'peer-credential-reload', 'management-credential-rotate']),
  target: z.string().max(128).optional(),
  body: z.unknown().optional(),
  /** An execution context v1 for task-submit, mission-submit and preview-submit; an invalid one is dropped. */
  execution: z.unknown().optional(),
  /** The caller's request ID and W3C trace, which a managed dispatch cannot carry as headers; invalid values are dropped. */
  trace: z.unknown().optional(),
}).strict();
/** Actions whose Ardent body takes an execution context. */
const EXECUTION_ACTIONS = new Set(['task-submit', 'mission-submit', 'preview-submit']);
/** Actions Ardent answers with 202 for a durable admission, which the agent settles as 200. */
const ADMISSION_ACTIONS = new Set(['task-submit', 'mission-submit', 'preview-submit', 'artifact-import']);
/** package-install's optional body: the node ID Magnus knows this node by, for ARDENT_INSTANCE_REF. */
const packageInstallInput = z.object({ node_id: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).optional() }).strict();
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
  'task-recovery': { method: 'POST', path: target => `tasks/${target}/recovery`, target: /^[0-9a-f-]{36}$/ },
  'artifact-import': { method: 'POST', path: () => 'artifacts/imports' },
  'instance-ref-set': { method: 'POST', path: () => '' },
  // Ardent 3.4.0 re-reads every A2A peer token from the profile's .env; a replaced inbound token stays valid for overlap_seconds.
  'peer-credential-reload': { method: 'POST', path: () => 'credentials/peers/reload' },
  // The agent writes a new management token and switches the gateway to it (rotateManagementCredential).
  'management-credential-rotate': { method: 'POST', path: () => '' },
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
  options: { cwd: root.home, timeout, maxBuffer: 32 * 1024, env: childEnvironment({
    HOME: root.home, USER: root.owner, LOGNAME: root.owner,
    npm_config_cache: join(root.home, '.npm'), NPM_CONFIG_CACHE: join(root.home, '.npm'),
  }) } };
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

async function assertArdentPackageQuiescent(root: ArdentRoot): Promise<void> {
  if (await optionalStat(join(root.install, 'context-adoption.json')))
    throw new Error('Resolve the context adoption before replacing the entire Ardent runtime');
  for (const profile of await safeProfiles(root.root)) {
    const { config, dir } = await profileConfig(root.root, profile);
    if (await probe(config.api.port, dir, config.api.token_env, profile))
      throw new Error(`Ardent profile ${profile} is running; stop it before updating the package`);
    if (await optionalStat(join(dir, 'state/gateway.lock')))
      throw new Error(`Ardent profile ${profile} has an execution lock; inspect it before package installation`);
  }
}

const ardentLifecycleOperations = new Set<string>();
export async function withArdentLifecycle<T>(install: string, operation: () => Promise<T>): Promise<T> {
  if (ardentLifecycleOperations.has(install)) throw new Error('Another Ardent package or service action is in progress');
  ardentLifecycleOperations.add(install);
  try { return await operation(); }
  finally { ardentLifecycleOperations.delete(install); }
}

/** Runs an owner command; tests substitute one that runs as the test user. */
export type OwnerRunner = (root: ArdentRoot, args: string[], timeout: number) => Promise<string>;

/**
 * Create, as the owner, the private staging directory beside the install prefix and return its path.
 * A fresh account may not have the prefix's parent yet (`~/.local/share` for the default prefix), so
 * every missing directory between the owner home and that parent is created first, one level at a time
 * and each as a new 0700 directory (never `mkdir -p`). Each level, new or existing, must resolve to a
 * directory inside the owner home before the next one is touched, so nothing is created through a
 * symbolic link that leads out of it. The stage itself is created without `-p`: one that already
 * exists fails.
 */
export async function createArdentInstallStage(root: ArdentRoot, runOwner: OwnerRunner = runAsOwner): Promise<string> {
  const parent = dirname(root.install);
  const stage = join(parent, `.ardent-install-${randomUUID()}`);
  if (!within(root.home, stage) || !within(root.home, `${root.install}.previous`)) throw new Error('Ardent install staging path escapes owner home');
  const home = await realpath(root.home);
  let path = root.home;
  for (const segment of relative(root.home, parent).split(sep).filter(Boolean)) {
    path = join(path, segment);
    if (!await optionalStat(path)) await runOwner(root, ['/usr/bin/mkdir', '-m', '700', '--', path], 10_000);
    const real = await realpath(path).catch(() => null);
    if (!real || !within(home, real) || !(await lstat(real)).isDirectory())
      throw new Error('Ardent install directory parent escapes the owner home or is not a directory');
  }
  await runOwner(root, ['/usr/bin/mkdir', '-m', '700', '--', stage], 10_000);
  return stage;
}

async function installPackage(root: ArdentRoot): Promise<object> {
  if (process.getuid?.() !== 0) throw new Error('Ardent package installation requires a root node manager');
  const staged = await stagedPackage();
  if (!staged) throw new Error('No verified Ardent package is staged with this node agent release');
  if (await verifiedInstalledArdentPackage(root.install, staged))
    return { installed: true, version: staged.version, changed: false };
  await assertArdentPackageQuiescent(root);
  const current = await verifiedPackageReceipt(root.install);
  const owner = await lstat(root.home);
  const extensions = await readArdentExtensionBundle(root.install, owner.uid, current?.extensionBundleSha256, packageTreeDigest);
  for (const profile of await safeProfiles(root.root)) assertArdentPluginsRetained((await profileConfig(root.root, profile)).config.plugins, extensions);
  const archive = process.env['ARDENT_STAGED_PACKAGE'] ?? '/opt/magnus-agent/ardent-package.tgz';
  const stage = await createArdentInstallStage(root);
  try {
    if (extensions) {
      await runAsOwner(root, ['/usr/bin/cp', '--no-clobber', '--', archive, join(stage, 'core-package.tgz')], 10_000);
      const core = await readFile(join(stage, 'core-package.tgz'));
      if (createHash('sha256').update(core).digest('hex') !== staged.sha256) throw new Error('Copied Ardent archive differs from the staged release');
      const dependencies: Record<string, string> = { [staged.name]: 'file:./core-package.tgz' };
      for (const extension of extensions.manifest.packages) {
        await runAsOwner(root, ['/usr/bin/cp', '--no-clobber', '--', join(root.install, extension.archive), join(stage, extension.archive)], 10_000);
        dependencies[extension.name] = `file:./${extension.archive}`;
      }
      const write = "require('fs').writeFileSync(process.argv[1],process.argv[2],{mode:0o600,flag:'wx'})";
      await runAsOwner(root, ['/usr/bin/node', '-e', write, join(stage, 'package.json'), `${JSON.stringify({ name: 'ardent-managed-runtime', private: true, dependencies })}\n`], 10_000);
      await runAsOwner(root, ['/usr/bin/node', '-e', write, join(stage, ARDENT_EXTENSION_MANIFEST), extensions.text], 10_000);
      await runAsOwner(root, ['/usr/bin/npm', 'install', '--prefix', stage, '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts', '--strict-peer-deps', '--registry=https://registry.npmjs.org'], 9 * 60_000);
      validateArdentExtensionLock(JSON.parse(await readFile(join(stage, 'package-lock.json'), 'utf8')) as unknown,
        { name: staged.name, version: staged.version, integrity: `sha512-${createHash('sha512').update(core).digest('base64')}` }, extensions);
      await runAsOwner(root, ['/usr/bin/npm', 'audit', '--prefix', stage, '--omit=dev', '--audit-level=high'], 60_000);
      await readArdentExtensionBundle(stage, owner.uid, extensions.sha256, packageTreeDigest);
    } else {
      await runAsOwner(root, ['/usr/bin/npm', 'install', '--prefix', stage, '--omit=dev', '--no-audit', '--no-fund', '--no-save', '--ignore-scripts', archive], 9 * 60_000);
    }
    const packageFile = join(packageDir(stage, staged.name), 'package.json');
    const candidate = packageVersion.parse(JSON.parse(await readFile(packageFile, 'utf8')) as unknown);
    if (candidate.name !== staged.name || candidate.version !== staged.version) throw new Error('Staged Ardent package name or version differs');
    await runAsOwner(root, ['/usr/bin/node', '-e', "const {DatabaseSync}=require(process.argv[1]);const db=new DatabaseSync(':memory:');if(db.prepare('SELECT sqlite_version() AS version').get().version!=='3.54.1')throw Error('Unverified embedded SQLite');db.close()", join(stage, 'node_modules/@photostructure/sqlite')], 10_000);
    const packageTreeSha256 = await packageTreeDigest(packageDir(stage, staged.name));
    await writeFile(join(stage, 'package-receipt.json'), `${JSON.stringify({
      schemaVersion: 1, name: staged.name, version: staged.version, sha256: staged.sha256, packageTreeSha256,
      ...(extensions ? { extensionBundleSha256: extensions.sha256 } : {}),
    })}\n`, { mode: 0o644, flag: 'wx' });
    await assertArdentPackageQuiescent(root);
    if (!within(await realpath(root.home), await realpath(dirname(root.install))))
      throw new Error('Ardent package directory escapes the owner home');
    const checkpoints = await promoteArdentPackage(root.install, stage, staged, async (from, to) => {
      await runAsOwner(root, ['/usr/bin/mv', '-T', '--no-clobber', '--', from, to], 10_000);
      if (await optionalStat(from) || !await optionalStat(to)) throw new Error('Ardent package move did not complete');
    });
    return { installed: true, version: staged.version, changed: true, ...checkpoints };
  } finally { await runAsOwner(root, ['/usr/bin/rm', '-rf', '--', stage], 10_000); }
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
export { ARDENT_INSTANCE_REF_ENV, ardentInstanceRef };
const jwt = z.string().max(8192).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
const instanceRef = z.string().regex(ARDENT_INSTANCE_REF_PATTERN);
/** The keys Magnus writes into a profile's `.env`, each with the values it may hold. */
const PROFILE_ENV_VALUES = { [ARDENT_HIVEMEM_TOKEN_ENV]: jwt, [ARDENT_INSTANCE_REF_ENV]: instanceRef } as const;

/**
 * Set one key in a profile's private `.env`, keeping every other line, its
 * owner and mode 0600. The file is replaced atomically, never followed through
 * a symlink, and never left world- or group-readable. Answers whether it changed.
 */
export async function writeProfileEnv(dir: string, key: keyof typeof PROFILE_ENV_VALUES, value: string): Promise<boolean> {
  PROFILE_ENV_VALUES[key].parse(value);
  return replaceProfileEnvLine(dir, key, value);
}

async function replaceProfileEnvLine(dir: string, key: string, value: string): Promise<boolean> {
  const file = join(dir, '.env');
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 64_000 || (info.mode & 0o077) !== 0) throw new Error('Ardent credential file is invalid');
  const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
  const current = lines.filter(line => line.startsWith(`${key}=`));
  if (current.length === 1 && current[0] === `${key}=${value}`) return false;
  const kept = lines.filter(line => !line.startsWith(`${key}=`));
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  const temporary = join(dir, `.${randomUUID()}.env`);
  try {
    await writeFile(temporary, [...kept, `${key}=${value}`, ''].join('\n'), { mode: 0o600, flag: 'wx' });
    await chown(temporary, info.uid, info.gid);
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
  return true;
}

export async function writeProfileCredential(dir: string, key: typeof ARDENT_HIVEMEM_TOKEN_ENV, value: string): Promise<void> {
  await writeProfileEnv(dir, key, value);
}

/** Write ARDENT_INSTANCE_REF into one profile's `.env`. Root only, like the HiveMem credential. */
async function setInstanceRef(root: ArdentRoot, profile: string, body: unknown): Promise<object> {
  if (process.getuid?.() !== 0) throw new Error('Ardent profile environment management requires a root node manager');
  const input = z.object({ instance_ref: instanceRef }).strict().parse(body);
  if (!input.instance_ref.endsWith(`.${profile}`) || input.instance_ref.length === profile.length + 1)
    throw new Error('The instance reference must be <node id>.<profile> for this profile');
  const { dir } = await profileConfig(root.root, profile);
  const changed = await writeProfileEnv(dir, ARDENT_INSTANCE_REF_ENV, input.instance_ref);
  return { profile, key: ARDENT_INSTANCE_REF_ENV, instanceRef: input.instance_ref, changed, activationRequired: changed };
}

/**
 * After a package install (changed or not): ARDENT_INSTANCE_REF=<node id>.<profile> in every profile, so an upgraded
 * runtime qualifies its references. A profile whose reference would be invalid, or whose `.env` cannot be written,
 * is reported and left as it was; the installed package stays.
 */
async function setInstanceRefs(root: ArdentRoot, nodeId: string): Promise<{ written: string[]; unchanged: string[]; skipped: Array<{ profile: string; reason: string }> }> {
  const result = { written: [] as string[], unchanged: [] as string[], skipped: [] as Array<{ profile: string; reason: string }> };
  for (const profile of await safeProfiles(root.root)) {
    const value = ardentInstanceRef(nodeId, profile);
    if (!value) { result.skipped.push({ profile, reason: 'The instance reference would exceed what Ardent accepts' }); continue; }
    try {
      const { dir } = await profileConfig(root.root, profile);
      (await writeProfileEnv(dir, ARDENT_INSTANCE_REF_ENV, value) ? result.written : result.unchanged).push(profile);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message.slice(0, 200) : 'Profile environment unavailable';
      logger.warn(`Ardent instance reference for ${profile} was not written: ${reason}`);
      result.skipped.push({ profile, reason });
    }
  }
  return result;
}

async function setHiveMemCredential(root: ArdentRoot, profile: string, body: unknown): Promise<object> {
  if (process.getuid?.() !== 0) throw new Error('Ardent credential management requires a root node manager');
  const input = z.object({ token: jwt }).strict().parse(body);
  const { dir } = await profileConfig(root.root, profile);
  await writeProfileCredential(dir, ARDENT_HIVEMEM_TOKEN_ENV, input.token);
  // Report only that the key is set: the token never leaves the node again.
  return { profile, tokenEnv: ARDENT_HIVEMEM_TOKEN_ENV, configured: true, activationRequired: true };
}

/** What Ardent accepts as a management token: 16 to 4096 characters without whitespace. */
const managementTokenValue = z.string().regex(/^\S{16,4096}$/);

/**
 * Rotate a running profile's management token without a restart (Ardent 3.4.0). The node agent reads the
 * token from the profile's `.env` for every request, so the new token is written there first and the
 * gateway is then told to switch to it, authenticated with the token it still uses; the replaced token
 * stays valid for `overlap_seconds`. When Ardent refuses, the previous token is written back. When the
 * outcome is unclear, the token the gateway accepts is kept, and with neither accepted the outcome is
 * unknown. Root only, like the HiveMem credential. The token never leaves the node.
 */
async function rotateManagementCredential(root: ArdentRoot, profile: string, body: unknown): Promise<object> {
  if (process.getuid?.() !== 0) throw new Error('Ardent credential management requires a root node manager');
  const input = ardentCredentialReloadSchema.parse(body ?? {});
  const { config, dir } = await profileConfig(root.root, profile);
  const tokenEnv = config.api.token_env;
  if (Object.hasOwn(PROFILE_ENV_VALUES, tokenEnv)) throw new Error('The management token variable is one Magnus manages for another purpose');
  if (process.env[tokenEnv]) throw new Error(`${tokenEnv} comes from the node agent's environment; rotate it there`);
  const previous = managementTokenValue.parse(await managementToken(dir, tokenEnv));
  const port = config.api.port;
  if (!await probeWith(port, previous, profile)) throw new Error('Ardent management listener identity differs or is unavailable');
  const next = randomBytes(32).toString('base64url');
  await replaceProfileEnvLine(dir, tokenEnv, next);
  const done = (changed: boolean, previousValidUntil: string | null) => ({ profile, tokenEnv, rotated: true, changed, previousValidUntil });
  // After a failure: keep the token the gateway now accepts, the new one first (both work during an overlap).
  const settle = async (failure: Error): Promise<object> => {
    if (await probeWith(port, next, profile)) return done(true, null);
    if (await probeWith(port, previous, profile)) {
      try { await replaceProfileEnvLine(dir, tokenEnv, previous); }
      catch (error: unknown) { throw new ArdentOutcomeUncertain('Ardent kept the previous management token, but it could not be written back', { cause: error }); }
      throw failure;
    }
    throw new ArdentOutcomeUncertain('Ardent accepts neither the previous nor the new management token after the reload', { cause: failure });
  };
  let response: Response;
  let answer: ArrayBuffer;
  try {
    response = await fetch(`http://127.0.0.1:${port}/api/v1/credentials/management/reload`, {
      method: 'POST', headers: { Authorization: `Bearer ${previous}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.timeout(15_000) });
    answer = await response.arrayBuffer();
  } catch (error: unknown) {
    return settle(new Error('Ardent did not answer the management credential reload', { cause: error }));
  }
  if (!response.ok) return settle(new Error(response.status === 404 ? 'Management credential rotation needs Ardent 3.4.0 or later'
    : `Ardent refused the management credential reload with HTTP ${response.status}${upstreamMessage(answer)}`));
  const result = z.object({ changed: z.boolean(), previous_valid_until: z.string().max(64).nullable() }).passthrough()
    .safeParse((() => { try { return JSON.parse(Buffer.from(answer).toString('utf8')) as unknown; } catch { return null; } })());
  if (!result.success) return settle(new Error('Ardent answered the management credential reload with an unexpected body'));
  return done(result.data.changed, result.data.previous_valid_until);
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
  routes.get('/profiles/:name/skill-receipts', async c => {
    try { return c.json(await readSkillReceipts(await resolveRoot(), profileName.parse(c.req.param('name')))); }
    catch (error: unknown) {
      return c.json({ error: error instanceof Error ? error.message.slice(0, 200) : 'Skill receipts unavailable' }, 503);
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
      for (const [key, pattern] of Object.entries(suffix === 'tasks' ? taskListQuery : readQuery)) {
        const value = c.req.query(key);
        if (value === undefined) continue;
        if (!pattern.test(value)) return c.json({ error: `Invalid ${key} query` }, 400);
        url.searchParams.set(key, value);
      }
      const response = await fetch(url, { headers: { ...ardentTraceHeaders(name => c.req.header(name)), Authorization: `Bearer ${token}` },
        redirect: 'error', signal: AbortSignal.timeout(10_000) });
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
    if ((input.action === 'peer-credential-reload' || input.action === 'management-credential-rotate') && input.body !== undefined
      && !ardentCredentialReloadSchema.safeParse(input.body).success) return c.json({ error: 'Credential reload takes only overlap_seconds (0 to 3600)' }, 400);
    if (input.action === 'memory-search' && !z.object({ query: z.string().trim().min(1).max(1000) }).strict().safeParse(input.body).success)
      return c.json({ error: 'Memory search requires a bounded query' }, 400);
    if (input.action === 'skill-install' && !ardentSkillInstallNodeSchema.safeParse(input.body).success)
      return c.json({ error: 'Skill installation requires a HiveSkills release, its digest and its archive within bounds' }, 400);
    if (input.action === 'task-recovery' && !ardentTaskRecoveryDecisionSchema.safeParse(input.body).success)
      return c.json({ error: 'Task recovery requires a known action and bounded call, result, note and deadline' }, 400);
    if (input.action === 'artifact-import' && !ardentArtifactImportSchema.safeParse(input.body).success)
      return c.json({ error: 'Artifact import requires a peer, its task and an artifact ID' }, 400);
    if (input.action === 'package-install' && input.body !== undefined && !packageInstallInput.safeParse(input.body).success)
      return c.json({ error: 'Package installation takes only the node ID for the profiles\' instance references' }, 400);
    const route = actionRoutes[input.action];
    if (route.target ? !input.target || !route.target.test(input.target) : input.target !== undefined)
      return c.json({ error: 'Invalid Ardent action target' }, 400);
    // Attribution only: a context or trace of the wrong shape is dropped, never refused.
    const execution = EXECUTION_ACTIONS.has(input.action) ? parseArdentExecutionContext(input.execution) : undefined;
    const trace = z.object({ request_id: z.unknown().optional(), traceparent: z.unknown().optional() }).safeParse(input.trace);
    const forwarded = ardentTraceHeaders(name => {
      const value = name === 'x-request-id' ? (trace.success ? trace.data.request_id : undefined)
        : name === 'traceparent' ? (trace.success ? trace.data.traceparent : undefined) : undefined;
      return typeof value === 'string' ? value : c.req.header(name);
    });
    if (execution) {
      const header = executionHeader(execution);
      if (header) forwarded['x-hive-execution'] = header; else delete forwarded['x-hive-execution'];
    }
    const body = JSON.stringify(execution ? { ...(input.body as object), execution } : input.body ?? {});
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
        const action = input.action;
        return c.json(await withArdentLifecycle(root.install, () => manageContextAdoption(root, input.profile, action, input.body, {
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
        })));
      }
      if (input.action === 'package-install') {
        const nodeId = input.body === undefined ? undefined : packageInstallInput.parse(input.body).node_id;
        return c.json(await withArdentLifecycle(root.install, async () => {
          const installed = await installPackage(root);
          return nodeId === undefined ? installed : { ...installed, instanceRefs: await setInstanceRefs(root, nodeId) };
        }));
      }
      if (input.action === 'instance-ref-set') return c.json(await setInstanceRef(root, input.profile, input.body));
      if (input.action === 'profile-create') return c.json(await withArdentLifecycle(root.install, () => createProfile(root, input.profile, input.body)));
      if (input.action === 'hivemem-credential-set') return c.json(await setHiveMemCredential(root, input.profile, input.body));
      if (input.action === 'management-credential-rotate')
        return c.json(await withArdentLifecycle(root.install, () => rotateManagementCredential(root, input.profile, input.body)));
      if (input.action === 'skill-install') return c.json(await installSkill(root, input.profile, input.body));
      if (input.action === 'service-start' || input.action === 'service-stop' || input.action === 'service-restart') {
        const action = input.action;
        return c.json(await withArdentLifecycle(root.install, () => serviceAction(root, input.profile, action)));
      }
      const { config, dir } = await profileConfig(root.root, input.profile);
      if (!await probe(config.api.port, dir, config.api.token_env, input.profile)) throw new Error('Ardent management listener identity differs or is unavailable');
      const token = await managementToken(dir, config.api.token_env);
      const path = route.path(input.target);
      let response: Response;
      let result: ArrayBuffer;
      try {
        response = await fetch(`http://127.0.0.1:${config.api.port}/api/v1/${path}`, {
          method: route.method, headers: { ...forwarded, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
      const status = ADMISSION_ACTIONS.has(input.action) && response.status === 202 ? 200 : response.status;
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
