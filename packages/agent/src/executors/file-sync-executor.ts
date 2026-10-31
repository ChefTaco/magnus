import { Hono } from 'hono';
import { open, writeFile, mkdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, resolve, normalize, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';

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

const writeBodySchema = z.object({
  filePath: z.string().min(1).max(4096),
  content: z.string(),
  createIfMissing: z.boolean().default(true),
});

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

    const fileStat = await stat(pathCheck.resolved);
    if (!fileStat.isFile()) {
      return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Not a regular file' } }, 400);
    }
    if (fileStat.size > MAX_READ_BYTES) {
      return c.json({ success: false, error: { code: 'FILE_TOO_LARGE', message: `File exceeds ${MAX_READ_BYTES} bytes` } }, 413);
    }

    const handle = await open(pathCheck.resolved, 'r');
    let content: string;
    try {
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

  const { filePath, content, createIfMissing } = parsed.data;

  try {
    const pathCheck = await validateFilePath(filePath);
    if (!pathCheck.valid) {
      return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: pathCheck.reason } }, 403);
    }

    if (createIfMissing) {
      await mkdir(dirname(pathCheck.resolved), { recursive: true });
    }

    await writeFile(pathCheck.resolved, content, 'utf-8');
    const checksum = createHash('sha256').update(content).digest('hex');

    return c.json({
      success: true,
      data: { written: true, checksum },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ success: false, error: { code: 'FILE_WRITE_ERROR', message } }, 500);
  }
});
