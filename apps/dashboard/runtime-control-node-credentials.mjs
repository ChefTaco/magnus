/**
 * Control-node credentials at rest (`.magnus/control-nodes.json` in the data directory).
 *
 * Current records are `enc2:` values under CONTROL_NODE_CREDENTIAL_KEY. Records saved before that
 * key existed are `enc:` values under a key derived from JWT_SECRET (or SESSION_SECRET), which
 * Magnus 4 no longer reads: 3.x releases re-encrypted them at console start, and the console now
 * refuses to start while any remain (`LegacyControlNodeCredentialsError`). Very old unencrypted
 * values are still encrypted under CONTROL_NODE_CREDENTIAL_KEY in one atomic rewrite, after a
 * byte-for-byte backup of the file. `magnus-ui credentials` reports what remains. Nothing here
 * logs or returns a credential.
 *
 * Every rewrite holds `control-nodes.json.lock`, which the console's store also takes, so a CLI run
 * never overwrites a save made by a running console. A rewrite runs only as the account that owns
 * the file, so the new file and the backup stay readable by the console; `magnus-ui credentials`
 * run as root first drops to that account.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const CURRENT_MARKER = 'enc2:';
const LEGACY_MARKER = 'enc:';
const CREDENTIAL_FIELDS = ['apiSecret', 'token'];
/** Fields older releases stored and the console no longer reads; a rewrite drops them. */
const RETIRED_FIELDS = ['nodeManagerSecret'];

/** The control-node state file under a console data directory. */
export function controlNodeStateFile(root) {
  return path.join(root, '.magnus', 'control-nodes.json');
}

/** `empty`, `current` (enc2:), `legacy` (enc:, JWT_SECRET-derived key) or `plaintext`. */
export function classifyStoredCredential(value) {
  if (value === undefined || value === null || value === '') return 'empty';
  if (typeof value !== 'string') throw new Error('Control-node state holds a credential that is not a string');
  if (value.startsWith(CURRENT_MARKER)) return 'current';
  if (value.startsWith(LEGACY_MARKER)) return 'legacy';
  return 'plaintext';
}

function errorCode(error) {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

function isMissing(error) {
  return errorCode(error) === 'ENOENT';
}

function assertPrivate(metadata, kind) {
  const mode = Number(metadata.mode) & 0o777;
  if (kind === 'directory' && (!metadata.isDirectory() || metadata.isSymbolicLink() || mode !== 0o700)) {
    throw new Error('Control-node state directory must be a non-symlink directory with mode 0700');
  }
  if (kind === 'file' && (!metadata.isFile() || metadata.isSymbolicLink() || mode !== 0o600)) {
    throw new Error('Control-node state must be a regular non-symlink file with mode 0600');
  }
}

function identity(metadata) {
  return `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`;
}

/** Read and parse the state file with the same ownership rules as the console's store; null when absent. */
function readState(file) {
  try {
    assertPrivate(lstatSync(path.dirname(file)), 'directory');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  let pathMetadata;
  try {
    pathMetadata = lstatSync(file);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  assertPrivate(pathMetadata, 'file');
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw;
  try {
    const opened = fstatSync(descriptor);
    assertPrivate(opened, 'file');
    if (opened.dev !== pathMetadata.dev || opened.ino !== pathMetadata.ino) {
      throw new Error('Control-node state changed while it was being opened');
    }
    raw = readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
  let records;
  try {
    records = JSON.parse(raw);
  } catch {
    throw new Error('Control-node state is not valid JSON');
  }
  if (!Array.isArray(records)) throw new Error('Control-node state must contain an array');
  records.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Control-node state entry ${index} is not an object`);
    }
  });
  return { raw, records, identity: identity(pathMetadata), owner: { uid: Number(pathMetadata.uid), gid: Number(pathMetadata.gid) } };
}

function summarize(records) {
  const counts = { nodes: records.length, current: 0, legacy: 0, plaintext: 0, retired: 0 };
  for (const record of records) {
    for (const field of CREDENTIAL_FIELDS) {
      const kind = classifyStoredCredential(record[field]);
      if (kind !== 'empty') counts[kind] += 1;
    }
    for (const field of RETIRED_FIELDS) if (field in record) counts.retired += 1;
  }
  return counts;
}

/**
 * Count the stored control-node credentials by key. `legacy` is the number still encrypted under
 * the JWT_SECRET-derived key; `plaintext` the number never encrypted; `retired` the records that
 * still carry a retired field. Throws when the file is unreadable or not private.
 */
export function inspectControlNodeCredentials(file) {
  const state = readState(file);
  if (!state) return { present: false, nodes: 0, current: 0, legacy: 0, plaintext: 0, retired: 0 };
  return { present: true, ...summarize(state.records) };
}

/** The uid and gid owning the state file, or null when there is none. */
export function controlNodeStateOwner(file) {
  try {
    const metadata = lstatSync(file);
    return { uid: Number(metadata.uid), gid: Number(metadata.gid) };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** True when a rewrite under CONTROL_NODE_CREDENTIAL_KEY is still needed. */
export function credentialsNeedReencryption(counts) {
  return counts.legacy > 0 || counts.plaintext > 0 || counts.retired > 0;
}

// ── Cross-process lock shared with the console's control-node store ──────────────────────────────

/**
 * A lock whose holder cannot be identified (another account's unreadable lock) counts as abandoned
 * after this long: a rewrite takes milliseconds. A lock whose holder is a live process never does.
 */
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 50;

/**
 * Locks this process holds, by path: the nonce written into the lock file and the number of holders
 * sharing it. Kept on globalThis so every bundled copy of this module in the console shares it.
 * @returns {Map<string, { nonce: string, holders: number }>}
 */
function heldLocks() {
  const key = Symbol.for('magnus.controlNodeStateLocks');
  const registry = /** @type {Record<symbol, Map<string, { nonce: string, holders: number }>>} */ (/** @type {unknown} */ (globalThis));
  registry[key] ??= new Map();
  return registry[key];
}

/** The lock file every writer of `file` holds while it reads, changes and replaces it. */
export function controlNodeStateLockFile(file) {
  return `${file}.lock`;
}

/** The lock's holder (`pid nonce`), or null when there is no lock. `readable` is false for another account's lock. */
function readLock(lockFile) {
  let metadata;
  try {
    metadata = lstatSync(lockFile);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  let content = '';
  let readable = true;
  try {
    content = readFileSync(lockFile, 'utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    if (errorCode(error) !== 'EACCES') throw error;
    readable = false;
  }
  const [pidText = '', nonce = ''] = content.trim().split(/\s+/);
  const pid = Number.parseInt(pidText, 10);
  return { pid: Number.isInteger(pid) && pid > 0 ? pid : null, nonce: nonce || null, readable, metadata };
}

function sameLock(a, b) {
  if (!a || !b) return false;
  if (a.nonce && b.nonce) return a.nonce === b.nonce;
  return a.metadata.dev === b.metadata.dev && a.metadata.ino === b.metadata.ino && a.metadata.mtimeMs === b.metadata.mtimeMs;
}

/** True when the lock's holder is gone. Liveness decides; age only when the holder is unknown. */
function lockIsAbandoned(lock) {
  if (lock.pid !== null) {
    // The same pid without a holder here is a lock left by an earlier process that had our pid.
    if (lock.pid === process.pid) return !heldLocks().has(lock.lockFile);
    try {
      process.kill(lock.pid, 0);
      return false;
    } catch (error) {
      return errorCode(error) === 'ESRCH';
    }
  }
  return Date.now() - lock.metadata.mtimeMs > LOCK_STALE_MS;
}

/** Replaceable by tests only, to make the lock write fail. */
export const lockTestHooks = {
  /** @param {number} descriptor @param {string} text */
  writeLock(descriptor, text) {
    writeFileSync(descriptor, text, 'utf8');
    fsyncSync(descriptor);
  },
};

/** Create the lock with a fresh nonce; returns the nonce, or null when a lock already exists. */
function createLock(lockFile) {
  const nonce = randomBytes(16).toString('hex');
  let descriptor;
  try {
    descriptor = openSync(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return null;
    throw error;
  }
  try {
    lockTestHooks.writeLock(descriptor, `${process.pid} ${nonce}\n`);
  } catch (error) {
    // Never leave a half-written lock behind: it would read as held by nobody we can check.
    try { closeSync(descriptor); } catch { /* closing again below is harmless */ }
    descriptor = undefined;
    try { unlinkSync(lockFile); } catch { /* already gone */ }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return nonce;
}

function tryAcquireLock(lockFile) {
  const locks = heldLocks();
  const held = locks.get(lockFile);
  if (held) {
    held.holders += 1;
    return true;
  }
  let nonce = createLock(lockFile);
  if (nonce === null) {
    const judged = readLock(lockFile);
    // The lock vanished between the two calls: try to create it again, never unlink blindly.
    if (judged !== null) {
      if (!lockIsAbandoned({ ...judged, lockFile })) return false;
      // Take over only the lock judged abandoned, re-read just before unlinking it.
      if (!sameLock(judged, readLock(lockFile))) return false;
      try { unlinkSync(lockFile); } catch (error) { if (!isMissing(error)) throw error; }
    }
    nonce = createLock(lockFile);
    if (nonce === null) return false;
  }
  locks.set(lockFile, { nonce, holders: 1 });
  return true;
}

function releaseLock(lockFile) {
  const locks = heldLocks();
  const held = locks.get(lockFile);
  if (!held) return;
  if (held.holders > 1) {
    held.holders -= 1;
    return;
  }
  locks.delete(lockFile);
  // Remove the lock only while it is still ours (a taken-over lock belongs to someone else now).
  const current = readLock(lockFile);
  if (current?.readable && current.nonce === held.nonce) {
    try { unlinkSync(lockFile); } catch (error) { if (!isMissing(error)) throw error; }
  }
}

function lockBusy(lockFile) {
  return new Error(`Control-node state is locked by another process (${path.basename(lockFile)}); nothing was changed, try again`);
}

/**
 * Hold the state lock while `fn` runs. Within one process the lock is shared, so nested and
 * concurrent holders in the console do not wait for each other (its own mutex orders them); another
 * process waits up to five seconds, then fails. The state directory must exist.
 * @template T
 * @param {string} file
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withControlNodeStateLock(file, fn) {
  const lockFile = controlNodeStateLockFile(file);
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!tryAcquireLock(lockFile)) {
    if (Date.now() > deadline) throw lockBusy(lockFile);
    await new Promise((resolveWait) => setTimeout(resolveWait, LOCK_POLL_MS));
  }
  try {
    return await fn();
  } finally {
    releaseLock(lockFile);
  }
}

function withControlNodeStateLockSync(file, fn, waitMs = LOCK_WAIT_MS) {
  const lockFile = controlNodeStateLockFile(file);
  const deadline = Date.now() + waitMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (!tryAcquireLock(lockFile)) {
    if (Date.now() > deadline) throw lockBusy(lockFile);
    Atomics.wait(pause, 0, 0, LOCK_POLL_MS);
  }
  try {
    return fn();
  } finally {
    releaseLock(lockFile);
  }
}

/** Legacy `enc:` values remain; Magnus 4 cannot decrypt them. */
export class LegacyControlNodeCredentialsError extends Error {
  constructor(count) {
    super(`${count} control-node credential(s) are still encrypted under the legacy JWT_SECRET-derived key, `
      + 'which Magnus 4 no longer reads. Start the last 3.x console once (it re-encrypts them; or run '
      + '`magnus-ui credentials --reencrypt` from 3.x), or restore the 3.x data directory and re-add those control nodes');
    this.name = 'LegacyControlNodeCredentialsError';
    this.count = count;
  }
}

function deriveKey(secret) {
  return createHash('sha256').update(secret).digest();
}

function dedicatedKey(env) {
  const secret = env['CONTROL_NODE_CREDENTIAL_KEY'] ?? '';
  if (secret.length < 32) throw new Error('CONTROL_NODE_CREDENTIAL_KEY must contain at least 32 characters');
  for (const name of ['API_SECRET', 'SESSION_SECRET', 'JWT_SECRET']) {
    if (env[name] && env[name] === secret) throw new Error(`CONTROL_NODE_CREDENTIAL_KEY must be distinct from ${name}`);
  }
  return deriveKey(secret);
}

function decryptWith(value, marker, key) {
  const parts = value.slice(marker.length).split(':');
  if (parts.length !== 3) throw new Error('Stored control-node credential ciphertext is malformed');
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64'));
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Stored control-node credential ciphertext is malformed');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function encryptWith(plaintext, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${CURRENT_MARKER}${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
}

function backupName(file, now) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${file}.legacy-key-backup-${stamp}`;
}

function syncDirectory(directory) {
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

/** Write `contents` to a new private file; never replaces an existing one. */
function writeNewPrivateFile(file, contents) {
  const descriptor = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(descriptor, contents, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeBackup(file, raw, now) {
  const base = backupName(file, now);
  for (const candidate of [base, `${base}-${randomBytes(4).toString('hex')}`]) {
    try {
      writeNewPrivateFile(candidate, raw);
      syncDirectory(path.dirname(file));
      return candidate;
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
    }
  }
  throw new Error('Could not create a unique control-node state backup');
}

/**
 * Encrypt every unencrypted control-node credential under CONTROL_NODE_CREDENTIAL_KEY and drop
 * retired fields. Throws `LegacyControlNodeCredentialsError`, with nothing written, while any value
 * is still under the legacy JWT_SECRET-derived key. Idempotent: a file that needs nothing is left
 * untouched (`status: 'current'`, or `'absent'` when there is no file). Otherwise the original file
 * is first copied to `control-nodes.json.legacy-key-backup-<time>` (mode 0600), every new value is
 * verified by decrypting it again, and the file is replaced atomically; when it changed in the
 * meantime nothing is written. The rewrite holds the state lock shared with the console's store and
 * runs only as the account that owns the file (any other account, root included, is refused, so
 * nothing it writes can end up unreadable by the console or be redirected by that account). Throws, with nothing replaced, when
 * CONTROL_NODE_CREDENTIAL_KEY does not decrypt the values already stored
 * under it, or when the lock stays busy; the console then keeps reading the file as before.
 *
 * @param {string} file
 * @param {Record<string, string | undefined>} [env]
 * @param {{ now?: Date; euid?: number | null; lockWaitMs?: number }} [options]
 *   `euid` and `lockWaitMs` exist for tests; they default to the process's and five seconds.
 */
export function reencryptLegacyControlNodeCredentials(file, env = process.env, options = {}) {
  const peek = readState(file);
  if (!peek) return { status: 'absent', encrypted: 0, retired: 0, backup: null };
  const counts = summarize(peek.records);
  if (counts.legacy > 0) throw new LegacyControlNodeCredentialsError(counts.legacy);
  if (!credentialsNeedReencryption(counts)) {
    return { status: 'current', encrypted: 0, retired: 0, backup: null };
  }
  return withControlNodeStateLockSync(file, () => rewriteUnderLock(file, env, options), options.lockWaitMs);
}

function rewriteUnderLock(file, env, options) {
  const state = readState(file);
  if (!state) return { status: 'absent', encrypted: 0, retired: 0, backup: null };
  const before = summarize(state.records);
  if (before.legacy > 0) throw new LegacyControlNodeCredentialsError(before.legacy);
  if (!credentialsNeedReencryption(before)) return { status: 'current', encrypted: 0, retired: 0, backup: null };

  // The rewrite must stay readable by the account the console runs as, which owns the file.
  const euid = options.euid ?? (typeof process.geteuid === 'function' ? process.geteuid() : null);
  if (euid !== null && euid !== state.owner.uid) {
    throw new Error(`Control-node state belongs to uid ${state.owner.uid}, not this account (uid ${euid}); `
      + 'run this as the account the console runs as, for example: sudo -u magnus magnus-ui credentials …');
  }

  const key = dedicatedKey(env);
  // A key that does not open what is already stored is not the console's key (an exported variable
  // overrides --env-file); writing under it would lock the console out of every control node.
  for (const [index, record] of state.records.entries()) {
    for (const field of CREDENTIAL_FIELDS) {
      if (classifyStoredCredential(record[field]) !== 'current') continue;
      try {
        decryptWith(record[field], CURRENT_MARKER, key);
      } catch {
        throw new Error(`CONTROL_NODE_CREDENTIAL_KEY does not decrypt control-node entry ${index} ${field}, which is already stored under `
          + 'the dedicated key; nothing was changed. Use the key the console runs with (a variable exported in the shell overrides --env-file)');
      }
    }
  }

  const next = state.records.map((record, index) => {
    const updated = { ...record };
    for (const field of RETIRED_FIELDS) delete updated[field];
    for (const field of CREDENTIAL_FIELDS) {
      const value = record[field];
      const kind = classifyStoredCredential(value);
      if (kind === 'empty' || kind === 'current') continue;
      const label = `Control-node entry ${index} ${field}`;
      const plaintext = value;
      const encrypted = encryptWith(plaintext, key);
      if (decryptWith(encrypted, CURRENT_MARKER, key) !== plaintext) throw new Error(`${label} failed round-trip verification`);
      updated[field] = encrypted;
    }
    return updated;
  });

  const backup = writeBackup(file, state.raw, options.now ?? new Date());
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.control-nodes.${process.pid}.${randomBytes(12).toString('hex')}.tmp`);
  let temporaryExists = false;
  try {
    writeNewPrivateFile(temporary, `${JSON.stringify(next, null, 2)}\n`);
    temporaryExists = true;
    const current = lstatSync(file);
    assertPrivate(current, 'file');
    if (identity(current) !== state.identity) {
      throw new Error('Control-node state changed while it was being re-encrypted; nothing was replaced, run it again');
    }
    renameSync(temporary, file);
    temporaryExists = false;
    syncDirectory(directory);
  } finally {
    if (temporaryExists) {
      try { unlinkSync(temporary); } catch { /* already gone */ }
    }
  }

  const after = inspectControlNodeCredentials(file);
  if (credentialsNeedReencryption(after)) throw new Error('Control-node state still holds legacy credentials after re-encryption');
  return { status: 'reencrypted', encrypted: before.plaintext, retired: before.retired, backup };
}

/** One log line for a re-encryption result, or null when nothing changed. Never includes a value. */
export function describeReencryption(result) {
  if (result.status !== 'reencrypted') return null;
  const parts = [];
  if (result.encrypted) parts.push(`${result.encrypted} that were not encrypted`);
  if (result.retired) parts.push(`dropped ${result.retired} retired node-manager secret(s)`);
  return `encrypted control-node credentials under CONTROL_NODE_CREDENTIAL_KEY (${parts.join('; ')}); the previous file is kept at ${result.backup}`;
}

/** One summary line for `magnus-ui credentials`; with `file`, it names the file it describes. */
export function describeCredentialCounts(counts, file) {
  if (!counts.present) {
    return file
      ? `control-node credentials: no state file at ${file} (nothing is stored there; check --data-dir)`
      : 'control-node credentials: no state file';
  }
  const line = `control-node credentials${file ? ` in ${file}` : ''}: ${counts.current} under CONTROL_NODE_CREDENTIAL_KEY, `
    + `${counts.legacy} under the legacy JWT_SECRET-derived key, ${counts.plaintext} not encrypted`;
  return counts.retired ? `${line}, ${counts.retired} retired node-manager secret(s)` : line;
}
