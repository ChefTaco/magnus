import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { safeEqual } from '../middleware/auth.js';
import { magnusHomePath } from '../utils/magnus-home.js';
export const securityBackupRouter = new Hono();
let receiving = false;
securityBackupRouter.post('/', async (c) => {
  const digest = process.env['SECURITY_BACKUP_TOKEN_SHA256'];
  const token = c.req.header('Authorization')?.replace(/^Bearer /, '') ?? '';
  if (!digest || !token || !safeEqual(createHash('sha256').update(token).digest('hex'), digest))
    return c.json({ error: 'Unauthorized' }, 401);
  if (receiving) return c.json({ error: 'Backup upload already active' }, 409);
  const name = c.req.header('x-backup-name') ?? '';
  const expected = c.req.header('x-backup-sha256') ?? '';
  if (!/^security-\d{8}T\d{6}Z\.aes$/.test(name) || !/^[a-f0-9]{64}$/.test(expected))
    return c.json({ error: 'Invalid backup metadata' }, 400);
  const base = process.env['SECURITY_BACKUP_DIRECTORY'] ?? magnusHomePath('security-backups');
  const path = join(base, `.partial-${randomUUID()}`);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  receiving = true;
  try {
    await mkdir(base, { recursive: true, mode: 0o700 });
    const info = await lstat(base);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe backup directory');
    file = await open(path, 'wx', 0o600);
    const hash = createHash('sha256');
    let bytes = 0;
    if (!c.req.raw.body) throw new Error('Empty backup');
    for await (const chunk of c.req.raw.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes > 512 * 1024 * 1024) throw new Error('Backup exceeds 512 MiB');
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    if (bytes < 32 || hash.digest('hex') !== expected) throw new Error('Backup digest mismatch');
    await file.sync();
    await file.close();
    file = undefined;
    await rename(path, join(base, name));
    return c.json({ success: true, data: { name, bytes, sha256: expected } }, 201);
  } catch {
    return c.json({ error: 'Backup transfer failed' }, 503);
  } finally {
    await file?.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    receiving = false;
  }
});
