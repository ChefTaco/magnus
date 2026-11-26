import { Hono, type Context } from 'hono';
import { execFile } from 'node:child_process';
import { constants, realpathSync } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve, normalize, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { agentPrivileged, isRoot, notPrivilegedMessage } from '../privileged.js';
import { fileRoots } from './file-roots.js';
import { filePathPolicy } from '@hivemagnus/magnus-contracts';

const execFileAsync = promisify(execFile);

export const fileRoutes = new Hono();

/** Largest file returned inline by GET /read. */
export const MAX_READ_BYTES = 2 * 1024 * 1024;

/** Blocked path prefixes that file operations must not access. */
const BLOCKED_PREFIXES = ['/proc', '/sys', '/dev', '/boot/efi'];

/**
 * Agent-owned secrets and durable state. Node authentication alone must not
 * expose or replace the result-signing and reconciliation keys, TLS key,
 * or receipts.
 */
function protectedRoots(): string[] {
  const installDir = resolve(process.env['AGENT_INSTALL_DIR'] ?? process.cwd());
  const roots = [
    '/opt/magnus-agent',
    installDir,
  ];
  const keyPath = process.env['TLS_KEY_PATH'];
  if (keyPath) roots.push(resolve(installDir, keyPath));
  return roots;
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function blockedReason(path: string): string | null {
  for (const prefix of BLOCKED_PREFIXES) {
    if (within(path, prefix)) return `Access to ${prefix} is blocked`;
  }
  for (const root of protectedRoots()) {
    if (within(path, root)) return 'Access to Magnus agent state is blocked';
  }
  const allowed = fileRoots();
  // A malformed allowlist fails closed: the operator asked for a restriction.
  if (allowed.errors.length) return 'MAGNUS_AGENT_FILE_ROOTS is invalid; the file API is disabled';
  // A root that is itself a symlink (/srv -> /data/srv) also admits its target.
  const realRoot = (root: string): string => { try { return realpathSync(root); } catch { return root; } };
  if (allowed.roots && !allowed.roots.some(root => within(path, root) || within(path, realRoot(root)))) return 'Path is outside MAGNUS_AGENT_FILE_ROOTS';
  return null;
}

/** Resolve symlinks for the longest existing prefix of a path. */
async function realTarget(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const parent = dirname(path);
    if (parent === path) return path;
    return resolve(await realTarget(parent), basename(path));
  }
}

/** Validate that a file path is safe (no traversal, not in blocked directories, symlinks resolved). */
async function validateFilePath(filePath: string): Promise<{ valid: true; resolved: string } | { valid: false; reason: string }> {
  if (filePath.includes('\0')) {
    return { valid: false, reason: 'Path contains null bytes' };
  }
  const resolved = resolve(normalize(filePath));
  const lexical = blockedReason(resolved);
  if (lexical) return { valid: false, reason: lexical };
  const target = await realTarget(resolved);
  const real = blockedReason(target);
  if (real) return { valid: false, reason: real };
  return { valid: true, resolved: target };
}

const accountName = z.string().regex(/^(?:[0-9]{1,10}|[a-z_][a-z0-9_.-]{0,31}\$?)$/i, 'owner and group must be an account name or numeric id');
const writeBodySchema = z.object({
  filePath: z.string().min(1).max(4096),
  content: z.string(),
  createIfMissing: z.boolean().default(true),
  /** Permission bits for the file, e.g. "0644". Default: the existing file's mode, or 0600 for a new file. */
  mode: z.string().regex(/^0?[0-7]{3,4}$/, 'mode must be an octal string such as 0644').optional(),
  /** Owner and group (name or id); privileged mode only. Default: the existing file's, or the agent's. */
  owner: accountName.optional(),
  group: accountName.optional(),
});

/** The write was refused before the target changed (path swapped, not a regular file, owner not kept). */
class FileWriteConflictError extends Error {}

async function accountId(kind: 'passwd' | 'group', value: string): Promise<number> {
  if (/^[0-9]+$/.test(value)) return Number(value);
  const { stdout } = await execFileAsync('/usr/bin/getent', [kind, value], { timeout: 5_000, env: { PATH: '/usr/bin:/bin' } })
    .catch(() => ({ stdout: '' }));
  const id = Number(stdout.split(':')[2]);
  if (!stdout || !Number.isSafeInteger(id)) throw new UnknownAccountError(`Unknown ${kind === 'passwd' ? 'owner' : 'group'} ${value}`);
  return id;
}
class UnknownAccountError extends Error {}

/** Test hooks: run at the two race windows of a write, so a test can swap the directory there. */
export const fileWriteRaceHooks: { afterCheck?: () => Promise<void>; beforeRename?: () => Promise<void> } = {};

/** A path component another account could replace: a write through it is refused, nothing written. */
class UnsafePathError extends FileWriteConflictError {}

interface DirectoryIdentity { dev: number; ino: number }

/**
 * Walks `directory` from / with lstat: every component must be a real directory (no symlink),
 * owned by a trusted account (root, this agent, or the account that owns or will own the file),
 * and not writable by every account unless sticky (like /tmp). Group write is not judged (Debian's
 * /usr/local is group-writable by staff). No untrusted account can then swap a component between
 * the check and the write. Returns the directory's identity.
 */
async function verifyDirectory(directory: string, trusted: ReadonlySet<number>): Promise<DirectoryIdentity> {
  let current: string = sep;
  let info = await lstat(current);
  for (const part of ['', ...directory.split(sep).filter(Boolean)]) {
    if (part) { current = join(current, part); info = await lstat(current); }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new FileWriteConflictError(`Path component ${current} is not a plain directory`);
    if (!trusted.has(info.uid)) throw new UnsafePathError(`${current} belongs to another account; nothing was written`);
    if ((info.mode & 0o002) && !(info.mode & 0o1000)) throw new UnsafePathError(`${current} is writable by every account; nothing was written`);
  }
  return { dev: info.dev, ino: info.ino };
}

/**
 * The directory a write was checked against, held open. `confirm()` proves, immediately before
 * and after each rename, that the path still names that same directory, through trusted
 * components and inside the allowed roots. Node has no openat/renameat, so the renames still go
 * by path; these checks (and the ownership rule above) make a swap fail instead of redirecting.
 */
class VerifiedDirectory {
  private constructor(readonly path: string, private readonly identity: DirectoryIdentity,
    private readonly handle: FileHandle, private readonly trusted: ReadonlySet<number>) {}

  static async open(path: string, trusted: ReadonlySet<number>): Promise<VerifiedDirectory> {
    const identity = await verifyDirectory(path, trusted);
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      .catch((error: NodeJS.ErrnoException) => { throw ['ELOOP', 'ENOTDIR', 'ENOENT'].includes(error.code ?? '') ? new FileWriteConflictError('Path changed while it was being written') : error; });
    const directory = new VerifiedDirectory(path, identity, handle, trusted);
    try { await directory.confirm(); } catch (error) { await handle.close(); throw error; }
    return directory;
  }

  async confirm(): Promise<void> {
    const opened = await this.handle.stat();
    const now = await verifyDirectory(this.path, this.trusted).catch((error: unknown) => {
      if (error instanceof FileWriteConflictError) throw error;
      throw new FileWriteConflictError('Path changed while it was being written');
    });
    const real = await realpath(this.path).catch(() => '');
    if (opened.dev !== this.identity.dev || opened.ino !== this.identity.ino || now.dev !== this.identity.dev
      || now.ino !== this.identity.ino || real !== this.path || blockedReason(real) !== null)
      throw new FileWriteConflictError('Path changed while it was being written');
  }

  /** Same inode as `expected` at `name` in this directory, right now. */
  async holds(name: string, expected: DirectoryIdentity): Promise<boolean> {
    const info = await lstat(join(this.path, name)).catch(() => null);
    return Boolean(info && info.dev === expected.dev && info.ino === expected.ino);
  }

  async sync(): Promise<void> { try { await this.handle.sync(); } catch { /* some filesystems refuse directory fsync */ } }
  async close(): Promise<void> { await this.handle.close().catch(() => {}); }
}

/** Write `content` to a new exclusive file in `directory`, then rename it to `name`, verified on both sides. */
async function exclusiveReplace(directory: VerifiedDirectory, name: string, temporaryName: string,
  fill: (handle: FileHandle) => Promise<void>): Promise<void> {
  const temporary = join(directory.path, temporaryName);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const created = await handle.stat();
  let renamed = false;
  try {
    await fill(handle);
    await handle.sync();
    await handle.close();
    await fileWriteRaceHooks.beforeRename?.();
    await directory.confirm();
    await rename(temporary, join(directory.path, name));
    renamed = true;
    if (!(await directory.holds(name, created))) throw new FileWriteConflictError('Path changed while it was being written');
    await directory.confirm();
    await directory.sync();
  } catch (error) {
    // Remove only our own file, wherever the path now leads.
    if (renamed && await directory.holds(name, created)) await rm(join(directory.path, name), { force: true });
    if (!renamed && await directory.holds(temporaryName, created)) await rm(temporary, { force: true });
    throw error;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Replace `target` atomically: write an exclusive temporary file (O_EXCL|O_NOFOLLOW) in the
 * verified directory, fsync it, then rename it over the target. A crash leaves either the old or
 * the new content, a symlink planted at the target is replaced rather than followed, and a swap
 * of the directory or any component refuses the write. The existing file's mode and owner are
 * kept unless the request names new ones.
 */
async function atomicWrite(target: string, content: string, options: { mode?: number; uid?: number; gid?: number; backup?: boolean; adminWrite?: boolean }): Promise<{ backupPath: string | null }> {
  const parent = dirname(target); const name = basename(target);
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && !existing.isFile()) throw new FileWriteConflictError('Target is not a regular file');
  const trusted = new Set([0, process.geteuid?.() ?? 0, ...(existing ? [existing.uid] : []), ...(options.uid !== undefined ? [options.uid] : [])]);
  const directory = await VerifiedDirectory.open(parent, trusted);
  try {
    // The verified, symlink-free directory (bound by dev/ino from here on) decides the policy.
    assertWritePolicy(join(directory.path, name), options.adminWrite === true);
    await fileWriteRaceHooks.afterCheck?.();
    await directory.confirm();
    const backupPath = options.backup && existing ? await backupCopy(directory, name) : null;
    const mode = options.mode ?? (existing ? existing.mode & 0o7777 : 0o600);
    const uid = options.uid ?? existing?.uid; const gid = options.gid ?? existing?.gid;
    await exclusiveReplace(directory, name, `.${name.slice(0, 200)}.magnus-${randomBytes(6).toString('hex')}.tmp`, async (handle) => {
      await handle.writeFile(content, 'utf-8');
      if (uid !== undefined || gid !== undefined) {
        const own = await handle.stat();
        if ((uid ?? own.uid) !== own.uid || (gid ?? own.gid) !== own.gid) {
          await handle.chown(uid ?? own.uid, gid ?? own.gid).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'EPERM') throw new FileWriteConflictError('The file belongs to another account and this agent cannot keep its owner; nothing was written');
            throw error;
          });
        }
      }
      await handle.chmod(mode);
    });
    return { backupPath };
  } finally {
    await directory.close();
  }
}

/**
 * Copy the current target to `<target>.magnus-backup.<timestamp>` in the same verified
 * directory, keeping mode, owner and times like `cp -p`. The source is opened without following a
 * symlink and must still be the file in that directory; the copy goes through the same verified
 * exclusive-replace as the write. A failed backup stops the write.
 */
async function backupCopy(directory: VerifiedDirectory, name: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `${name.slice(0, 180)}.magnus-backup.${stamp}`;
  const source = await open(join(directory.path, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch((error: NodeJS.ErrnoException) => { throw error.code === 'ELOOP' ? new FileWriteConflictError('Path changed while it was being backed up') : error; });
  try {
    const info = await source.stat();
    if (!info.isFile() || !(await directory.holds(name, info))) throw new FileWriteConflictError('Path changed while it was being backed up');
    await exclusiveReplace(directory, backupName, `.${name.slice(0, 180)}.magnus-backup-${randomBytes(6).toString('hex')}.tmp`, async (copy) => {
      const buffer = Buffer.alloc(1024 * 1024);
      for (let position = 0; ;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        await copy.write(buffer, 0, bytesRead);
        position += bytesRead;
      }
      const own = await copy.stat();
      if (own.uid !== info.uid || own.gid !== info.gid) {
        await copy.chown(info.uid, info.gid).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'EPERM') throw new FileWriteConflictError('The file belongs to another account and this agent cannot keep its owner on the backup; nothing was written');
          throw error;
        });
      }
      await copy.chmod(info.mode & 0o7777);
      await copy.utimes(info.atimeMs / 1000, info.mtimeMs / 1000);
    });
    return join(directory.path, backupName);
  } finally {
    await source.close();
  }
}

// ── Read a file from the local filesystem ──
fileRoutes.get('/read', async (c) => {
  const filePath = c.req.query('filePath');
  if (!filePath) {
    return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'filePath required' } }, 400);
  }

  try {
    const pathCheck = await validateFilePath(filePath);
    if (!pathCheck.valid) {
      return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: pathCheck.reason } }, 403);
    }

    // Open first and judge the opened file, so a swap after the path check is
    // not followed (O_NOFOLLOW) and FIFOs do not block (O_NONBLOCK).
    let handle;
    try {
      handle = await open(pathCheck.resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP')
        return c.json({ success: false, error: { code: 'PATH_CHANGED', message: 'Path changed while it was being read' } }, 409);
      throw error;
    }
    let content: string;
    let fileStat;
    try {
      fileStat = await handle.stat();
      if (!fileStat.isFile()) {
        return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Not a regular file' } }, 400);
      }
      if (fileStat.size > MAX_READ_BYTES) {
        return c.json({ success: false, error: { code: 'FILE_TOO_LARGE', message: `File exceeds ${MAX_READ_BYTES} bytes` } }, 413);
      }
      const buffer = Buffer.alloc(fileStat.size);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      content = buffer.subarray(0, bytesRead).toString('utf-8');
    } finally {
      await handle.close();
    }
    const checksum = createHash('sha256').update(content).digest('hex');

    return c.json({
      success: true,
      data: {
        nodeId: process.env['NODE_ID'] ?? 'local',
        filePath: pathCheck.resolved,
        content,
        checksum,
        sizeBytes: fileStat.size,
        modifiedAt: fileStat.mtime.toISOString(),
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ success: false, error: { code: 'FILE_READ_ERROR', message } }, 500);
  }
});

const writeRequestSchema = writeBodySchema.extend({
  /** Copy the existing file to `<file>.magnus-backup.<timestamp>` (same directory) before replacing it. */
  backup: z.boolean().default(false),
  /**
   * The Control API's statement that an ADMIN asked for this write. A sensitive system destination
   * (after symlinks are resolved) needs it; a missing field (older server) counts as false.
   */
  adminWrite: z.boolean().default(false),
});

/** Refused before anything is created: the destination needs an ADMIN's authority, or is never writable. */
class FilePolicyError extends Error {
  constructor(readonly code: 'BLOCKED_PATH' | 'SENSITIVE_PATH_ADMIN_ONLY', message: string) { super(message); }
}

/** Apply the shared system-path rule (packages/contracts file-policy) to one destination. */
function assertWritePolicy(destination: string, adminWrite: boolean): void {
  const policy = filePathPolicy(destination);
  if (policy === 'blocked-path') throw new FilePolicyError('BLOCKED_PATH', `Writing ${destination} is blocked by policy`);
  if (policy === 'sensitive-system-path' && !adminWrite)
    throw new FilePolicyError('SENSITIVE_PATH_ADMIN_ONLY', `Writing ${destination} requires the ADMIN role`);
}

type WriteRequest = z.infer<typeof writeRequestSchema>;

/**
 * The path (and the file-root allowlist) is checked before anything is created, then the optional backup is made next to
 * the target, then the content is written atomically. A refused request leaves
 * no directory, backup or temporary file behind.
 */
async function handleWrite(c: Context, request: WriteRequest) {
  const { filePath, content, createIfMissing, mode, owner, group, backup, adminWrite } = request;
  if ((owner || group) && !(agentPrivileged() && isRoot())) {
    return c.json({ success: false, error: { code: 'AGENT_NOT_PRIVILEGED', feature: 'file-ownership', message: notPrivilegedMessage('file-ownership') } }, 403);
  }

  try {
    const pathCheck = await validateFilePath(filePath);
    if (!pathCheck.valid) {
      return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: pathCheck.reason } }, 403);
    }
    // As requested and as resolved through symlinks: a link under an ordinary path must not carry a
    // non-admin write into a system path. Checked before any directory is created.
    assertWritePolicy(resolve(normalize(filePath)), adminWrite);
    assertWritePolicy(pathCheck.resolved, adminWrite);
    const ids = {
      ...(mode ? { mode: parseInt(mode, 8) } : {}),
      ...(owner ? { uid: await accountId('passwd', owner) } : {}),
      ...(group ? { gid: await accountId('group', group) } : {}),
    };

    if (createIfMissing) {
      await mkdir(dirname(pathCheck.resolved), { recursive: true });
    }

    const { backupPath } = await atomicWrite(pathCheck.resolved, content, { ...ids, backup, adminWrite });
    const checksum = createHash('sha256').update(content).digest('hex');

    return c.json({
      success: true,
      data: { written: true, checksum, backupPath },
    });
  } catch (err: unknown) {
    if (err instanceof FilePolicyError) return c.json({ success: false, error: { code: err.code, message: err.message } }, 403);
    if (err instanceof UnknownAccountError) return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } }, 400);
    if (err instanceof FileWriteConflictError) return c.json({ success: false, error: { code: 'PATH_CHANGED', message: err.message } }, 409);
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ success: false, error: { code: 'FILE_WRITE_ERROR', message } }, 500);
  }
}

function validationError(c: Context, error: z.ZodError) {
  return c.json({
    success: false,
    error: { code: 'VALIDATION_ERROR', message: error.issues.map(e => e.message).join('; ') },
  }, 400);
}

// ── Write a file to the local filesystem ──
// Advertised as `features.restrictedFileWrite: 1` on /api/v1/ping: path and
// MAGNUS_AGENT_FILE_ROOTS check, then the optional backup, then the atomic write.
fileRoutes.post('/write', async (c) => {
  const parsed = writeRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return validationError(c, parsed.error);
  return handleWrite(c, parsed.data);
});
