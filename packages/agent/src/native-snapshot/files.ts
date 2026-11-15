/** Bounded filesystem representation. Bundle storage modes never become restore metadata. */
import { constants, createReadStream } from 'node:fs';
import { chmod, chown, copyFile, lstat, mkdir, open, readdir, readlink, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
};
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const safeRelative = z.string().max(4096).refine(value => value === '' || (!isAbsolute(value) && value.split('/').every(part =>
  part !== '' && part !== '.' && part !== '..' && !/[\x00-\x1f\x7f\\]/.test(part))), 'Unsafe relative path');
export const entrySchema = z.object({ path: safeRelative, kind: z.enum(['directory', 'file', 'link']),
  uid: z.number().int().nonnegative(), gid: z.number().int().nonnegative(), mode: z.number().int().min(0).max(0o777),
  size: z.number().int().nonnegative(), sha256: digest.optional(), link: z.string().max(4096).optional() }).strict();
export type Entry = z.infer<typeof entrySchema>;
export type Tree = { label: 'root' | 'runtime' | 'units'; entries: Entry[] };
export const treeSchema = z.object({ label: z.enum(['root', 'runtime', 'units']), entries: z.array(entrySchema).max(100_000) }).strict();
export const within = (parent: string, child: string) => { const r = relative(parent, child); return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep)); };
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
export const statOptional = async (path: string) => lstat(path).catch(error => { if (missing(error)) return null; throw error; });

export async function plainPath(path: string, allowMissing = false): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path || path === '/') throw new Error('An absolute, normalized non-root path is required');
  let current = '/';
  for (const part of path.split('/').filter(Boolean)) {
    current = join(current, part);
    const info = await statOptional(current);
    if (!info) { if (allowMissing) return; throw new Error('Required path is missing'); }
    if (info.isSymbolicLink()) throw new Error('A path component is a symlink');
    if (current !== path && !info.isDirectory()) throw new Error('Path parent is not a directory');
  }
}
export async function privateDirectory(path: string, rootUid: number, create = false): Promise<void> {
  await plainPath(create ? dirname(path) : path);
  const parent = await lstat(create ? dirname(path) : path);
  if (!parent.isDirectory() || parent.uid !== rootUid || (parent.mode & 0o077) !== 0) throw new Error('Mutable snapshot storage must be owner-private and root-controlled');
  if (create) await mkdir(path, { mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== rootUid || (info.mode & 0o077) !== 0) throw new Error('Snapshot directory is not private');
}
export async function durableJson(path: string, value: unknown): Promise<void> {
  const temp = path + '.next';
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
  const { rename } = await import('node:fs/promises');
  await rename(temp, path);
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function syncPath(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function durableMove(from: string, to: string): Promise<void> {
  const { rename } = await import('node:fs/promises');
  await rename(from, to); await syncPath(dirname(from));
  if (dirname(from) !== dirname(to)) await syncPath(dirname(to));
}
export async function readJson(path: string): Promise<unknown> {
  await plainPath(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 32 * 1024 * 1024 || (info.mode & 0o077) !== 0) throw new Error('Snapshot metadata is not a bounded private file');
    return JSON.parse(await file.readFile('utf8')) as unknown;
  } finally { await file.close(); }
}
export async function fileHash(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 2 * 1024 ** 3) throw new Error('Snapshot file is not a bounded ordinary file');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream('', { fd: handle.fd, autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Snapshot file changed while reading');
    return hash.digest('hex');
  } finally { await handle.close(); }
}
export async function sqliteFile(path: string): Promise<boolean> {
  if (/\.(?:sqlite3?|db)$/i.test(path)) return true;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(16); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytesRead === 16 && bytes.equals(Buffer.from('SQLite format 3\0'));
  } finally { await handle.close(); }
}
function linkSyntax(target: string) {
  if (!target || isAbsolute(target) || /[\x00-\x1f\x7f\\]/.test(target)) throw new Error('Snapshot link escapes its declared tree');
}
/** Resolve raw components like the kernel: expand each link before consuming later '..'.
 * Only declared entries are consulted; no target is ever dereferenced on the host. */
function resolveLink(entry: Entry, entries: ReadonlyMap<string, Entry>) {
  const cursor = entry.path.split('/').slice(0, -1);
  let pending = entry.link!.split('/'), index = 0, expansions = 1, steps = 0;
  const visited = new Set<string>();
  while (index < pending.length) {
    if (++steps > 16_384) throw new Error('Snapshot link graph exceeds resolution bounds');
    const part = pending[index++]!;
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (cursor.length === 0) throw new Error('Snapshot link escapes its declared tree');
      cursor.pop(); continue;
    }
    const path = [...cursor, part].join('/'), target = entries.get(path);
    if (!target) throw new Error('Snapshot link target is dangling or undeclared');
    if (target.kind === 'link') {
      if (++expansions > 40) throw new Error('Snapshot link graph exceeds the 40-link bound');
      const state = JSON.stringify([path, pending.slice(index)]);
      if (visited.has(state)) throw new Error('Snapshot link graph contains a cycle');
      visited.add(state);
      linkSyntax(target.link!);
      pending = [...target.link!.split('/'), ...pending.slice(index)]; index = 0;
    } else {
      // Even a trailing slash or '/..' requires this component to be a real directory.
      if (index < pending.length && target.kind !== 'directory') throw new Error('Snapshot link traverses a non-directory');
      cursor.push(part);
    }
  }
  if (!entries.has(cursor.join('/'))) throw new Error('Snapshot link target is dangling or undeclared');
}
export function validateTree(tree: Tree, uid: number, gid: number): void {
  const seen = new Map<string, Entry>();
  for (const entry of tree.entries) {
    if (seen.has(entry.path)) throw new Error('Duplicate snapshot entry');
    // The manager writes this one verified receipt after owner-run npm installation.
    const managerReceipt = tree.label === 'runtime' && entry.path === 'package-receipt.json' && entry.kind === 'file'
      && entry.uid === 0 && entry.gid === 0 && entry.mode === 0o600;
    if ((!managerReceipt && (entry.uid !== uid || entry.gid !== gid)) || (entry.kind !== 'link' && (entry.mode & 0o022) !== 0)) throw new Error('Snapshot ownership or writable mode is unsupported');
    if (/\.(?:gguf|safetensors|onnx|pt|pth|ckpt)$/i.test(entry.path) || (tree.label === 'root' && /(?:^|\/)models(?:\/|$)/i.test(entry.path)))
      throw new Error('Model assets are outside the native snapshot contract');
    if (entry.kind === 'file' ? !entry.sha256 || entry.link !== undefined : entry.sha256 !== undefined || (entry.kind === 'link' ? !entry.link : entry.link !== undefined))
      throw new Error('Snapshot entry metadata differs from its kind');
    if (entry.kind === 'link') linkSyntax(entry.link!);
    seen.set(entry.path, entry);
  }
  if (tree.entries.length && tree.entries[0]!.path !== '') throw new Error('Snapshot tree root is missing');
  const parents = new Set<string>();
  for (const entry of tree.entries) {
    const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
    if (entry.path === '' ? entry.kind !== 'directory' : !parents.has(parent) || seen.get(parent)?.kind !== 'directory')
      throw new Error('Snapshot entry parent is missing or is not a directory');
    parents.add(entry.path);
  }
  for (const entry of tree.entries) if (entry.kind === 'link') resolveLink(entry, seen);
}
export async function scanTree(root: string, label: Tree['label'], uid: number, gid: number): Promise<Tree> {
  await plainPath(root, true);
  const entries: Entry[] = []; let total = 0;
  if (!await statOptional(root)) return { label, entries };
  const walk = async (path: string): Promise<void> => {
    const file = join(root, path), info = await lstat(file);
    if (entries.length >= 100_000 || info.mode & 0o7000 || (!info.isDirectory() && !info.isFile() && !info.isSymbolicLink())) throw new Error('Unsupported native snapshot entry');
    const entry: Entry = { path, kind: info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'link' : 'file', uid: info.uid, gid: info.gid, mode: info.mode & 0o777, size: info.isFile() ? info.size : 0 };
    if (entry.kind === 'file') { total += info.size; if (total > 16 * 1024 ** 3) throw new Error('Native snapshot exceeds storage bounds'); entry.sha256 = await fileHash(file); }
    if (entry.kind === 'link') { entry.link = await readlink(file); linkSyntax(entry.link); }
    entries.push(entry);
    if (info.isDirectory()) for (const child of (await readdir(file)).sort()) { safeRelative.parse(child); await walk(path ? path + '/' + child : child); }
  };
  await walk(''); const tree = { label, entries }; validateTree(tree, uid, gid); return tree;
}
/** Copy only regular payloads. Links are inert manifest entries until trusted restoration. */
export async function packTree(root: string, destination: string, tree: Tree): Promise<void> {
  if (!tree.entries.length) return;
  for (const entry of tree.entries) {
    const to = join(destination, entry.path);
    if (entry.kind === 'directory') await mkdir(to, { mode: 0o700 });
    if (entry.kind === 'file') { await copyFile(join(root, entry.path), to, constants.COPYFILE_EXCL); await chmod(to, 0o600); if (await fileHash(to) !== entry.sha256) throw new Error('Snapshot payload changed during copy'); await syncPath(to); }
  }
  for (const entry of [...tree.entries].reverse()) if (entry.kind === 'directory') await syncPath(join(destination, entry.path));
}
export async function verifyPayload(source: string, tree: Tree): Promise<void> {
  const base = join(source, 'files', tree.label);
  if (!tree.entries.length) { if (await statOptional(base)) throw new Error('Undeclared snapshot tree'); return; }
  const expected = new Map(tree.entries.filter(e => e.kind !== 'link').map(e => [e.path, e]));
  let count = 0;
  const visit = async (path: string): Promise<void> => {
    const file = join(base, path), info = await lstat(file), entry = expected.get(path);
    if (!entry || info.isSymbolicLink() || info.mode & 0o077 || (entry.kind === 'directory' ? !info.isDirectory() : !info.isFile() || info.nlink !== 1 || info.size !== entry.size))
      throw new Error('Snapshot payload shape or private storage mode differs');
    count++;
    if (entry.kind === 'file' && await fileHash(file) !== entry.sha256) throw new Error('Snapshot payload digest differs');
    if (entry.kind === 'directory') for (const name of await readdir(file)) { safeRelative.parse(name); await visit(path ? path + '/' + name : name); }
  };
  await plainPath(base); await visit(''); if (count !== expected.size) throw new Error('Snapshot payload is incomplete');
}
export async function unpackTree(source: string, destination: string, tree: Tree): Promise<void> {
  if (!tree.entries.length) return;
  for (const entry of tree.entries) {
    const to = join(destination, entry.path);
    if (entry.kind === 'directory') await mkdir(to, { mode: 0o700 });
    else if (entry.kind === 'file') {
      await copyFile(join(source, 'files', tree.label, entry.path), to, constants.COPYFILE_EXCL);
      if (await fileHash(to) !== entry.sha256) throw new Error('Restore payload changed while staging');
    } else await symlink(entry.link!, to);
    // Apply original metadata, never metadata belonging to archive staging.
    if (entry.kind !== 'link') { await chown(to, entry.uid, entry.gid); await chmod(to, entry.mode); }
    else { const { lchown } = await import('node:fs/promises'); await lchown(to, entry.uid, entry.gid); }
  }
  for (const entry of [...tree.entries].reverse()) if (entry.kind !== 'link') await syncPath(join(destination, entry.path));
}
