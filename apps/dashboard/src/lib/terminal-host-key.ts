/**
 * Shared SSH host-key verification for interactive terminal sessions.
 *
 * The first fingerprint seen for a host is enrolled under an inter-process
 * lock. In enforce mode every store, lock, and durable-write failure rejects
 * the connection; a damaged trust store must never silently become TOFU again.
 */
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const processLocks = new Set<string>();
const LOCK_WAIT_MS = 2_000;
const LOCK_POLL_MS = 20;

function knownHostsFile(): string {
  return process.env['SSH_HOST_KEYS_FILE'] ?? join(/*turbopackIgnore: true*/ process.cwd(), 'terminal-audit', 'known-hosts.json');
}

function auditTrustEvent(event: Record<string, unknown>): void {
  try {
    const dir = process.env['TERMINAL_AUDIT_DIR'] ?? join(/*turbopackIgnore: true*/ process.cwd(), 'terminal-audit');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(
      join(dir, 'sessions.jsonl'),
      `${JSON.stringify({ ...event, timestamp: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Trust enforcement remains fail-closed even when secondary audit output fails.
  }
}

function rejectOrWarn(mode: string, event: Record<string, unknown>): boolean {
  auditTrustEvent(event);
  console.error(`[terminal] SSH host-key verification failed for ${String(event['host'] ?? 'unknown host')}: ${String(event['reason'] ?? 'verification error')}`);
  return mode !== 'enforce';
}

function validateOwnedPrivatePath(path: string, kind: 'directory' | 'file'): void {
  const info = lstatSync(/*turbopackIgnore: true*/ path);
  const expectedUid = typeof process.geteuid === 'function' ? process.geteuid() : info.uid;
  if (info.isSymbolicLink() || (kind === 'directory' ? !info.isDirectory() : !info.isFile())) {
    throw new Error(`${kind} is not a regular ${kind}`);
  }
  if (info.uid !== expectedUid) throw new Error(`${kind} is not owned by the service account`);
  const permissions = info.mode & 0o777;
  if (kind === 'directory' ? permissions !== 0o700 : permissions !== 0o600) {
    throw new Error(`${kind} permissions must be ${kind === 'directory' ? '0700' : '0600'}`);
  }
}

function ensurePrivateDirectory(directory: string): void {
  if (!existsSync(/*turbopackIgnore: true*/ directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  validateOwnedPrivatePath(directory, 'directory');
}

function parseKnownHosts(file: string): Record<string, string> {
  const parsed: unknown = JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('known-hosts document must be an object');
  }
  const known: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [host, fingerprint] of Object.entries(parsed)) {
    if (
      !host
      || host.length > 253
      || ['__proto__', 'prototype', 'constructor'].includes(host)
      || typeof fingerprint !== 'string'
      || fingerprint.length === 0
      || fingerprint.length > 256
    ) {
      throw new Error('known-hosts document contains an invalid entry');
    }
    known[host] = fingerprint;
  }
  return known;
}

function durableWriteKnownHosts(file: string, known: Record<string, string>): void {
  const directory = dirname(file);
  const temporary = join(
    directory,
    `.${file.split('/').pop() ?? 'known-hosts'}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = openSync(
      /*turbopackIgnore: true*/ temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    writeSync(fd, `${JSON.stringify(known, null, 2)}\n`, undefined, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, file);
    validateOwnedPrivatePath(file, 'file');
    const directoryFd = openSync(/*turbopackIgnore: true*/ directory, constants.O_RDONLY);
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } catch (error) {
    if (fd !== null) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* best effort temporary cleanup */ }
    throw error;
  }
}

function acquireFilesystemLock(lockFile: string): number {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      const fd = openSync(
        /*turbopackIgnore: true*/ lockFile,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      writeFileSync(fd, `${process.pid}\n`, { encoding: 'utf8' });
      fsyncSync(fd);
      return fd;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
    }
  }
}

/**
 * Verify an ssh2 SHA-256 fingerprint against the pinned known-hosts store.
 */
export function verifyTerminalHostKey(host: string, fingerprint: string): boolean {
  const mode = process.env['SSH_HOST_KEY_PINNING'] === 'warn' ? 'warn' : 'enforce';
  const file = knownHostsFile();
  const directory = dirname(file);
  const lockFile = `${file}.lock`;

  if (!host || !fingerprint) {
    return rejectOrWarn(mode, { event: 'host-key-store-error', host, reason: 'invalid host or fingerprint', mode });
  }
  if (processLocks.has(file)) {
    return rejectOrWarn(mode, { event: 'host-key-store-error', host, reason: 'process enrollment lock is already held', mode });
  }

  processLocks.add(file);
  let lockFd: number | null = null;
  try {
    ensurePrivateDirectory(directory);
    lockFd = acquireFilesystemLock(lockFile);
    validateOwnedPrivatePath(lockFile, 'file');

    let known: Record<string, string>;
    if (existsSync(/*turbopackIgnore: true*/ file)) {
      validateOwnedPrivatePath(file, 'file');
      known = parseKnownHosts(file);
    } else {
      known = Object.create(null) as Record<string, string>;
    }

    const expected = known[host];
    if (!expected) {
      known[host] = fingerprint;
      durableWriteKnownHosts(file, known);
      auditTrustEvent({ event: 'host-key-enrolled', host, observed: fingerprint, mode });
      return true;
    }

    const matches = expected === fingerprint;
    if (!matches) {
      auditTrustEvent({ event: 'host-key-mismatch', host, expected, observed: fingerprint, mode });
      console.error(`[terminal] SSH host key mismatch for ${host}`);
    }
    return matches || mode !== 'enforce';
  } catch (error) {
    return rejectOrWarn(mode, {
      event: 'host-key-store-error',
      host,
      reason: error instanceof Error ? error.message : String(error),
      mode,
    });
  } finally {
    if (lockFd !== null) {
      try { closeSync(lockFd); } catch { /* already closed */ }
      try {
        unlinkSync(lockFile);
        const directoryFd = openSync(/*turbopackIgnore: true*/ directory, constants.O_RDONLY);
        try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      } catch { /* a leftover lock fails future enrollment closed */ }
    }
    processLocks.delete(file);
  }
}
