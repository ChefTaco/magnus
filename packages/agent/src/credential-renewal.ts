import { createHmac, createPublicKey, randomUUID, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, chown, lstat, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { logger } from './utils/logger.js';
import type { ServiceInfo } from './types/index.js';

const exec = promisify(execFile);
const TOKEN_WINDOW_MS = 14 * 86400_000;
const CERT_WINDOW_MS = 21 * 86400_000;
const DAY_MS = 86400_000;
const INSTALL_DIR = resolve(process.env['AGENT_INSTALL_DIR'] ?? '/opt/magnus-agent');
const CONFIG_PATH = resolve(process.env['MAGNUS_AGENT_RENEWAL_CONFIG'] ?? join(INSTALL_DIR, 'credential-renewal.json'));
const ALLOWED_KEYS = new Set(['HERMES_HIVEMEM_TOKEN', 'ARDENT_HIVEMEM_TOKEN', 'HIVEMEM_TOKEN', 'HIVEMEM_ADMIN_TOKEN', 'HIVE_ROUTER_MEMORY_PROXY_TOKEN']);

/**
 * Operator allowlists. Every list is empty by default, so renewal cannot touch
 * an endpoint, unit, or credential file the node operator did not name.
 */
function envList(name: string): Set<string> {
  return new Set((process.env[name] ?? '').split(',').map(value => value.trim()).filter(Boolean));
}
function absolutePaths(name: string): Set<string> {
  return new Set([...envList(name)].filter(path => path.startsWith('/') && resolve(path) === path));
}
const allowedEndpoints = (): Set<string> => new Set([...envList('MAGNUS_AGENT_RENEWAL_ENDPOINTS')].filter(url => url.startsWith('https://')));
const allowedUnits = (): Set<string> => new Set([...envList('MAGNUS_AGENT_RENEWAL_UNITS')].filter(unit => /^[A-Za-z0-9@._-]+\.service$/.test(unit)));
const serviceTokenFiles = (): Set<string> => absolutePaths('MAGNUS_AGENT_RENEWAL_TOKEN_FILES');
const signingEnvFiles = (): Set<string> => absolutePaths('MAGNUS_AGENT_RENEWAL_SIGNING_ENV_FILES');
const allowedProfiles = (): Set<string> => new Set([...envList('MAGNUS_AGENT_RENEWAL_ARDENT_PROFILES')].filter(profile => /^[a-z0-9_-]+$/.test(profile)));
const allowedUsers = (): Set<string> => new Set([...envList('MAGNUS_AGENT_RENEWAL_USERS')].filter(user => /^[a-z_][a-z0-9_-]*$/.test(user)));

/** Per-user Hermes or Ardent profile env files, limited to the configured users and profiles. */
function userTokenFile(path: string): boolean {
  const match = /^\/home\/([a-z_][a-z0-9_-]*)\/(?:\.hermes\/\.env|\.ardent\/profiles\/([a-z0-9_-]+)\/\.env)$/.exec(path);
  if (!match || !allowedUsers().has(match[1]!)) return false;
  return match[2] === undefined || allowedProfiles().has(match[2]);
}

type Restart = { unit: string; user?: string };
type GrantEntry = { kind: 'grant'; name: string; apiUrl: string; grantPath: string; tokenPath: string; tokenKey?: string; restart?: Restart };
type AdminEntry = { kind: 'local-admin'; name: string; apiUrl: string; signingEnvPath: string; tokenPaths: Array<{ path: string; key: string }>; restart?: Restart };
type Entry = GrantEntry | AdminEntry;
type Config = { entries: Entry[] };

async function readConfig(): Promise<Config | null> {
  const stat = await lstat(CONFIG_PATH).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return null;
  const installDir = await lstat(INSTALL_DIR);
  if (!stat.isFile() || stat.isSymbolicLink() || !installDir.isDirectory() ||
    (stat.uid !== 0 && stat.uid !== installDir.uid) ||
    (stat.mode & 0o077) !== 0 || stat.size > 64 * 1024) throw new Error('Unsafe renewal config');
  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as Config;
  if (!Array.isArray(config.entries) || config.entries.length > 20) throw new Error('Invalid renewal config');
  return config;
}

function jwtClaims(token: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error('Malformed JWT');
  const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as unknown;
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new Error('Malformed JWT claims');
  return claims as Record<string, unknown>;
}

function expiry(token: string): number {
  const exp = jwtClaims(token).exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) throw new Error('JWT has no expiry');
  return exp * 1000;
}

function envValue(contents: string, key: string, useLast = false): string {
  const matches = contents.split(/\r?\n/).filter((line) => line.startsWith(`${key}=`));
  if (matches.length < 1 || (!useLast && matches.length !== 1)) throw new Error(`Expected one ${key} entry`);
  return matches[matches.length - 1]!.slice(key.length + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
}

async function readToken(path: string, key?: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Unsafe credential file');
  const contents = await readFile(path, 'utf8');
  return key ? envValue(contents, key) : contents.trim();
}

async function replaceToken(path: string, key: string | undefined, token: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error('Invalid replacement token');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Unsafe credential file');
  const current = await readFile(path, 'utf8');
  let next: string;
  if (key) {
    if (!ALLOWED_KEYS.has(key)) throw new Error('Unsupported credential key');
    const matches = current.split(/\r?\n/).filter((line) => line.startsWith(`${key}=`));
    if (matches.length !== 1) throw new Error(`Expected one ${key} entry`);
    next = current.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${token}`);
  } else {
    next = `${token}\n`;
  }
  const temporary = join(dirname(path), `.${randomUUID()}.renew`);
  try {
    await writeFile(temporary, next, { mode: stat.mode & 0o777, flag: 'wx' });
    await chmod(temporary, stat.mode & 0o777);
    await chown(temporary, stat.uid, stat.gid);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function accepted(apiUrl: string, token: string): Promise<boolean> {
  const url = new URL(`${apiUrl}/v1/auth/me`);
  if (url.protocol !== 'https:') throw new Error('HiveMem renewal requires HTTPS');
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
  return response.ok;
}

export async function restartCredentialConsumer(spec?: Restart): Promise<void> {
  if (!spec) return;
  if (!allowedUnits().has(spec.unit)) throw new Error('Unsupported restart unit');
  if (spec.user) {
    if (!/^[a-z_][a-z0-9_-]*$/.test(spec.user)) throw new Error('Invalid service user');
    const { stdout } = await exec('/usr/bin/id', ['-u', spec.user], { timeout: 5000 });
    await exec('/usr/sbin/runuser', ['-u', spec.user, '--', '/usr/bin/env', `XDG_RUNTIME_DIR=/run/user/${stdout.trim()}`, '/usr/bin/systemctl', '--user', 'try-restart', spec.unit], { timeout: 30_000 });
  } else {
    // Atomic systemd operation: renewing a credential must never activate a
    // stopped consumer or transfer ownership back to a retired gateway.
    await exec('/usr/bin/systemctl', ['try-restart', spec.unit], { timeout: 30_000 });
  }
}

async function renewGrant(entry: GrantEntry): Promise<void> {
  if (!allowedEndpoints().has(entry.apiUrl)) throw new Error('Unsupported HiveMem endpoint');
  if (!userTokenFile(entry.tokenPath) && !serviceTokenFiles().has(entry.tokenPath)) throw new Error('Unsupported credential path');
  const grantsDir = join(INSTALL_DIR, 'grants');
  if (dirname(entry.grantPath) !== grantsDir || !/^[a-z0-9_-]+\.jwt$/.test(entry.grantPath.slice(grantsDir.length + 1))
    || resolve(entry.grantPath) !== entry.grantPath) throw new Error('Unsupported grant path');
  const oldToken = await readToken(entry.tokenPath, entry.tokenKey);
  if (expiry(oldToken) - Date.now() > TOKEN_WINDOW_MS) return;
  const grantStat = await lstat(entry.grantPath);
  if ((grantStat.mode & 0o077) !== 0) throw new Error('Unsafe grant permissions');
  const grant = await readToken(entry.grantPath);
  if (expiry(grant) <= Date.now()) throw new Error('Renewal grant expired');
  const url = new URL(`${entry.apiUrl}/v1/auth/renew`);
  if (url.protocol !== 'https:') throw new Error('HiveMem renewal requires HTTPS');
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${grant}` }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`HiveMem renewal rejected: HTTP ${response.status}`);
  const body = await response.json() as { token?: unknown };
  if (typeof body.token !== 'string' || !await accepted(entry.apiUrl, body.token)) throw new Error('Renewed token was not accepted');
  const previous = jwtClaims(oldToken);
  const next = jwtClaims(body.token);
  if (previous.sub !== next.sub) throw new Error('Renewal changed principal');
  const oldScopes = String(previous.scope ?? (Array.isArray(previous.scopes) ? previous.scopes.join(' ') : '')).split(/\s+/).filter(Boolean).sort();
  const newScopes = String(next.scope ?? '').split(/\s+/).filter(Boolean).sort();
  // Legacy Hermes credentials can carry wildcard scope. Their renewal grant
  // intentionally narrows them to the explicit supported agent scopes.
  if (oldScopes.length > 0 && !(oldScopes.length === 1 && oldScopes[0] === '*') && JSON.stringify(oldScopes) !== JSON.stringify(newScopes)) throw new Error('Renewal changed scopes');
  if (previous.role !== undefined && previous.role !== next.role) throw new Error('Renewal changed role');
  if (JSON.stringify(previous.workspace_ids ?? null) !== JSON.stringify(next.workspace_ids ?? null)) throw new Error('Renewal changed workspaces');
  await replaceToken(entry.tokenPath, entry.tokenKey, body.token);
  try {
    await restartCredentialConsumer(entry.restart);
  } catch (error) {
    await replaceToken(entry.tokenPath, entry.tokenKey, oldToken);
    await restartCredentialConsumer(entry.restart).catch(() => undefined);
    throw error;
  }
  logger.info('HiveMem credential renewed', { name: entry.name, expiresAt: new Date(expiry(body.token)).toISOString() });
}

function signAdmin(secret: string, subject: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: 'hivemem', aud: 'hivemem-api', token_type: 'access', jti: randomUUID(), sub: subject, role: 'admin', scope: 'admin:all', iat: now, exp: now + 30 * 86400 })).toString('base64url');
  return `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
}

async function renewAdmin(entry: AdminEntry): Promise<void> {
  if (!allowedEndpoints().has(entry.apiUrl) || !signingEnvFiles().has(entry.signingEnvPath)) throw new Error('Unsupported local admin source');
  if (entry.tokenPaths.length < 1 || entry.tokenPaths.length > 3) throw new Error('Invalid admin token inventory');
  if (entry.tokenPaths.some(({ path, key }) => !serviceTokenFiles().has(path) || !ALLOWED_KEYS.has(key))) throw new Error('Unsupported admin credential path');
  const current = await Promise.all(entry.tokenPaths.map(({ path, key }) => readToken(path, key)));
  if (current.some((token) => jwtClaims(token).role !== 'admin' || jwtClaims(token).scope !== 'admin:all')) throw new Error('Local admin source has unexpected claims');
  if (current.every((token) => expiry(token) - Date.now() > TOKEN_WINDOW_MS)) return;
  // Existing Hive installs can carry an older duplicate key. systemd's
  // EnvironmentFile and the token refresh helper use the final assignment.
  const secret = envValue(await readFile(entry.signingEnvPath, 'utf8'), 'HIVEMEM_JWT_SECRET', true);
  if (Buffer.byteLength(secret) < 32) throw new Error('Invalid HiveMem signing key');
  const replacements = current.map((token) => {
    const subject = jwtClaims(token).sub;
    if (typeof subject !== 'string' || !subject) throw new Error('Local admin source has no subject');
    return signAdmin(secret, subject);
  });
  for (let i = 0; i < replacements.length; i++) {
    if (!await accepted(entry.apiUrl, replacements[i]!)) throw new Error('New admin token was not accepted');
  }
  let installed = 0;
  try {
    for (let i = 0; i < replacements.length; i++) {
      await replaceToken(entry.tokenPaths[i]!.path, entry.tokenPaths[i]!.key, replacements[i]!);
      installed++;
    }
    await restartCredentialConsumer(entry.restart);
  } catch (error) {
    for (let i = 0; i < installed; i++) await replaceToken(entry.tokenPaths[i]!.path, entry.tokenPaths[i]!.key, current[i]!);
    await restartCredentialConsumer(entry.restart).catch(() => undefined);
    throw error;
  }
  logger.info('HiveMem local admin credentials renewed', { name: entry.name, expiresAt: new Date(expiry(replacements[0]!)).toISOString() });
}

async function renewCertificate(reloadTls: (cert: Buffer, key: Buffer) => void): Promise<void> {
  const certPath = process.env['TLS_CERT_PATH'];
  const keyPath = process.env['TLS_KEY_PATH'];
  const hostname = process.env['HOST_FQDN'];
  // Opt-in: renew a Tailscale-issued listener certificate with `tailscale cert`.
  if (process.env['MAGNUS_AGENT_TLS_RENEWAL'] !== 'tailscale' || !certPath || !keyPath || !hostname) return;
  const certStat = await lstat(certPath);
  const keyStat = await lstat(keyPath);
  if (!certStat.isFile() || certStat.isSymbolicLink() || !keyStat.isFile() || keyStat.isSymbolicLink()) throw new Error('Unsafe TLS files');
  const oldCert = await readFile(certPath);
  const oldKey = await readFile(keyPath);
  const current = new X509Certificate(oldCert);
  if (Date.parse(current.validTo) - Date.now() > CERT_WINDOW_MS) return;
  const temporary = await mkdtemp(join(tmpdir(), 'magnus-cert-'));
  try {
    const nextCertPath = join(temporary, 'cert');
    const nextKeyPath = join(temporary, 'key');
    await exec('/usr/bin/tailscale', ['cert', '--cert-file', nextCertPath, '--key-file', nextKeyPath, hostname], { timeout: 90_000 });
    const cert = await readFile(nextCertPath);
    const key = await readFile(nextKeyPath);
    const parsed = new X509Certificate(cert);
    if (!parsed.checkHost(hostname) || Date.parse(parsed.validTo) <= Date.now() + CERT_WINDOW_MS) throw new Error('Renewed certificate failed validation');
    if (parsed.publicKey.export({ type: 'spki', format: 'der' }).toString('hex') !== createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('hex')) throw new Error('Renewed TLS key mismatch');
    const suffix = randomUUID();
    const nextCert = `${certPath}.${suffix}.renew`;
    const nextKey = `${keyPath}.${suffix}.renew`;
    const install = async (path: string, contents: Buffer, stat: typeof certStat): Promise<void> => {
      const temporaryPath = `${path}.${randomUUID()}.renew`;
      try {
        await writeFile(temporaryPath, contents, { mode: stat.mode & 0o777, flag: 'wx' });
        await chmod(temporaryPath, stat.mode & 0o777);
        await chown(temporaryPath, stat.uid, stat.gid);
        await rename(temporaryPath, path);
      } finally { await rm(temporaryPath, { force: true }); }
    };
    try {
      await writeFile(nextCert, cert, { mode: certStat.mode & 0o777, flag: 'wx' });
      await writeFile(nextKey, key, { mode: keyStat.mode & 0o777, flag: 'wx' });
      await Promise.all([chmod(nextCert, certStat.mode & 0o777), chmod(nextKey, keyStat.mode & 0o777)]);
      await Promise.all([chown(nextCert, certStat.uid, certStat.gid), chown(nextKey, keyStat.uid, keyStat.gid)]);
      await rename(nextKey, keyPath);
      await rename(nextCert, certPath);
      reloadTls(cert, key);
    } catch (error) {
      await install(keyPath, oldKey, keyStat);
      await install(certPath, oldCert, certStat);
      reloadTls(oldCert, oldKey);
      throw error;
    } finally {
      await Promise.all([rm(nextCert, { force: true }), rm(nextKey, { force: true })]);
    }
    logger.info('Magnus agent Tailscale certificate renewed', { hostname, expiresAt: parsed.validTo });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
export function startCredentialRenewal(reloadTls: (cert: Buffer, key: Buffer) => void): void {
  const run = async (): Promise<void> => {
    try { await renewCertificate(reloadTls); } catch (error) { logger.warn('Certificate renewal failed', { error: error instanceof Error ? error.message : String(error) }); }
    try {
      const config = await readConfig();
      if (config) {
        for (const entry of config.entries) {
          try {
            if (entry.kind === 'grant') await renewGrant(entry);
            else if (entry.kind === 'local-admin') await renewAdmin(entry);
            else throw new Error('Unsupported renewal entry');
          } catch (error) { logger.warn('HiveMem renewal failed', { name: entry.name, error: error instanceof Error ? error.message : String(error) }); }
        }
      }
    } catch (error) { logger.warn('Credential renewal configuration failed', { error: error instanceof Error ? error.message : String(error) }); }
    timer = setTimeout(() => { void run(); }, DAY_MS);
    timer.unref();
  };
  void run();
}

export function stopCredentialRenewal(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

export async function collectCredentialRenewalPosture(): Promise<ServiceInfo[]> {
  let config: Config;
  try { config = await readConfig() as Config; }
  catch { return []; }
  if (!config) return [];
  return Promise.all(config.entries.map(async (entry): Promise<ServiceInfo> => {
    const details: Record<string, unknown> = { name: entry.name, apiUrl: entry.apiUrl };
    let status: ServiceInfo['status'] = 'unknown';
    try {
      const tokens = entry.kind === 'grant'
        ? [await readToken(entry.tokenPath, entry.tokenKey)]
        : await Promise.all(entry.tokenPaths.map(({ path, key }) => readToken(path, key)));
      const earliest = Math.min(...tokens.map(expiry));
      details.expiresAt = new Date(earliest).toISOString();
      status = earliest <= Date.now() ? 'failed' : earliest - Date.now() <= TOKEN_WINDOW_MS ? 'inactive' : 'active';
      if (entry.kind === 'grant') {
        const grantExpiry = expiry((await readFile(entry.grantPath, 'utf8')).trim());
        details.renewalGrantExpiresAt = new Date(grantExpiry).toISOString();
        if (grantExpiry <= Date.now()) status = 'failed';
        else if (grantExpiry - Date.now() <= 30 * DAY_MS && status === 'active') status = 'inactive';
      }
    } catch {
      details.reason = 'credential_or_grant_unreadable';
      status = 'failed';
    }
    return { name: `hivemem-token:${entry.name}`, status, pid: null, memoryBytes: null, cpuPercent: null, details: JSON.stringify(details) };
  }));
}
