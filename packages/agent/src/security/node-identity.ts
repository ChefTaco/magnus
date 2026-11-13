/**
 * This node's own identity: an Ed25519 key in `$AGENT_INSTALL_DIR/identity/node.key` (0600) and,
 * once the Control API has bound it, `binding-<key id prefix>.json` with the node id and the server
 * keys this agent pins. The binding is named after its key, so replacing the key is one atomic rename. The private key never leaves this module as text: it is not logged, not sent, not passed to
 * child processes (it is a file, not an environment variable) and file routes cannot reach it.
 */
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { KeyObject } from 'node:crypto';
import { join, resolve } from 'node:path';
import { generateSigningKey, keyIdOfSpki, privateKeyFromPem, spkiOf } from './node-request-auth.js';

export interface PinnedServerKey { keyId: string; publicKey: string }
export interface NodeBinding {
  version: 1;
  nodeId: string;
  /** The key this binding belongs to; a binding for another key is ignored. */
  keyId: string;
  serverKeys: PinnedServerKey[];
  origin: 'legacy-upgrade' | 'enrollment-token' | 'rotation';
  boundAt: string;
}
export interface NodeIdentity {
  privateKey: KeyObject;
  publicKey: string;
  keyId: string;
  /** Null while the key exists but the Control API has not bound it yet. */
  binding: NodeBinding | null;
}

const RELOAD_CHECK_MS = 5000;
let cache: { dir: string; stamp: string; checkedAt: number; identity: NodeIdentity | null } | null = null;

export function identityDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env['AGENT_INSTALL_DIR'] ?? process.cwd(), 'identity');
}
const keyPath = (dir: string): string => join(dir, 'node.key');
const bindingPath = (dir: string, keyId: string): string => join(dir, `binding-${keyId.slice(0, 16)}.json`);

function stampOf(dir: string): string {
  // Creating, replacing or removing a file changes the directory's mtime.
  return [keyPath(dir), dir].map(file => {
    try { const stat = statSync(file); return `${stat.mtimeMs}:${stat.size}:${stat.ino}`; }
    catch { return '-'; }
  }).join('|');
}

function privateFile(file: string): string | null {
  let metadata;
  try { metadata = lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0)
    throw new Error(`${file} must be a regular file readable only by its owner (mode 0600)`);
  return readFileSync(file, 'utf8');
}

function writePrivate(file: string, content: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  const descriptor = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(descriptor, content); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  renameSync(temporary, file);
}

function parseBinding(raw: string | null, keyId: string): NodeBinding | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<NodeBinding>;
    if (value.version !== 1 || typeof value.nodeId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.nodeId) || value.keyId !== keyId
      || !Array.isArray(value.serverKeys)) return null;
    const serverKeys = value.serverKeys.filter(key => typeof key?.publicKey === 'string').flatMap(key => {
      try { return [{ keyId: keyIdOfSpki(key.publicKey), publicKey: key.publicKey }]; } catch { return []; }
    });
    return { version: 1, nodeId: value.nodeId, keyId, serverKeys, origin: value.origin ?? 'legacy-upgrade', boundAt: value.boundAt ?? '' };
  } catch { return null; }
}

function read(dir: string): NodeIdentity | null {
  const pem = privateFile(keyPath(dir));
  if (!pem) return null;
  const privateKey = privateKeyFromPem(pem);
  const publicKey = spkiOf(privateKey);
  const keyId = keyIdOfSpki(publicKey);
  return { privateKey, publicKey, keyId, binding: parseBinding(privateFile(bindingPath(dir, keyId)), keyId) };
}

/**
 * The identity on disk, or null when there is none. Cached; a change on disk (an enrollment or a
 * rotation made by the CLI) is picked up within a few seconds. Throws when the files are unsafe.
 */
export function loadNodeIdentity(now = Date.now()): NodeIdentity | null {
  const dir = identityDirectory();
  if (cache && cache.dir === dir && now - cache.checkedAt < RELOAD_CHECK_MS) return cache.identity;
  const stamp = stampOf(dir);
  if (cache && cache.dir === dir && cache.stamp === stamp) { cache.checkedAt = now; return cache.identity; }
  const identity = read(dir);
  cache = { dir, stamp, checkedAt: now, identity };
  return identity;
}

/** The identity when it is bound to a node, else null. Never throws: an unreadable identity is reported once and treated as absent. */
let reportedProblem = '';
export function boundNodeIdentity(): (NodeIdentity & { binding: NodeBinding }) | null {
  try {
    const identity = loadNodeIdentity();
    return identity?.binding ? identity as NodeIdentity & { binding: NodeBinding } : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== reportedProblem) { reportedProblem = message; console.error(`[node-identity] node identity is not usable: ${message}`); }
    return null;
  }
}

/** The key on disk, created (0600, in a 0700 directory) when there is none. */
export function ensureNodeKey(): NodeIdentity {
  const dir = identityDirectory();
  const existing = read(dir);
  if (existing) return existing;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writePrivate(keyPath(dir), generateSigningKey().privateKeyPem);
  cache = null;
  const created = read(dir);
  if (!created) throw new Error('The node key could not be created');
  return created;
}

export function saveNodeBinding(binding: NodeBinding): void {
  const dir = identityDirectory();
  writePrivate(bindingPath(dir, binding.keyId), `${JSON.stringify(binding, null, 2)}\n`);
  cache = null;
}

/** Replace the pinned server keys of the current binding. */
export function savePinnedServerKeys(serverKeys: PinnedServerKey[]): void {
  const identity = loadNodeIdentity(0);
  if (!identity?.binding) return;
  saveNodeBinding({ ...identity.binding, serverKeys });
}

/** Install a new key together with its binding (enrollment with a token, or a rotation). */
export function replaceNodeIdentity(privateKeyPem: string, binding: NodeBinding): void {
  const dir = identityDirectory();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const previous = read(dir);
  // The binding of the new key is written first and has no effect until the key itself is renamed
  // into place, so a running agent sees either the old identity or the new one, never a mix.
  writePrivate(bindingPath(dir, binding.keyId), `${JSON.stringify(binding, null, 2)}\n`);
  writePrivate(keyPath(dir), privateKeyPem);
  if (previous && previous.keyId !== binding.keyId) rmSync(bindingPath(dir, previous.keyId), { force: true });
  cache = null;
}

/** Remove the identity. The agent then uses the shared node secret again (see docs/NODE_CREDENTIALS.md, rollback). */
export function resetNodeIdentity(): boolean {
  const dir = identityDirectory();
  let entries: string[] = [];
  try { entries = readdirSync(dir).filter(name => name === 'node.key' || /^binding-[a-f0-9]{16}\.json$/.test(name)); }
  catch { /* no identity directory */ }
  // The key goes first: a binding without its key is inert.
  for (const name of entries.sort((a, b) => Number(b === 'node.key') - Number(a === 'node.key'))) rmSync(join(dir, name), { force: true });
  cache = null;
  return entries.includes('node.key');
}

/** For tests. */
export function resetNodeIdentityCache(): void {
  cache = null;
  reportedProblem = '';
}
