import { Hono } from 'hono';
import { execFile } from 'node:child_process';
import { constants, realpathSync } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, normalize, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { agentPrivileged, isRoot, notPrivilegedMessage } from '../privileged.js';
import { fileRoots } from './file-roots.js';

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

/**
 * Replace `target` atomically: write a temporary file in the same directory
 * (O_EXCL|O_NOFOLLOW), fsync it, then rename it over the target. A crash
 * leaves either the old or the new content, and a symlink planted at the
 * target after the check is replaced rather than followed. The existing
 * file's mode and owner are kept unless the request names new ones.
 */
async function atomicWrite(target: string, content: string, options: { mode?: number; uid?: number; gid?: number }): Promise<void> {
  const parent = dirname(target);
  // The directory checked must still be the directory written to.
  if (await realpath(parent) !== parent) throw new FileWriteConflictError('Path changed while it was being written');
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && !existing.isFile()) throw new FileWriteConflictError('Target is not a regular file');
  const mode = options.mode ?? (existing ? existing.mode & 0o7777 : 0o600);
  const uid = options.uid ?? existing?.uid; const gid = options.gid ?? existing?.gid;
  const temporary = join(parent, `.${basename(target).slice(0, 200)}.magnus-${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let renamed = false;
  try {
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
    await handle.sync();
    await handle.close();
    await rename(temporary, target);
    renamed = true;
    const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await directory.sync(); } catch { /* some filesystems refuse directory fsync */ } finally { await directory.close(); }
  } finally {
    if (!renamed) { await handle.close().catch(() => {}); await rm(temporary, { force: true }); }
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

// ── Write a file to the local filesystem ──
fileRoutes.post('/write', async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = writeBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: parsed.error.issues.map(e => e.message).join('; ') },
    }, 400);
  }

  const { filePath, content, createIfMissing, mode, owner, group } = parsed.data;
  if ((owner || group) && !(agentPrivileged() && isRoot())) {
    return c.json({ success: false, error: { code: 'AGENT_NOT_PRIVILEGED', feature: 'file-ownership', message: notPrivilegedMessage('file-ownership') } }, 403);
  }

  try {
    const pathCheck = await validateFilePath(filePath);
    if (!pathCheck.valid) {
      return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: pathCheck.reason } }, 403);
    }

    if (createIfMissing) {
      await mkdir(dirname(pathCheck.resolved), { recursive: true });
    }

    await atomicWrite(pathCheck.resolved, content, {
      ...(mode ? { mode: parseInt(mode, 8) } : {}),
      ...(owner ? { uid: await accountId('passwd', owner) } : {}),
      ...(group ? { gid: await accountId('group', group) } : {}),
    });
    const checksum = createHash('sha256').update(content).digest('hex');

    return c.json({
      success: true,
      data: { written: true, checksum },
    });
  } catch (err: unknown) {
    if (err instanceof UnknownAccountError) return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } }, 400);
    if (err instanceof FileWriteConflictError) return c.json({ success: false, error: { code: 'PATH_CHANGED', message: err.message } }, 409);
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ success: false, error: { code: 'FILE_WRITE_ERROR', message } }, 500);
  }
});
