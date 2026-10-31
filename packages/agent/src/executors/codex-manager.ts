import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, readFile, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Hono, type Context } from 'hono';
import { childEnvironment } from '../utils/child-env.js';
import { armChildTimeout } from '../utils/child-timeout.js';

const CODEX_PACKAGE = '@openai/codex';
const DEVICE_LOGIN_TTL_MS = 15 * 60_000;
const RPC_TIMEOUT_MS = 20_000;
const VERSION_CACHE_MS = 10 * 60_000;

export type CodexAuthStatus =
  | 'authenticated'
  | 'not_authenticated'
  | 'wrong_auth_mode'
  | 'expired_logged_out'
  | 'error';

export interface CodexNodeState {
  installed: boolean;
  user: string;
  userHome: string;
  codexHome: string;
  codexBin: string | null;
  version: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  provenance: CodexProvenance;
  updateSupported: boolean;
  auth: {
    status: CodexAuthStatus;
    mode: 'chatgpt' | 'apiKey' | 'other' | null;
    oauth: boolean;
    tokenExpiresAt: string | null;
    tokenExpired: boolean | null;
    refreshTokenPresent: boolean;
    lastRefreshAt: string | null;
    planType: string | null;
    autoLoggedOut: boolean;
    message: string;
  };
  checkedAt: string;
  error: string | null;
}

export interface CodexDeviceAuthSession {
  id: string;
  status: 'pending' | 'completed' | 'failed' | 'expired' | 'cancelled';
  verificationUrl: string;
  userCode: string;
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
  error: string | null;
}

interface CodexTarget {
  user: string;
  home: string;
  codexHome: string;
  bin: string | null;
  provenance: CodexProvenance;
}

export type CodexProvenance = 'standalone' | 'npm' | 'nvm' | 'fnm' | 'asdf' | 'mise' | 'volta' | 'pnpm' | 'bun' | 'nix' | 'snap' | 'unknown';

export function codexProvenance(bin: string | null, resolvedBin: string | null, codexHome: string): CodexProvenance {
  if (!bin) return 'unknown';
  if (resolvedBin && isStandaloneCodexInstall(codexHome, resolvedBin)) return 'standalone';
  if (bin.includes('/.volta/')) return 'volta';
  if (bin.includes('/.bun/')) return 'bun';
  if (bin.includes('/.nix-profile/') || bin.startsWith('/nix/')) return 'nix';
  if (bin.startsWith('/snap/')) return 'snap';
  if (bin.includes('/.local/share/pnpm/')) return 'pnpm';
  if (bin.includes('/.asdf/')) return 'asdf';
  if (bin.includes('/.local/share/mise/')) return 'mise';
  const prefix = codexNpmInstallPrefix(bin);
  const npmOwned = prefix && resolvedBin?.startsWith(`${prefix}/lib/node_modules/@openai/codex/`);
  if (bin.includes('/.nvm/')) return npmOwned ? 'nvm' : 'unknown';
  if (bin.includes('/.fnm/') || bin.includes('/.local/share/fnm/')) return npmOwned ? 'fnm' : 'unknown';
  // A generic /bin path is not evidence of npm ownership. Require the actual
  // executable to live under the matching prefix's npm package directory.
  if (npmOwned) return 'npm';
  return 'unknown';
}

export function codexUpdateSupported(provenance: CodexProvenance): boolean {
  return provenance === 'standalone' || provenance === 'npm' || provenance === 'nvm' || provenance === 'fnm';
}

export function codexTargetEnvironment(home: string, codexHome: string): Record<string, string> {
  const environment: Record<string, string> = { HOME: home };
  // Codex creates its default home on first use. Explicitly pointing CODEX_HOME
  // at that not-yet-created directory makes current clients reject startup,
  // which prevents Magnus from offering the initial device-login flow.
  if (codexHome !== `${home}/.codex`) environment['CODEX_HOME'] = codexHome;
  return environment;
}

interface RpcEnvelope {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { message?: string };
  params?: unknown;
}

interface ManagedDeviceSession {
  public: CodexDeviceAuthSession;
  user: string;
  loginId: string;
  rpc: CodexRpcSession;
  timeout: ReturnType<typeof setTimeout>;
}

const deviceSessions = new Map<string, ManagedDeviceSession>();
const FINISHED_DEVICE_SESSION_RETENTION_MS = 60 * 60 * 1000;
const activeSessionByUser = new Map<string, string>();
let latestVersionCache: { value: string | null; at: number } | null = null;
let updateInFlight: Promise<CodexNodeState> | null = null;

function safeMessage(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(/(access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|authorization)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .slice(0, 1000);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function executableByUser(user: string, path: string): Promise<boolean> {
  if (process.getuid?.() !== 0 || user === 'root') return exists(path);
  return new Promise((resolve) => {
    const child = spawn('/usr/sbin/runuser', ['-u', user, '--', '/usr/bin/test', '-x', path], {
      stdio: 'ignore',
    });
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
  });
}

export function codexVersionManagerPaths(root: string, versions: string[], suffix = 'bin/codex'): string[] {
  return [...versions]
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true, sensitivity: 'base' }))
    .map((version) => join(root, version, suffix));
}

export function codexNpmInstallPrefix(codexBin: string): string | null {
  const binDirectory = dirname(codexBin);
  return binDirectory.endsWith('/bin') ? dirname(binDirectory) : null;
}

export function codexNpmCandidates(codexBin: string | null): string[] {
  return [...new Set([
    codexBin ? join(dirname(codexBin), 'npm') : null,
    '/usr/bin/npm',
    '/usr/local/bin/npm',
  ].filter((candidate): candidate is string => Boolean(candidate)))];
}

async function versionManagerPaths(home: string): Promise<string[]> {
  const layouts = [
    { root: `${home}/.nvm/versions/node`, suffix: 'bin/codex' },
    { root: `${home}/.local/share/fnm/node-versions`, suffix: 'installation/bin/codex' },
    { root: `${home}/.fnm/node-versions`, suffix: 'installation/bin/codex' },
    { root: `${home}/.asdf/installs/nodejs`, suffix: 'bin/codex' },
    { root: `${home}/.local/share/mise/installs/node`, suffix: 'bin/codex' },
  ];
  const paths: string[] = [];
  for (const layout of layouts) {
    try {
      const entries = await readdir(layout.root, { withFileTypes: true });
      paths.push(...codexVersionManagerPaths(
        layout.root,
        entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => entry.name),
        layout.suffix,
      ));
    } catch {
      // A missing version manager is the normal case on most nodes.
    }
  }
  return paths;
}

async function resolveUser(): Promise<{ user: string; home: string }> {
  const requested = [
    process.env['CODEX_USER'],
    process.env['HERMES_USER'],
    process.env['HERMES_OWNER'],
    process.env['SUDO_USER'],
    process.env['USER'] === 'root' ? null : process.env['USER'],
  ].find((value): value is string => Boolean(value?.trim()))?.trim() ?? 'root';

  try {
    const passwd = await readFile('/etc/passwd', 'utf8');
    const row = passwd.split('\n').find((line) => line.split(':')[0] === requested);
    const home = row?.split(':')[5];
    if (home) return { user: requested, home };
  } catch {
    // Minimal containers may not expose /etc/passwd.
  }
  return { user: requested, home: requested === 'root' ? '/root' : `/home/${requested}` };
}

async function resolveTarget(): Promise<CodexTarget> {
  const identity = await resolveUser();
  const codexHome = process.env['CODEX_HOME']?.trim() || `${identity.home}/.codex`;
  const candidates = [
    process.env['CODEX_BIN'],
    '/usr/bin/codex',
    '/usr/local/bin/codex',
    `${identity.home}/.npm-global/bin/codex`,
    `${identity.home}/.local/bin/codex`,
    `${identity.home}/.local/share/pnpm/codex`,
    `${identity.home}/.volta/bin/codex`,
    `${identity.home}/.bun/bin/codex`,
    `${identity.home}/.asdf/shims/codex`,
    `${identity.home}/.local/share/mise/shims/codex`,
    `${identity.home}/.nix-profile/bin/codex`,
    '/nix/var/nix/profiles/default/bin/codex',
    '/snap/bin/codex',
    ...await versionManagerPaths(identity.home),
  ].filter((value): value is string => Boolean(value));
  let bin: string | null = null;
  for (const candidate of new Set(candidates)) {
    if (await executableByUser(identity.user, candidate)) {
      bin = candidate;
      break;
    }
  }
  const resolvedBin = bin ? await realpath(bin).catch(() => bin) : null;
  return { ...identity, codexHome, bin, provenance: codexProvenance(bin, resolvedBin, codexHome) };
}

function spawnForTarget(target: CodexTarget, command: string, args: string[]): ChildProcessWithoutNullStreams {
  const targetEnvironment = codexTargetEnvironment(target.home, target.codexHome);
  const environment = Object.entries(targetEnvironment).map(([key, value]) => `${key}=${value}`);
  if (process.getuid?.() === 0 && target.user !== 'root') {
    return spawn('/usr/sbin/runuser', [
      '-u', target.user, '--', '/usr/bin/env',
      '-u', 'OPENAI_API_KEY', '-u', 'CODEX_ACCESS_TOKEN', '-u', 'CODEX_HOME',
      ...environment, command, ...args,
    ], {
      env: childEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  const childEnv = childEnvironment(targetEnvironment);
  delete childEnv['OPENAI_API_KEY'];
  delete childEnv['CODEX_ACCESS_TOKEN'];
  if (!targetEnvironment['CODEX_HOME']) delete childEnv['CODEX_HOME'];
  return spawn(command, args, {
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function runForTarget(
  target: CodexTarget,
  command: string,
  args: string[],
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnForTarget(target, command, args);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const disarm = armChildTimeout(child, timeoutMs, () => { timedOut = true; });
    child.stdout.on('data', (chunk: Buffer) => { stdout = `${stdout}${chunk.toString()}`.slice(-64_000); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-64_000); });
    child.on('error', (error) => {
      disarm();
      resolve({ code: 127, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on('close', (code) => {
      disarm();
      resolve({ code: timedOut ? 124 : code ?? 1, stdout, stderr: timedOut ? `${stderr}\nCommand timed out` : stderr });
    });
  });
}

export function parseCodexVersion(value: string): string | null {
  return value.match(/(?:codex-cli\s+)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1] ?? null;
}

function versionParts(version: string): number[] {
  return version.split('-', 1)[0]!.split('.').map((part) => Number.parseInt(part, 10) || 0);
}

export function isVersionBehind(current: string | null, latest: string | null): boolean {
  if (!current || !latest) return false;
  const left = versionParts(current);
  const right = versionParts(latest);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0;
  }
  return false;
}

export function parseNpmCodexVersion(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    const values = typeof parsed === 'string'
      ? [parsed]
      : Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    const versions = values.map(parseCodexVersion).filter((version): version is string => Boolean(version));
    return versions.reduce<string | null>((latest, version) => (
      latest === null || isVersionBehind(latest, version) ? version : latest
    ), null);
  } catch {
    return parseCodexVersion(value);
  }
}

export function isStandaloneCodexInstall(codexHome: string, resolvedBin: string): boolean {
  const standaloneRoot = join(codexHome, 'packages', 'standalone');
  return resolvedBin === join(standaloneRoot, 'current', 'bin', 'codex')
    || resolvedBin.startsWith(`${join(standaloneRoot, 'releases')}/`);
}

export function decodeJwtExpiration(token: string | null | undefined): string | null {
  if (!token) return null;
  try {
    const segment = token.split('.')[1];
    if (!segment) return null;
    const payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? new Date(payload.exp * 1000).toISOString()
      : null;
  } catch {
    return null;
  }
}

class CodexRpcSession {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  readonly #listeners = new Set<(message: RpcEnvelope) => void>();
  readonly #exitListeners = new Set<() => void>();
  #buffer = '';
  #nextId = 1;
  #stderr = '';
  #closed = false;

  constructor(target: CodexTarget) {
    if (!target.bin) throw new Error('Codex CLI is not installed');
    this.#child = spawnForTarget(target, target.bin, ['app-server']);
    this.#child.stdout.on('data', (chunk: Buffer) => this.#consume(chunk.toString()));
    this.#child.stderr.on('data', (chunk: Buffer) => { this.#stderr = `${this.#stderr}${chunk.toString()}`.slice(-4000); });
    this.#child.on('error', (error) => this.#failAll(error));
    this.#child.on('close', (code) => {
      this.#failAll(new Error(`Codex app-server exited with code ${code ?? 1}: ${safeMessage(this.#stderr)}`));
      for (const listener of this.#exitListeners) listener();
    });
  }

  /** Called once the app-server process has exited, for any reason. */
  onExit(listener: () => void): void {
    this.#exitListeners.add(listener);
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'magnus', title: 'Magnus Fleet Manager', version: '1.0.0' },
      capabilities: { optOutNotificationMethods: ['thread/started', 'item/agentMessage/delta'] },
    });
    this.notify('initialized', {});
  }

  onNotification(listener: (message: RpcEnvelope) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error('Codex app-server session is closed'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.#write({ method, params });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.stdin.end();
    this.#child.kill('SIGTERM');
    const child = this.#child;
    if (child.exitCode === null && child.signalCode === null) {
      const hardKill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000);
      hardKill.unref();
      child.once('exit', () => clearTimeout(hardKill));
    }
    this.#failAll(new Error('Codex app-server session closed'));
  }

  #write(message: RpcEnvelope): void {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    while (true) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      let message: RpcEnvelope;
      try { message = JSON.parse(line) as RpcEnvelope; } catch { continue; }
      if (typeof message.id === 'number') {
        const pending = this.#pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.#pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? 'Codex app-server request failed'));
        else pending.resolve(message.result);
      } else if (message.method) {
        for (const listener of this.#listeners) listener(message);
      }
    }
  }

  #failAll(error: Error): void {
    if (this.#closed && this.#pending.size === 0) return;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

async function openRpc(target: CodexTarget): Promise<CodexRpcSession> {
  const rpc = new CodexRpcSession(target);
  try {
    await rpc.initialize();
    return rpc;
  } catch (error) {
    rpc.close();
    throw error;
  }
}

async function readAuthMetadata(target: CodexTarget): Promise<{
  mode: string | null;
  expiresAt: string | null;
  refreshTokenPresent: boolean;
  lastRefreshAt: string | null;
}> {
  try {
    const raw = JSON.parse(await readFile(`${target.codexHome}/auth.json`, 'utf8')) as {
      auth_mode?: unknown;
      tokens?: { access_token?: unknown; refresh_token?: unknown };
      last_refresh?: unknown;
    };
    return {
      mode: typeof raw.auth_mode === 'string' ? raw.auth_mode : null,
      expiresAt: decodeJwtExpiration(typeof raw.tokens?.access_token === 'string' ? raw.tokens.access_token : null),
      refreshTokenPresent: typeof raw.tokens?.refresh_token === 'string' && raw.tokens.refresh_token.length > 0,
      lastRefreshAt: typeof raw.last_refresh === 'string' ? raw.last_refresh : null,
    };
  } catch {
    return { mode: null, expiresAt: null, refreshTokenPresent: false, lastRefreshAt: null };
  }
}

async function latestCodexVersion(refresh = false, target?: CodexTarget): Promise<string | null> {
  if (!refresh && latestVersionCache && Date.now() - latestVersionCache.at < VERSION_CACHE_MS) return latestVersionCache.value;
  const identity = target ?? { ...await resolveUser(), codexHome: '', bin: null, provenance: 'unknown' as const };
  const queryTarget: CodexTarget = {
    ...identity,
    codexHome: identity.codexHome || `${identity.home}/.codex`,
    bin: null,
  };
  let npmBin: string | null = null;
  for (const candidate of codexNpmCandidates(target?.bin ?? null)) {
    if (await executableByUser(identity.user, candidate)) {
      npmBin = candidate;
      break;
    }
  }
  if (!npmBin) {
    latestVersionCache = { value: null, at: Date.now() };
    return null;
  }
  const npmCache = join(tmpdir(), `magnus-codex-npm-cache-${identity.user}`);
  const result = await runForTarget(queryTarget, npmBin, ['view', CODEX_PACKAGE, 'version', '--json', '--cache', npmCache], 20_000);
  let value: string | null = null;
  if (result.code === 0) {
    value = parseNpmCodexVersion(result.stdout);
  }
  latestVersionCache = { value, at: Date.now() };
  return value;
}

function accountType(result: unknown): { type: string | null; planType: string | null } {
  if (!result || typeof result !== 'object') return { type: null, planType: null };
  const account = (result as { account?: unknown }).account;
  if (!account || typeof account !== 'object') return { type: null, planType: null };
  const record = account as Record<string, unknown>;
  return {
    type: typeof record['type'] === 'string' ? record['type'] : null,
    planType: typeof record['planType'] === 'string' ? record['planType'] : null,
  };
}

async function logoutWithRpc(target: CodexTarget, existing?: CodexRpcSession): Promise<void> {
  const rpc = existing ?? await openRpc(target);
  try {
    await rpc.request('account/logout');
  } finally {
    if (!existing) rpc.close();
  }
}

export async function collectCodexState(refreshLatest = false): Promise<CodexNodeState> {
  const checkedAt = new Date().toISOString();
  const target = await resolveTarget();
  if (!target.bin) {
    return {
      installed: false,
      user: target.user,
      userHome: target.home,
      codexHome: target.codexHome,
      codexBin: null,
      version: null,
      latestVersion: await latestCodexVersion(refreshLatest, target),
      updateAvailable: false,
      provenance: target.provenance, updateSupported: false,
      auth: {
        status: 'not_authenticated', mode: null, oauth: false, tokenExpiresAt: null,
        tokenExpired: null, refreshTokenPresent: false, lastRefreshAt: null,
        planType: null, autoLoggedOut: false, message: 'Codex CLI is not installed.',
      },
      checkedAt,
      error: null,
    };
  }

  const [versionResult, latestVersion] = await Promise.all([
    runForTarget(target, target.bin, ['--version']),
    latestCodexVersion(refreshLatest, target),
  ]);
  const version = versionResult.code === 0 ? parseCodexVersion(versionResult.stdout || versionResult.stderr) : null;
  let rpc: CodexRpcSession | null = null;
  try {
    rpc = await openRpc(target);
    const metadata = await readAuthMetadata(target);
    const tokenExpired = metadata.expiresAt ? Date.parse(metadata.expiresAt) <= Date.now() : null;
    if (metadata.mode === 'chatgpt' && tokenExpired === true) {
      await logoutWithRpc(target, rpc);
      console.warn(`[codex-manager] Logged out expired Codex OAuth credentials for ${target.user}`);
      return {
        installed: true, user: target.user, userHome: target.home, codexHome: target.codexHome,
        codexBin: target.bin, version, latestVersion, provenance: target.provenance, updateSupported: codexUpdateSupported(target.provenance), updateAvailable: codexUpdateSupported(target.provenance) && isVersionBehind(version, latestVersion),
        auth: {
          status: 'expired_logged_out', mode: 'chatgpt', oauth: false,
          tokenExpiresAt: metadata.expiresAt, tokenExpired: true,
          refreshTokenPresent: false, lastRefreshAt: metadata.lastRefreshAt,
          planType: null, autoLoggedOut: true,
          message: 'The OAuth access token expired and Codex was logged out.',
        },
        checkedAt, error: null,
      };
    }
    let accountResult: unknown = null;
    let accountError: Error | null = null;
    try {
      accountResult = await rpc.request('account/read', { refreshToken: false });
    } catch (error) {
      accountError = error instanceof Error ? error : new Error(String(error));
    }
    const account = accountType(accountResult);
    const mode = account.type === 'chatgpt' ? 'chatgpt' : account.type === 'apiKey' ? 'apiKey' : account.type ? 'other' : null;
    const authenticated = mode === 'chatgpt' && tokenExpired === false && metadata.refreshTokenPresent;
    const status: CodexAuthStatus = authenticated
      ? 'authenticated'
      : mode && mode !== 'chatgpt' ? 'wrong_auth_mode'
        : accountError ? 'error' : 'not_authenticated';
    const message = authenticated
      ? 'ChatGPT OAuth is active and the access token is current.'
      : status === 'wrong_auth_mode' ? 'Codex is authenticated, but not with ChatGPT OAuth.'
        : accountError ? `Codex OAuth validation failed: ${safeMessage(accountError)}`
          : 'Codex is not authenticated with ChatGPT OAuth.';
    return {
      installed: true, user: target.user, userHome: target.home, codexHome: target.codexHome,
      codexBin: target.bin, version, latestVersion, provenance: target.provenance, updateSupported: codexUpdateSupported(target.provenance), updateAvailable: codexUpdateSupported(target.provenance) && isVersionBehind(version, latestVersion),
      auth: {
        status, mode, oauth: authenticated, tokenExpiresAt: metadata.expiresAt,
        tokenExpired, refreshTokenPresent: metadata.refreshTokenPresent,
        lastRefreshAt: metadata.lastRefreshAt, planType: account.planType,
        autoLoggedOut: false, message,
      },
      checkedAt, error: accountError ? safeMessage(accountError) : null,
    };
  } catch (error) {
    const metadata = await readAuthMetadata(target);
    const tokenExpired = metadata.expiresAt ? Date.parse(metadata.expiresAt) <= Date.now() : null;
    return {
      installed: true, user: target.user, userHome: target.home, codexHome: target.codexHome,
      codexBin: target.bin, version, latestVersion, provenance: target.provenance, updateSupported: codexUpdateSupported(target.provenance), updateAvailable: codexUpdateSupported(target.provenance) && isVersionBehind(version, latestVersion),
      auth: {
        status: 'error', mode: metadata.mode === 'chatgpt' ? 'chatgpt' : metadata.mode ? 'other' : null,
        oauth: false, tokenExpiresAt: metadata.expiresAt, tokenExpired,
        refreshTokenPresent: metadata.refreshTokenPresent, lastRefreshAt: metadata.lastRefreshAt,
        planType: null, autoLoggedOut: false,
        message: `Codex authentication could not be verified: ${safeMessage(error)}`,
      },
      checkedAt, error: safeMessage(error),
    };
  } finally {
    rpc?.close();
  }
}

export async function updateCodex(): Promise<CodexNodeState> {
  if (updateInFlight) return updateInFlight;
  updateInFlight = (async () => {
    const target = await resolveTarget();
    if (!target.bin) throw new Error('Codex CLI is not installed');
    if (!codexUpdateSupported(target.provenance)) throw new Error(`Codex installation is read-only (${target.provenance})`);
    if (target.provenance === 'standalone') {
      const result = await runForTarget(target, target.bin, ['update'], 10 * 60_000);
      if (result.code !== 0) throw new Error(`Codex update failed: ${safeMessage(result.stderr || result.stdout)}`);
      latestVersionCache = null;
      const after = await resolveTarget();
      if (after.bin !== target.bin || after.provenance !== target.provenance) throw new Error('Codex update changed executable ownership');
      return collectCodexState(true);
    }
    const latest = await latestCodexVersion(true, target);
    if (!latest) throw new Error('Could not resolve the latest Codex CLI version');
    const runAsRoot = target.bin === '/usr/bin/codex' || target.bin === '/usr/local/bin/codex';
    const installTarget = runAsRoot ? { ...target, user: 'root', home: '/root', codexHome: '/root/.codex' } : target;
    const siblingNpm = join(dirname(target.bin), 'npm');
    const npmBin = await executableByUser(installTarget.user, siblingNpm)
      ? siblingNpm
      : await exists('/usr/bin/npm') ? '/usr/bin/npm' : '/usr/local/bin/npm';
    const npmPrefix = codexNpmInstallPrefix(target.bin);
    if (!npmPrefix) {
      throw new Error(`Codex update is not supported for installation path ${target.bin}`);
    }
    const npmCache = join(tmpdir(), `magnus-codex-npm-cache-${installTarget.user}`);
    // magnus-agent runs with UMask=0077. npm's global package must remain
    // executable by the unprivileged Codex account, so set a bounded standard
    // install umask only for this child process.
    const result = await runForTarget(
      installTarget,
      '/bin/sh',
      [
        '-c', 'umask 022; PATH="$1:$PATH"; export PATH; shift; exec "$@"',
        'magnus-codex-update', dirname(target.bin), npmBin,
        'install', '--global', '--prefix', npmPrefix, `${CODEX_PACKAGE}@${latest}`, '--cache', npmCache,
      ],
      10 * 60_000,
    );
    if (result.code !== 0) throw new Error(`Codex update failed: ${safeMessage(result.stderr || result.stdout)}`);
    const after = await resolveTarget();
    if (after.bin !== target.bin || after.provenance !== target.provenance) throw new Error('Codex update changed executable ownership');
    latestVersionCache = { value: latest, at: Date.now() };
    return collectCodexState();
  })().finally(() => { updateInFlight = null; });
  return updateInFlight;
}

export async function logoutCodex(): Promise<CodexNodeState> {
  const target = await resolveTarget();
  if (!target.bin) throw new Error('Codex CLI is not installed');
  const existingId = activeSessionByUser.get(target.user);
  if (existingId) await cancelDeviceAuth(existingId);
  await logoutWithRpc(target);
  return collectCodexState();
}

function finishDeviceSession(managed: ManagedDeviceSession, status: CodexDeviceAuthSession['status'], error: string | null): void {
  if (managed.public.status !== 'pending') return;
  clearTimeout(managed.timeout);
  managed.public.status = status;
  managed.public.completedAt = new Date().toISOString();
  managed.public.error = error;
  if (activeSessionByUser.get(managed.user) === managed.public.id) activeSessionByUser.delete(managed.user);
  managed.rpc.close();
  // Keep the terminal status pollable for a while, then forget it.
  setTimeout(() => deviceSessions.delete(managed.public.id), FINISHED_DEVICE_SESSION_RETENTION_MS).unref();
}

export async function startDeviceAuth(): Promise<CodexDeviceAuthSession> {
  const target = await resolveTarget();
  if (!target.bin) throw new Error('Codex CLI is not installed');
  const existingId = activeSessionByUser.get(target.user);
  if (existingId) {
    const existing = deviceSessions.get(existingId);
    if (existing?.public.status === 'pending') return { ...existing.public };
  }

  const rpc = await openRpc(target);
  const result = await rpc.request('account/login/start', { type: 'chatgptDeviceCode' }) as Record<string, unknown>;
  const loginId = typeof result?.['loginId'] === 'string' ? result['loginId'] : '';
  const verificationUrl = typeof result?.['verificationUrl'] === 'string' ? result['verificationUrl'] : '';
  const userCode = typeof result?.['userCode'] === 'string' ? result['userCode'] : '';
  if (!loginId || !verificationUrl || !userCode) {
    rpc.close();
    throw new Error('Codex did not return a complete device authorization request');
  }

  const id = randomUUID();
  const now = Date.now();
  const publicSession: CodexDeviceAuthSession = {
    id, status: 'pending', verificationUrl, userCode,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + DEVICE_LOGIN_TTL_MS).toISOString(),
    completedAt: null, error: null,
  };
  const managed = { public: publicSession, user: target.user, loginId, rpc, timeout: setTimeout(() => {}, DEVICE_LOGIN_TTL_MS) };
  clearTimeout(managed.timeout);
  managed.timeout = setTimeout(() => {
    void rpc.request('account/login/cancel', { loginId }, 5000).catch(() => {});
    finishDeviceSession(managed, 'expired', 'Device code expired before authorization completed.');
  }, DEVICE_LOGIN_TTL_MS);
  rpc.onNotification((message) => {
    if (message.method !== 'account/login/completed' || !message.params || typeof message.params !== 'object') return;
    const params = message.params as Record<string, unknown>;
    if (params['loginId'] !== loginId) return;
    const success = params['success'] === true;
    finishDeviceSession(managed, success ? 'completed' : 'failed', success ? null : safeMessage(params['error'] ?? 'Device login failed'));
  });
  rpc.onExit(() => finishDeviceSession(managed, 'failed', 'Codex app-server exited before authorization completed.'));
  deviceSessions.set(id, managed);
  activeSessionByUser.set(target.user, id);
  return { ...publicSession };
}

export function getDeviceAuth(id: string): CodexDeviceAuthSession | null {
  const session = deviceSessions.get(id);
  return session ? { ...session.public } : null;
}

export async function cancelDeviceAuth(id: string): Promise<CodexDeviceAuthSession | null> {
  const managed = deviceSessions.get(id);
  if (!managed) return null;
  if (managed.public.status === 'pending') {
    await managed.rpc.request('account/login/cancel', { loginId: managed.loginId }, 5000).catch(() => {});
    finishDeviceSession(managed, 'cancelled', 'Device login was cancelled.');
  }
  return { ...managed.public };
}

export const codexRoutes = new Hono();

function errorResponse(c: Context, error: unknown): Response {
  return c.json({ success: false, error: { code: 'CODEX_OPERATION_FAILED', message: safeMessage(error) } }, 500);
}

codexRoutes.get('/state', async (c) => {
  try { return c.json({ success: true, data: await collectCodexState(c.req.query('refreshLatest') === 'true') }); }
  catch (error) { return errorResponse(c, error); }
});

codexRoutes.post('/update', async (c) => {
  try { return c.json({ success: true, data: await updateCodex() }); }
  catch (error) { return errorResponse(c, error); }
});

codexRoutes.post('/logout', async (c) => {
  try { return c.json({ success: true, data: await logoutCodex() }); }
  catch (error) { return errorResponse(c, error); }
});

codexRoutes.post('/device-auth', async (c) => {
  try { return c.json({ success: true, data: await startDeviceAuth() }); }
  catch (error) { return errorResponse(c, error); }
});

codexRoutes.get('/device-auth/:id', (c) => {
  const session = getDeviceAuth(c.req.param('id'));
  return session
    ? c.json({ success: true, data: session })
    : c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Device login session not found' } }, 404);
});

codexRoutes.post('/device-auth/:id/cancel', async (c) => {
  const session = await cancelDeviceAuth(c.req.param('id'));
  return session
    ? c.json({ success: true, data: session })
    : c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Device login session not found' } }, 404);
});
