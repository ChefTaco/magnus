/**
 * The control plane's own Ed25519 signing key: it signs every request to an agent and every decision
 * the server makes for a node, and its key id is the audience agents sign their requests for. Kept in
 * `$MAGNUS_HOME/state/node-auth/` (0600), created on first use.
 *
 * Rotation (docs/NODE_CREDENTIALS.md, "Rotating the server key") moves a key through four places in
 * the same file:
 *
 *   next      staged: agents pin it next to the active key, the server answers to its audience, but
 *             does not sign with it yet
 *   active    the key the server signs with
 *   previous  the key a promotion replaced: no longer signs, but agents may still sign requests for
 *             its audience until `retireAfter`
 *   retired   public keys only (the private key is destroyed): never pinned and never an audience,
 *             kept so that decisions the server signed with them still verify
 *
 * The file keeps `version: 1`, and a server older than rotation reads `active` and `next` from it and
 * ignores the rest, so a rollback keeps working.
 */
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { KeyObject } from 'node:crypto';
import path from 'node:path';
import { magnusHomePath } from '../utils/magnus-home.js';
import { generateSigningKey, keyFingerprint, keyIdOfSpki, privateKeyFromPem, serverAudience, spkiOf } from '../security/node-request-auth.js';

interface StoredKey { keyId: string; publicKey: string; privateKeyPem: string; createdAt: string }
interface StoredPrevious extends StoredKey { promotedAt: string; retireAfter: string }
interface StoredRetired { keyId: string; publicKey: string; createdAt: string; retiredAt: string }
interface StoredKeys { version: 1; active: StoredKey; next?: StoredKey; previous?: StoredPrevious; retired?: StoredRetired[] }

export interface ServerSigningKey { keyId: string; publicKey: string; privateKey: KeyObject }
export interface ServerPublicKey { keyId: string; publicKey: string; status: 'active' | 'next' | 'previous' }
export interface ServerVerificationKey { keyId: string; publicKey: string; status: 'active' | 'next' | 'previous' | 'retired' }

/** How long agents may keep signing for a replaced key's audience by default. */
export const SERVER_KEY_DEFAULT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const SERVER_KEY_MIN_GRACE_MS = 60 * 60 * 1000;
export const SERVER_KEY_MAX_GRACE_MS = 90 * 24 * 60 * 60 * 1000;
/** Retired public keys kept for verification; the oldest go first. */
const MAX_RETIRED = 32;
/** How often a running server checks whether another process (the command line) changed the file. */
const RELOAD_CHECK_MS = 1000;

interface Loaded {
  path: string;
  stamp: string;
  checkedAt: number;
  stored: StoredKeys | null;
  active: ServerSigningKey;
  next: ServerSigningKey | null;
  previous: (ServerSigningKey & { promotedAt: string; retireAfter: string; createdAt: string }) | null;
  retired: StoredRetired[];
}

let cached: Loaded | null = null;
let mayCreate = false;

/** A refusal of a rotation step, with a stable code for the API. */
export class ServerKeyRotationError extends Error {
  constructor(readonly code: 'SERVER_KEY_NEXT_EXISTS' | 'SERVER_KEY_NO_NEXT' | 'SERVER_KEY_PREVIOUS_PENDING' | 'SERVER_KEY_NO_PREVIOUS'
    | 'SERVER_KEY_GRACE_PENDING' | 'SERVER_KEY_EPHEMERAL', message: string) { super(message); }
}

/**
 * Let this process create the key file when there is none. Only the server does this, at start-up:
 * a `magnus-server` command-line process (for example `agents upgrade`) must sign with the key the
 * server already has, so with no file at its path it fails clearly instead of minting a second key
 * that no agent pins.
 */
export function allowServerKeyCreation(): void {
  mayCreate = true;
}

export function serverSigningKeyPath(env: NodeJS.ProcessEnv = process.env): string {
  return env['NODE_AUTH_SERVER_KEY_PATH']?.trim() || magnusHomePath('state', 'node-auth', 'server-signing-key.json');
}

function parseKey(stored: StoredKey | undefined): ServerSigningKey | null {
  if (!stored) return null;
  const privateKey = privateKeyFromPem(stored.privateKeyPem);
  const publicKey = spkiOf(privateKey);
  // The file is trusted for the private key only; ids are always derived from it.
  return { keyId: keyIdOfSpki(publicKey), publicKey, privateKey };
}

function parseRetired(list: unknown): StoredRetired[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: Partial<StoredRetired>) => {
    try {
      if (typeof entry?.publicKey !== 'string') return [];
      return [{ keyId: keyIdOfSpki(entry.publicKey), publicKey: entry.publicKey, createdAt: String(entry.createdAt ?? ''), retiredAt: String(entry.retiredAt ?? '') }];
    } catch { return []; }
  });
}

function stampOf(file: string): string {
  try { const stat = statSync(file); return `${stat.mtimeMs}:${stat.size}:${stat.ino}`; }
  catch { return '-'; }
}

function read(file: string): Omit<Loaded, 'path' | 'checkedAt'> {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0)
    throw new Error('The node-auth server key must be a regular file readable only by its owner (mode 0600)');
  const stamp = stampOf(file);
  const stored = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoredKeys>;
  const active = stored.version === 1 ? parseKey(stored.active) : null;
  if (!active) throw new Error('The node-auth server key file is not readable; restore it or remove it to issue a new key');
  const previousKey = parseKey(stored.previous);
  const previous = previousKey && stored.previous
    ? { ...previousKey, promotedAt: String(stored.previous.promotedAt ?? ''), retireAfter: String(stored.previous.retireAfter ?? ''),
      createdAt: String(stored.previous.createdAt ?? '') }
    : null;
  return { stamp, stored: stored as StoredKeys, active, next: parseKey(stored.next), previous, retired: parseRetired(stored.retired) };
}

/** Write a new file (it must not exist), readable by its owner only, and flush it. */
function writePrivate(file: string, content: string): void {
  const descriptor = openSync(file, 'wx', 0o600);
  try {
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
}

function create(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const key = generateSigningKey();
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const stored: StoredKeys = { version: 1, active: { ...key, createdAt: new Date().toISOString() } };
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(stored)}\n`);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  try {
    // A hard link fails when the file exists, so two processes starting together keep one key.
    linkSync(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally { rmSync(temporary, { force: true }); }
}

/** Replace the file in one rename, so a reader never sees half a key file. */
function replace(file: string, stored: StoredKeys): void {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writePrivate(temporary, `${JSON.stringify(stored)}\n`);
  try { renameSync(temporary, file); }
  catch (error) { rmSync(temporary, { force: true }); throw error; }
  cached = null;
}

function ephemeral(): boolean {
  // Test runs get a throwaway key unless they name a file: a test must never write into a real MAGNUS_HOME.
  return !process.env['NODE_AUTH_SERVER_KEY_PATH'] && Boolean(process.env['VITEST'] || process.env['NODE_ENV'] === 'test');
}

function load(now = Date.now()): Loaded {
  const file = serverSigningKeyPath();
  if (cached?.path === file && (cached.stored === null || now - cached.checkedAt < RELOAD_CHECK_MS)) return cached;
  if (cached?.path === file && cached.stored !== null) {
    // Another process (`magnus-server node-auth server-key ...`) may have rotated the key.
    if (stampOf(file) === cached.stamp) { cached.checkedAt = now; return cached; }
  }
  if (ephemeral()) {
    const key = generateSigningKey();
    cached = { path: file, stamp: '-', checkedAt: now, stored: null,
      active: { keyId: key.keyId, publicKey: key.publicKey, privateKey: privateKeyFromPem(key.privateKeyPem) }, next: null, previous: null, retired: [] };
    return cached;
  }
  if (!existsSync(file)) {
    if (!mayCreate) throw new Error(`No server signing key at ${file}; run this command with the server's environment `
      + '(--env-file, or the same MAGNUS_HOME / NODE_AUTH_SERVER_KEY_PATH as the server) so it signs with the key agents pin');
    create(file);
  }
  cached = { path: file, checkedAt: now, ...read(file) };
  return cached;
}

/** The key this server signs agent requests and node decisions with. Never log or return its `privateKey`. */
export function serverSigningKey(): ServerSigningKey {
  return load().active;
}

function previousInGrace(loaded: Loaded, now: number): boolean {
  return loaded.previous !== null && Date.parse(loaded.previous.retireAfter) > now;
}

/**
 * Public keys agents pin: the active one, during a rotation the staged next one, and after a
 * promotion the replaced one until its grace ends (agents signed for it a moment ago).
 */
export function serverPublicKeys(now = Date.now()): ServerPublicKey[] {
  const loaded = load(now);
  return [{ keyId: loaded.active.keyId, publicKey: loaded.active.publicKey, status: 'active' as const },
    ...(loaded.next ? [{ keyId: loaded.next.keyId, publicKey: loaded.next.publicKey, status: 'next' as const }] : []),
    ...(loaded.previous && previousInGrace(loaded, now) ? [{ keyId: loaded.previous.keyId, publicKey: loaded.previous.publicKey, status: 'previous' as const }] : [])];
}

/**
 * Every key a decision this server signed may name: the pinned ones and the retired ones. Only for
 * verifying stored decisions; a retired key is never an audience and is never pinned.
 */
export function serverVerificationKeys(): ServerVerificationKey[] {
  const loaded = load();
  return [{ keyId: loaded.active.keyId, publicKey: loaded.active.publicKey, status: 'active' as const },
    ...(loaded.next ? [{ keyId: loaded.next.keyId, publicKey: loaded.next.publicKey, status: 'next' as const }] : []),
    ...(loaded.previous ? [{ keyId: loaded.previous.keyId, publicKey: loaded.previous.publicKey, status: 'previous' as const }] : []),
    ...loaded.retired.map(entry => ({ keyId: entry.keyId, publicKey: entry.publicKey, status: 'retired' as const }))];
}

/** Every audience an agent may have signed for. */
export function serverAudiences(now = Date.now()): string[] {
  return serverPublicKeys(now).map(key => serverAudience(key.keyId));
}

export interface ServerKeyView { keyId: string; keyFingerprint: string; createdAt: string | null }
export interface ServerKeyRotationState {
  active: ServerKeyView;
  next: ServerKeyView | null;
  previous: (ServerKeyView & { promotedAt: string; retireAfter: string; inGrace: boolean }) | null;
  retired: Array<ServerKeyView & { retiredAt: string }>;
}

function view(key: { keyId: string }, createdAt: string | undefined): ServerKeyView {
  return { keyId: key.keyId, keyFingerprint: keyFingerprint(key.keyId), createdAt: createdAt || null };
}

/** Where the server key is in its rotation. Key ids and fingerprints only. */
export function serverKeyRotationState(now = Date.now()): ServerKeyRotationState {
  const loaded = load(now);
  return {
    active: view(loaded.active, loaded.stored?.active.createdAt),
    next: loaded.next ? view(loaded.next, loaded.stored?.next?.createdAt) : null,
    previous: loaded.previous ? { ...view(loaded.previous, loaded.previous.createdAt), promotedAt: loaded.previous.promotedAt,
      retireAfter: loaded.previous.retireAfter, inGrace: previousInGrace(loaded, now) } : null,
    retired: loaded.retired.map(entry => ({ ...view(entry, entry.createdAt), retiredAt: entry.retiredAt })),
  };
}

function editable(now: number): { file: string; stored: StoredKeys } {
  const file = serverSigningKeyPath();
  const loaded = load(now);
  if (!loaded.stored) throw new ServerKeyRotationError('SERVER_KEY_EPHEMERAL', 'This process has no server key file to rotate (NODE_AUTH_SERVER_KEY_PATH)');
  // Re-read, so two processes do not each write from a stale copy.
  const current = JSON.parse(readFileSync(file, 'utf8')) as StoredKeys;
  return { file, stored: current };
}

/** Stage a new key as `next`. Agents pin it from their next heartbeat on; nothing signs with it yet. */
export function stageNextServerKey(now = Date.now()): ServerKeyRotationState {
  const { file, stored } = editable(now);
  if (stored.next) throw new ServerKeyRotationError('SERVER_KEY_NEXT_EXISTS', 'A next key is already staged; promote it first');
  const key = generateSigningKey();
  replace(file, { ...stored, next: { ...key, createdAt: new Date(now).toISOString() } });
  return serverKeyRotationState(now);
}

/**
 * Make the staged key the one the server signs with. The replaced key becomes `previous`: agents may
 * keep signing requests for its audience until `graceMs` has passed. Refused while an earlier
 * promotion's key has not been retired.
 */
export function promoteNextServerKey(options: { graceMs?: number } = {}, now = Date.now()): ServerKeyRotationState {
  const { file, stored } = editable(now);
  if (!stored.next) throw new ServerKeyRotationError('SERVER_KEY_NO_NEXT', 'No next key is staged; stage one first');
  if (stored.previous) throw new ServerKeyRotationError('SERVER_KEY_PREVIOUS_PENDING', 'The key an earlier promotion replaced is not retired yet; retire it first');
  const grace = Math.min(Math.max(options.graceMs ?? SERVER_KEY_DEFAULT_GRACE_MS, SERVER_KEY_MIN_GRACE_MS), SERVER_KEY_MAX_GRACE_MS);
  const { next, ...rest } = stored;
  replace(file, { ...rest, active: next, previous: { ...stored.active, promotedAt: new Date(now).toISOString(), retireAfter: new Date(now + grace).toISOString() } });
  return serverKeyRotationState(now);
}

/**
 * Destroy the replaced key's private part. Its public key stays, so decisions it signed still verify,
 * but it is no longer pinned or accepted as an audience. Refused inside the grace period unless `force`.
 */
export function retirePreviousServerKey(options: { force?: boolean } = {}, now = Date.now()): ServerKeyRotationState {
  const { file, stored } = editable(now);
  if (!stored.previous) throw new ServerKeyRotationError('SERVER_KEY_NO_PREVIOUS', 'There is no replaced key to retire');
  if (!options.force && Date.parse(stored.previous.retireAfter) > now)
    throw new ServerKeyRotationError('SERVER_KEY_GRACE_PENDING', `The replaced key's grace period ends at ${stored.previous.retireAfter}; retire it then, or force it`);
  const { previous, ...rest } = stored;
  const publicKey = spkiOf(privateKeyFromPem(previous.privateKeyPem));
  const retired = [...(stored.retired ?? []), { keyId: keyIdOfSpki(publicKey), publicKey, createdAt: previous.createdAt, retiredAt: new Date(now).toISOString() }];
  replace(file, { ...rest, retired: retired.slice(-MAX_RETIRED) });
  return serverKeyRotationState(now);
}

/** For tests and after replacing the file. */
export function resetServerSigningKeyCache(): void {
  cached = null;
  mayCreate = false;
}
