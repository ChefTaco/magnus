/**
 * The control plane's own Ed25519 signing key: it signs every request to an agent, and its key id
 * is the audience agents sign their requests for. Kept in `$MAGNUS_HOME/state/node-auth/` (0600),
 * created on first use. `next` leaves room for a rotation: agents pin both, the server answers to
 * both audiences and signs with `active`.
 */
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { KeyObject } from 'node:crypto';
import path from 'node:path';
import { magnusHomePath } from '../utils/magnus-home.js';
import { generateSigningKey, keyIdOfSpki, privateKeyFromPem, serverAudience, spkiOf } from '../security/node-request-auth.js';

interface StoredKey { keyId: string; publicKey: string; privateKeyPem: string; createdAt: string }
interface StoredKeys { version: 1; active: StoredKey; next?: StoredKey }

export interface ServerSigningKey { keyId: string; publicKey: string; privateKey: KeyObject }
export interface ServerPublicKey { keyId: string; publicKey: string; status: 'active' | 'next' }

let cached: { path: string; active: ServerSigningKey; next: ServerSigningKey | null } | null = null;
let mayCreate = false;

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

function read(file: string): { active: ServerSigningKey; next: ServerSigningKey | null } {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0)
    throw new Error('The node-auth server key must be a regular file readable only by its owner (mode 0600)');
  const stored = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoredKeys>;
  const active = stored.version === 1 ? parseKey(stored.active) : null;
  if (!active) throw new Error('The node-auth server key file is not readable; restore it or remove it to issue a new key');
  return { active, next: parseKey(stored.next) };
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

function load(): { active: ServerSigningKey; next: ServerSigningKey | null } {
  const file = serverSigningKeyPath();
  if (cached?.path === file) return cached;
  // Test runs get a throwaway key unless they name a file: a test must never write into a real MAGNUS_HOME.
  if (!process.env['NODE_AUTH_SERVER_KEY_PATH'] && (process.env['VITEST'] || process.env['NODE_ENV'] === 'test')) {
    const key = generateSigningKey();
    cached = { path: file, active: { keyId: key.keyId, publicKey: key.publicKey, privateKey: privateKeyFromPem(key.privateKeyPem) }, next: null };
    return cached;
  }
  if (!existsSync(file)) {
    if (!mayCreate) throw new Error(`No server signing key at ${file}; run this command with the server's environment `
      + '(--env-file, or the same MAGNUS_HOME / NODE_AUTH_SERVER_KEY_PATH as the server) so it signs with the key agents pin');
    create(file);
  }
  cached = { path: file, ...read(file) };
  return cached;
}

/** The key this server signs agent requests with. Never log or return its `privateKey`. */
export function serverSigningKey(): ServerSigningKey {
  return load().active;
}

/** Public keys agents pin: the active one and, during a rotation, the next. */
export function serverPublicKeys(): ServerPublicKey[] {
  const { active, next } = load();
  return [{ keyId: active.keyId, publicKey: active.publicKey, status: 'active' as const },
    ...(next ? [{ keyId: next.keyId, publicKey: next.publicKey, status: 'next' as const }] : [])];
}

/** Every audience an agent may have signed for. */
export function serverAudiences(): string[] {
  return serverPublicKeys().map(key => serverAudience(key.keyId));
}

/** For tests and after replacing the file. */
export function resetServerSigningKeyCache(): void {
  cached = null;
  mayCreate = false;
}
