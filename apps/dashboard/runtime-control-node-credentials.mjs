/**
 * Control-node credentials at rest (`.magnus/control-nodes.json` in the data directory).
 *
 * Current records are `enc2:` values under CONTROL_NODE_CREDENTIAL_KEY. Records saved before that
 * key existed are `enc:` values under a key derived from JWT_SECRET (or SESSION_SECRET), and very
 * old ones are unencrypted. This module counts both kinds and re-encrypts them under
 * CONTROL_NODE_CREDENTIAL_KEY in one atomic rewrite, after a byte-for-byte backup of the file. The
 * console runs the re-encryption at start; `magnus-ui credentials` reports what remains and
 * `magnus-ui credentials --reencrypt` runs it on demand. Nothing here logs or returns a credential.
 *
 * Every rewrite holds `control-nodes.json.lock`, which the console's store also takes, so a CLI run
 * never overwrites a save made by a running console. A rewrite keeps the file's owner: run as root,
 * it hands the new file and the backup back to that owner; run as another account, it refuses.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchownSync,
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

/** True when a rewrite under CONTROL_NODE_CREDENTIAL_KEY is still needed. */
export function credentialsNeedReencryption(counts) {
  return counts.legacy > 0 || counts.plaintext > 0 || counts.retired > 0;
}

// ── Cross-process lock shared with the console's control-node store ──────────────────────────────

/** Older than this, a lock is abandoned whoever holds it: a rewrite takes milliseconds. */
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 50;
/** Locks this process holds, by path, with the number of holders sharing each one. */
const heldLocks = new Map();

/** The lock file every writer of `file` holds while it reads, changes and replaces it. */
export function controlNodeStateLockFile(file) {
  return `${file}.lock`;
}

function lockIsStale(lockFile) {
  let metadata;
  try {
    metadata = lstatSync(lockFile);
  } catch (error) {
    if (isMissing(error)) return { stale: true, metadata: null };
    throw error;
  }
  if (Date.now() - metadata.mtimeMs > LOCK_STALE_MS) return { stale: true, metadata };
  let pid = NaN;
  try {
    pid = Number.parseInt(readFileSync(lockFile, 'utf8'), 10);
  } catch (error) {
    // Another account's lock (root running the CLI, say) may be unreadable; trust its age alone.
    if (isMissing(error)) return { stale: true, metadata: null };
    if (errorCode(error) !== 'EACCES') throw error;
  }
  if (!Number.isInteger(pid) || pid <= 0) return { stale: false, metadata };
  try {
    process.kill(pid, 0);
    return { stale: false, metadata };
  } catch (error) {
    return { stale: errorCode(error) === 'ESRCH', metadata };
  }
}

function createLock(lockFile) {
  try {
    writeNewPrivateFile(lockFile, `${process.pid}\n`);
    return true;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false;
    throw error;
  }
}

function tryAcquireLock(lockFile) {
  const holders = heldLocks.get(lockFile);
  if (holders) {
    heldLocks.set(lockFile, holders + 1);
    return true;
  }
  if (!createLock(lockFile)) {
    const { stale, metadata } = lockIsStale(lockFile);
    if (!stale) return false;
    // Remove the abandoned lock only if it is still the one judged stale.
    try {
      const current = lstatSync(lockFile);
      if (!metadata || (current.ino === metadata.ino && current.dev === metadata.dev)) unlinkSync(lockFile);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (!createLock(lockFile)) return false;
  }
  heldLocks.set(lockFile, 1);
  return true;
}

function releaseLock(lockFile) {
  const holders = heldLocks.get(lockFile) ?? 0;
  if (holders > 1) {
    heldLocks.set(lockFile, holders - 1);
    return;
  }
  heldLocks.delete(lockFile);
  try { unlinkSync(lockFile); } catch (error) { if (!isMissing(error)) throw error; }
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

/** Every key a legacy `enc:` record may have used: JWT_SECRET first, then SESSION_SECRET. */
function legacyKeys(env) {
  return [...new Set([env['JWT_SECRET'], env['SESSION_SECRET']].filter((value) => typeof value === 'string' && value !== ''))]
    .map(deriveKey);
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

function decryptLegacy(value, keys, label) {
  for (const key of keys) {
    let plaintext;
    try {
      plaintext = decryptWith(value, LEGACY_MARKER, key);
    } catch {
      continue;
    }
    if (!plaintext || plaintext.startsWith(LEGACY_MARKER)) break;
    return plaintext;
  }
  throw new Error(`${label} did not decrypt with JWT_SECRET or SESSION_SECRET; set the secret the console used when it was saved`);
}

function backupName(file, now) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${file}.legacy-key-backup-${stamp}`;
}

function syncDirectory(directory) {
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

/**
 * Write `contents` to a new private file; never replaces an existing one. With `owner`, the file is
 * handed to that uid/gid before anything is written to it.
 */
function writeNewPrivateFile(file, contents, owner = null, fchown = fchownSync) {
  const descriptor = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    if (owner) fchown(descriptor, owner.uid, owner.gid);
    writeFileSync(descriptor, contents, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeBackup(file, raw, now, owner, fchown) {
  const base = backupName(file, now);
  for (const candidate of [base, `${base}-${randomBytes(4).toString('hex')}`]) {
    try {
      writeNewPrivateFile(candidate, raw, owner, fchown);
      syncDirectory(path.dirname(file));
      return candidate;
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
    }
  }
  throw new Error('Could not create a unique control-node state backup');
}

/**
 * Re-encrypt every legacy (`enc:`) and unencrypted control-node credential under
 * CONTROL_NODE_CREDENTIAL_KEY and drop retired fields. Idempotent: a file that needs nothing is
 * left untouched (`status: 'current'`, or `'absent'` when there is no file). Otherwise the original
 * file is first copied to `control-nodes.json.legacy-key-backup-<time>` (mode 0600), every new value
 * is verified by decrypting it again, and the file is replaced atomically; when it changed in the
 * meantime nothing is written. The rewrite holds the state lock shared with the console's store and
 * keeps the file's owner (as root it hands the backup and the new file back to that owner; as any
 * other account than the owner it refuses). Throws, with nothing replaced, when a legacy value
 * cannot be decrypted, when CONTROL_NODE_CREDENTIAL_KEY does not decrypt the values already stored
 * under it, or when the lock stays busy; the console then keeps reading the file as before.
 *
 * @param {string} file
 * @param {Record<string, string | undefined>} [env]
 * @param {{ now?: Date; euid?: number | null; fchown?: (fd: number, uid: number, gid: number) => void; lockWaitMs?: number }} [options]
 *   `euid`, `fchown` and `lockWaitMs` exist for tests; they default to the process's, `fs.fchownSync`
 *   and five seconds.
 */
export function reencryptLegacyControlNodeCredentials(file, env = process.env, options = {}) {
  const peek = readState(file);
  if (!peek) return { status: 'absent', reencrypted: 0, encrypted: 0, retired: 0, backup: null };
  if (!credentialsNeedReencryption(summarize(peek.records))) {
    return { status: 'current', reencrypted: 0, encrypted: 0, retired: 0, backup: null };
  }
  return withControlNodeStateLockSync(file, () => rewriteUnderLock(file, env, options), options.lockWaitMs);
}

function rewriteUnderLock(file, env, options) {
  const state = readState(file);
  if (!state) return { status: 'absent', reencrypted: 0, encrypted: 0, retired: 0, backup: null };
  const before = summarize(state.records);
  if (!credentialsNeedReencryption(before)) return { status: 'current', reencrypted: 0, encrypted: 0, retired: 0, backup: null };

  // The rewrite must stay readable by the account the console runs as, which owns the file.
  const euid = options.euid ?? (typeof process.geteuid === 'function' ? process.geteuid() : null);
  if (euid !== null && euid !== 0 && euid !== state.owner.uid) {
    throw new Error(`Control-node state belongs to uid ${state.owner.uid}, not this account (uid ${euid}); `
      + 'run this as the account the console runs as, for example: sudo -u magnus magnus-ui credentials …');
  }
  const owner = euid === 0 && (state.owner.uid !== 0 || state.owner.gid !== 0) ? state.owner : null;
  const fchown = options.fchown ?? fchownSync;

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
  const candidates = before.legacy > 0 ? legacyKeys(env) : [];
  if (before.legacy > 0 && candidates.length === 0) {
    throw new Error(`${before.legacy} control-node credential(s) use the legacy key, but neither JWT_SECRET nor SESSION_SECRET is set to decrypt them`);
  }

  const next = state.records.map((record, index) => {
    const updated = { ...record };
    for (const field of RETIRED_FIELDS) delete updated[field];
    for (const field of CREDENTIAL_FIELDS) {
      const value = record[field];
      const kind = classifyStoredCredential(value);
      if (kind === 'empty' || kind === 'current') continue;
      const label = `Control-node entry ${index} ${field}`;
      const plaintext = kind === 'legacy' ? decryptLegacy(value, candidates, label) : value;
      const encrypted = encryptWith(plaintext, key);
      if (decryptWith(encrypted, CURRENT_MARKER, key) !== plaintext) throw new Error(`${label} failed round-trip verification`);
      updated[field] = encrypted;
    }
    return updated;
  });

  const backup = writeBackup(file, state.raw, options.now ?? new Date(), owner, fchown);
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.control-nodes.${process.pid}.${randomBytes(12).toString('hex')}.tmp`);
  let temporaryExists = false;
  try {
    writeNewPrivateFile(temporary, `${JSON.stringify(next, null, 2)}\n`, owner, fchown);
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
  return { status: 'reencrypted', reencrypted: before.legacy, encrypted: before.plaintext, retired: before.retired, backup };
}

/** One log line for a re-encryption result, or null when nothing changed. Never includes a value. */
export function describeReencryption(result) {
  if (result.status !== 'reencrypted') return null;
  const parts = [];
  if (result.reencrypted) parts.push(`${result.reencrypted} from the legacy JWT_SECRET-derived key`);
  if (result.encrypted) parts.push(`${result.encrypted} that were not encrypted`);
  if (result.retired) parts.push(`dropped ${result.retired} retired node-manager secret(s)`);
  return `re-encrypted control-node credentials under CONTROL_NODE_CREDENTIAL_KEY (${parts.join('; ')}); the previous file is kept at ${result.backup}`;
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
