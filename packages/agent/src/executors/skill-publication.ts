/** Atomic, receipt-bound publication of a complete skill bundle. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { FileHandle } from 'node:fs/promises';
import type { ManagedExecutionContext } from '../security/managed-context.js';
import { SkillBundleError } from './skill-bundle.js';

const MAX_ENTRIES = 512;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 3 * 1024 * 1024;
const RECEIPT_NAME = '.magnus-publication.json';
const FORMAT = 'magnus-skill-bundle-v1' as const;
const TREE_FORMAT = 'magnus-skill-tree-v1' as const;
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

function safeSegment(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(value) && !value.includes('..');
}
function safePath(value: string): boolean {
  if (!value || value.length > 4096 || value.startsWith('/') || /[\\\x00-\x1f\x7f:]/.test(value)) return false;
  const parts = value.split('/');
  return parts.length <= 32 && parts.every(part => part && part !== '.' && part !== '..' && Buffer.byteLength(part) <= 255);
}

export const skillBundleEntrySchema = z.object({
  path: z.string().refine(safePath, 'Bundle entry path must be a contained POSIX path'),
  mode: z.union([z.literal(0o644), z.literal(0o755)]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentBase64: z.string().max(Math.ceil(MAX_FILE_BYTES / 3) * 4),
}).strict();
export const skillBundleSchema = z.object({
  format: z.literal(FORMAT),
  entries: z.array(skillBundleEntrySchema).min(1).max(MAX_ENTRIES),
}).strict().superRefine((value, context) => {
  let decoded = 0;
  for (let index = 0; index < value.entries.length; index++) {
    const entry = value.entries[index]!;
    if (index && value.entries[index - 1]!.path >= entry.path)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['entries', index, 'path'], message: 'Bundle entries must be unique and strictly path-sorted' });
    const bytes = Buffer.from(entry.contentBase64, 'base64');
    if (bytes.length > MAX_FILE_BYTES || bytes.toString('base64') !== entry.contentBase64)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['entries', index, 'contentBase64'], message: 'Bundle content must be bounded canonical base64' });
    else if (sha256(bytes) !== entry.sha256)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['entries', index, 'sha256'], message: 'Bundle entry digest does not match its bytes' });
    decoded += bytes.length;
  }
  if (decoded > MAX_BUNDLE_BYTES)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['entries'], message: 'Bundle exceeds its decoded size limit' });
});
export const skillPublicationBodySchema = z.object({
  skillName: z.string().min(1).max(128).refine(safeSegment, 'Invalid skill name'),
  version: z.string().min(1).max(128).refine(safeSegment, 'Invalid skill version'),
  bundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
  bundle: skillBundleSchema,
}).strict().superRefine((value, context) => {
  const entry = value.bundle.entries.find(candidate => candidate.path === 'manifest.json');
  if (!entry) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['bundle', 'entries'], message: 'Bundle requires a root manifest.json' }); return;
  }
  try {
    const manifest = z.object({ name: z.string(), version: z.string() }).passthrough()
      .parse(JSON.parse(Buffer.from(entry.contentBase64, 'base64').toString('utf8')));
    if (manifest.name !== value.skillName || manifest.version !== value.version)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['bundle', 'entries'], message: 'Manifest name/version must equal publication identity' });
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['bundle', 'entries'], message: 'Manifest must be valid JSON with name and version' });
    else throw error;
  }
});
export type SkillPublicationBody = z.infer<typeof skillPublicationBodySchema>;

const publicationReceiptSchema = z.object({
  version: z.literal(1), skillName: z.string(), skillVersion: z.string(), bundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
  treeSha256: z.string().regex(/^[a-f0-9]{64}$/), commandId: z.string(), requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  nodeId: z.string(), publishedAt: z.string().datetime(),
}).strict();
type PublicationReceipt = z.infer<typeof publicationReceiptSchema>;
const journalSchema = z.object({ version: z.literal(1), state: z.literal('staged'),
  skillName: z.string(), skillVersion: z.string(), bundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
  treeSha256: z.string().regex(/^[a-f0-9]{64}$/), commandId: z.string(), requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export function canonicalSkillBundleBytes(bundle: z.infer<typeof skillBundleSchema>): Buffer {
  const parsed = skillBundleSchema.parse(bundle);
  return Buffer.from(JSON.stringify({ format: parsed.format, entries: parsed.entries.map(entry => ({
    path: entry.path, mode: entry.mode, sha256: entry.sha256, contentBase64: entry.contentBase64,
  })) }), 'utf8');
}
export function skillBundleSha256(bundle: z.infer<typeof skillBundleSchema>): string {
  return sha256(canonicalSkillBundleBytes(bundle));
}
function treeSha256(entries: Array<{ path: string; mode: 420 | 493; sha256: string }>): string {
  return sha256(JSON.stringify({ format: TREE_FORMAT, entries }));
}
function expectedTree(body: SkillPublicationBody) {
  return body.bundle.entries.map(({ path, mode, sha256: digest }) => ({ path, mode, sha256: digest }));
}

async function assertOwnedDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) || info.nlink < 1
    || (process.getuid && info.uid !== process.getuid()))
    throw new SkillBundleError('UNSAFE_SKILL_PATH', 'Skill publication requires an owned directory not writable by others');
}
export async function openSkillDirectoryAnchor(path: string): Promise<FileHandle> {
  let handle: FileHandle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch (error) {
    if (['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw new SkillBundleError('UNSAFE_SKILL_PATH', 'Skill publication parent must be a real directory');
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isDirectory() || info.mode & 0o022 || (process.getuid && info.uid !== process.getuid()))
      throw new SkillBundleError('UNSAFE_SKILL_PATH', 'Skill publication requires an owned directory not writable by others');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function openDirectoryNoFollow(path: string): Promise<FileHandle> {
  try { return await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch (error) {
    if (['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw new SkillBundleError('UNSAFE_SKILL_PATH', 'Configured skill path contains a symbolic-link or non-directory component');
    throw error;
  }
}
async function openConfiguredRoot(rootInput: string, createLeaf: boolean): Promise<{ path: string; handle: FileHandle }> {
  const path = resolve(rootInput); const segments = path.split('/').filter(Boolean);
  let parent = await openDirectoryNoFollow('/');
  try {
    for (let index = 0; index < segments.length; index++) {
      const childPath = join(`/proc/self/fd/${parent.fd}`, segments[index]!);
      let child: FileHandle;
      try { child = await openDirectoryNoFollow(childPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !createLeaf || index !== segments.length - 1) throw error;
        await mkdir(childPath, { mode: 0o755 }); child = await openDirectoryNoFollow(childPath);
      }
      await parent.close(); parent = child;
    }
    const info = await parent.stat();
    if (!info.isDirectory() || info.mode & 0o022 || (process.getuid && info.uid !== process.getuid()))
      throw new SkillBundleError('UNSAFE_SKILL_PATH', 'Configured skills root must be owned and not writable by others');
    return { path, handle: parent };
  } catch (error) { await parent.close().catch(() => {}); throw error; }
}
async function assertConfiguredRoot(path: string, expected: FileHandle): Promise<void> {
  const current = await openConfiguredRoot(path, false);
  try {
    const [actualInfo, expectedInfo] = await Promise.all([current.handle.stat(), expected.stat()]);
    if (actualInfo.dev !== expectedInfo.dev || actualInfo.ino !== expectedInfo.ino)
      throw new SkillBundleError('SKILL_PARENT_REPLACED', 'Configured skills root identity changed before commit', 409);
  } finally { await current.handle.close(); }
}
async function optionalOwnedDirectory(path: string): Promise<FileHandle | undefined> {
  try { return await openSkillDirectoryAnchor(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export async function assertSkillDirectoryAnchor(path: string, handle: FileHandle): Promise<void> {
  const [current, held] = await Promise.all([lstat(path), handle.stat()]);
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== held.dev || current.ino !== held.ino)
    throw new SkillBundleError('SKILL_PARENT_REPLACED', 'Skill publication parent identity changed before commit', 409);
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function atomicJson(path: string, value: unknown, mode: number, parentHandle?: FileHandle): Promise<void> {
  const temporary = `${path}.write-${randomUUID()}`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path); if (parentHandle) await parentHandle.sync(); else await syncDirectory(dirname(path));
  } catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
}
async function acquire(root: string) {
  if (process.platform !== 'linux') throw new SkillBundleError('SKILL_PUBLICATION_UNAVAILABLE', 'Atomic skill publication requires Linux locking', 500);
  const path = join(root, '.skill-publication.flock');
  const handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.mode & 0o077 || info.nlink !== 1) throw new Error('Invalid publication mutex');
    const code = await new Promise<number | null>((resolveChild, reject) => {
      const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'ignore', 'ignore', handle.fd] });
      child.once('error', reject); child.once('exit', resolveChild);
    });
    if (code === 1) throw new SkillBundleError('SKILL_CATALOG_BUSY', 'Another skill publication owns the catalog', 409);
    if (code !== 0) throw new Error('Publication mutex unavailable');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
function response(receipt: PublicationReceipt) {
  return { success: true as const, data: { id: `${receipt.skillName}-${receipt.skillVersion}`, skillName: receipt.skillName,
    nodeId: receipt.nodeId, version: receipt.skillVersion, status: 'installed' as const, publishedAt: receipt.publishedAt,
    bundleSha256: receipt.bundleSha256, treeSha256: receipt.treeSha256,
    commandId: receipt.commandId, requestSha256: receipt.requestSha256 } };
}
function assertBinding(body: SkillPublicationBody, context: ManagedExecutionContext): void {
  if (!context.coordination || context.coordination.expiresAt <= Date.now() || context.signal?.aborted)
    throw new SkillBundleError('SKILL_PUBLICATION_CANCELLED', 'Authority ended before skill publication; no effect committed', 409);
  if (skillBundleSha256(body.bundle) !== body.bundleSha256)
    throw new SkillBundleError('BUNDLE_DIGEST_MISMATCH', 'Bundle digest does not match its canonical payload');
}
async function readJsonNoFollow(path: string, maxBytes = 64 * 1024): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.mode & 0o022 || before.nlink !== 1 || before.size > maxBytes) throw new Error('Unsafe publication evidence');
    const content = await handle.readFile(); const [after, current] = await Promise.all([handle.stat(), lstat(path)]);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino
      || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || content.byteLength !== before.size) throw new Error('Publication evidence changed while it was read');
    return JSON.parse(content.toString('utf8'));
  } finally { await handle.close(); }
}
async function verifyHeldPublicationReceipt(path: string, held: FileHandle, expected: PublicationReceipt): Promise<void> {
  const [heldInfo, pathnameInfo] = await Promise.all([held.stat(), lstat(path)]);
  if (!heldInfo.isFile() || heldInfo.nlink !== 1 || (heldInfo.mode & 0o7777) !== 0o400
    || !pathnameInfo.isFile() || pathnameInfo.isSymbolicLink() || pathnameInfo.dev !== heldInfo.dev || pathnameInfo.ino !== heldInfo.ino)
    throw new SkillBundleError('SKILL_RECEIPT_MISMATCH', 'Publication receipt inode or permissions changed', 409);
  const actual = publicationReceiptSchema.parse(await readJsonNoFollow(path));
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new SkillBundleError('SKILL_RECEIPT_MISMATCH', 'Publication receipt content changed', 409);
  const after = await lstat(path);
  if (!after.isFile() || after.isSymbolicLink() || after.dev !== heldInfo.dev || after.ino !== heldInfo.ino)
    throw new SkillBundleError('SKILL_RECEIPT_MISMATCH', 'Publication receipt changed while verified', 409);
}
async function verifyTree(directory: string, expected: ReturnType<typeof expectedTree>): Promise<string> {
  const found: Array<{ path: string; mode: 420 | 493; sha256: string }> = [];
  const visit = async (current: string, relative: string): Promise<void> => {
    const directoryHandle = await openSkillDirectoryAnchor(current); const anchor = `/proc/self/fd/${directoryHandle.fd}`;
    try {
      const entries = await readdir(anchor, { withFileTypes: true });
      entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const entry of entries) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (!relative && entry.name === RECEIPT_NAME) continue;
        const path = join(anchor, entry.name); const info = await lstat(path);
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink !== 1))
          throw new SkillBundleError('UNSAFE_SKILL_PATH', 'Published skill contains a link or special file');
        if (info.isDirectory()) await visit(path, child);
        else {
          const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const before = await file.stat();
            if (!before.isFile() || before.nlink !== 1 || before.size > MAX_FILE_BYTES)
              throw new SkillBundleError('UNSAFE_SKILL_PATH', 'Published skill contains an unsafe file');
            const mode = (before.mode & 0o111) ? 0o755 as const : 0o644 as const;
            if ((before.mode & 0o777) !== mode) throw new SkillBundleError('SKILL_TREE_MISMATCH', 'Published skill file mode differs', 409);
            const content = await file.readFile(); const [after, pathname] = await Promise.all([file.stat(), lstat(path)]);
            if (!pathname.isFile() || pathname.isSymbolicLink() || pathname.dev !== before.dev || pathname.ino !== before.ino
              || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs
              || content.byteLength !== before.size) throw new SkillBundleError('SKILL_TREE_MISMATCH', 'Published skill changed while verified', 409);
            found.push({ path: child, mode, sha256: sha256(content) });
          } finally { await file.close(); }
        }
      }
      await assertSkillDirectoryAnchor(current, directoryHandle);
    } finally { await directoryHandle.close(); }
  };
  await visit(directory, ''); found.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (JSON.stringify(found) !== JSON.stringify(expected)) throw new SkillBundleError('SKILL_TREE_MISMATCH', 'Published skill tree differs from the requested bundle', 409);
  return treeSha256(found);
}
async function syncTreeDirectories(directory: string, rootHandle?: FileHandle): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await syncTreeDirectories(join(directory, entry.name));
  }
  if (rootHandle) await rootHandle.sync(); else await syncDirectory(directory);
}
async function existingReceipt(installDir: string, body: SkillPublicationBody, context: ManagedExecutionContext): Promise<PublicationReceipt> {
  await assertOwnedDirectory(installDir);
  const receiptPath = join(installDir, RECEIPT_NAME); const receiptHandle = await open(receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let receipt: PublicationReceipt;
  try {
    receipt = publicationReceiptSchema.parse(await readJsonNoFollow(receiptPath));
    await verifyHeldPublicationReceipt(receiptPath, receiptHandle, receipt);
  } finally { await receiptHandle.close(); }
  if (receipt.skillName !== body.skillName || receipt.skillVersion !== body.version || receipt.bundleSha256 !== body.bundleSha256
    || receipt.commandId !== context.commandId || receipt.requestSha256 !== context.requestSha256)
    throw new SkillBundleError('SKILL_VERSION_EXISTS', 'Skill version is bound to another immutable publication', 409);
  if (await verifyTree(installDir, expectedTree(body)) !== receipt.treeSha256)
    throw new SkillBundleError('SKILL_TREE_MISMATCH', 'Published skill receipt differs from its files', 409);
  return receipt;
}

async function discardExactStage(stage: string, body: SkillPublicationBody, context: ManagedExecutionContext): Promise<void> {
  await assertOwnedDirectory(stage);
  const names = (await readdir(stage)).sort();
  if (names.length === 0) { await rm(stage, { recursive: true }); return; }
  if (!names.includes('journal.json')) {
    if (names.length !== 1 || !/^journal\.json\.write-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(names[0]!))
      throw new Error('Publication stage lacks exact journal evidence');
    const residue = await open(join(stage, names[0]!), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await residue.stat();
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o400 || info.size > 64 * 1024
        || (process.getuid && info.uid !== process.getuid()))
        throw new Error('Publication journal residue is unsafe');
    } finally { await residue.close(); }
    await rm(stage, { recursive: true }); return;
  }
  if (names.some(name => !['journal.json', 'payload', 'container'].includes(name)))
    throw new Error('Publication stage contains unrecognized state');
  const journal = journalSchema.parse(await readJsonNoFollow(join(stage, 'journal.json')));
  if (journal.commandId !== context.commandId || journal.requestSha256 !== context.requestSha256
    || journal.skillName !== body.skillName || journal.skillVersion !== body.version || journal.bundleSha256 !== body.bundleSha256
    || journal.treeSha256 !== treeSha256(expectedTree(body))) throw new Error('Publication stage belongs to another request');
  if (names.includes('payload')) {
    await assertOwnedDirectory(join(stage, 'payload'));
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name); const info = await lstat(path);
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink !== 1))
          throw new Error('Publication stage contains a link or special file');
        if (info.isDirectory()) await visit(path);
      }
    };
    await visit(join(stage, 'payload'));
  }
  if (names.includes('container')) {
    const container = join(stage, 'container'); await assertOwnedDirectory(container);
    const containerNames = (await readdir(container)).sort();
    if (names.includes('payload') && containerNames.length === 0) {
      // Crash after the private container mkdir but before the private payload rename.
    } else if (!names.includes('payload') && JSON.stringify(containerNames) === JSON.stringify([body.version])) {
      await existingReceipt(join(container, body.version), body, context);
    } else {
      throw new Error('Staged skill container differs from the exact publication');
    }
  }
  await rm(stage, { recursive: true });
}

async function rollbackExactVisible(path: string, owned: FileHandle, stage: string): Promise<void> {
  await assertSkillDirectoryAnchor(path, owned);
  const rollback = join(stage, 'rollback');
  try { await lstat(rollback); throw new Error('Rollback destination already exists'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await rename(path, rollback); await assertSkillDirectoryAnchor(rollback, owned);
  await rm(rollback, { recursive: true }); await syncDirectory(stage);
}

export interface SkillPublicationHooks {
  /** Package-test seam; HTTP callers cannot supply hooks. */
  beforeVisibility?: () => void | Promise<void>;
  afterVisibility?: () => void | Promise<void>;
}

export async function publishSkillBundle(bodyInput: unknown, context: ManagedExecutionContext, rootInput: string,
  hooks: SkillPublicationHooks = {}): Promise<ReturnType<typeof response>> {
  const body = skillPublicationBodySchema.parse(bodyInput); assertBinding(body, context);
  const configuredRoot = await openConfiguredRoot(rootInput, true); const root = configuredRoot.path; const rootHandle = configuredRoot.handle;
  const rootAnchor = `/proc/self/fd/${rootHandle.fd}`;
  const mutex = await acquire(rootAnchor);
  const stage = join(rootAnchor, `.skill-publish-${sha256(`${context.commandId}\0${context.requestSha256}`)}`);
  const payload = join(stage, 'payload'); const configuredSkillDir = join(root, body.skillName);
  let skillHandle: FileHandle | undefined; let payloadHandle: FileHandle | undefined; let receiptHandle: FileHandle | undefined;
  let containerHandle: FileHandle | undefined; let createdStage = false;
  try {
    await assertConfiguredRoot(root, rootHandle);
    skillHandle = await optionalOwnedDirectory(join(rootAnchor, body.skillName));
    if (skillHandle) {
      await assertSkillDirectoryAnchor(configuredSkillDir, skillHandle);
      try {
        const result = response(await existingReceipt(join(`/proc/self/fd/${skillHandle.fd}`, body.version), body, context));
        try { await discardExactStage(stage, body, context); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        return result;
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    try { await lstat(stage); throw new SkillBundleError('SKILL_PUBLICATION_UNCERTAIN', 'Existing publication stage requires exact recovery', 409); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const tree = treeSha256(expectedTree(body));
    await mkdir(stage, { mode: 0o700 }); createdStage = true;
    await atomicJson(join(stage, 'journal.json'), { version: 1, state: 'staged', skillName: body.skillName, skillVersion: body.version,
      bundleSha256: body.bundleSha256, treeSha256: tree, commandId: context.commandId, requestSha256: context.requestSha256 }, 0o400);
    await mkdir(payload, { mode: 0o755 }); payloadHandle = await openSkillDirectoryAnchor(payload);
    const payloadAnchor = `/proc/self/fd/${payloadHandle.fd}`;
    for (const entry of body.bundle.entries) {
      const target = join(payloadAnchor, entry.path); await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, entry.mode);
      try { await file.writeFile(Buffer.from(entry.contentBase64, 'base64')); await file.chmod(entry.mode); await file.sync(); } finally { await file.close(); }
    }
    if (await verifyTree(payload, expectedTree(body)) !== tree) throw new Error('Staged tree digest differs');
    const receipt: PublicationReceipt = { version: 1, skillName: body.skillName, skillVersion: body.version,
      bundleSha256: body.bundleSha256, treeSha256: tree, commandId: context.commandId, requestSha256: context.requestSha256,
      nodeId: context.claim.nodeId, publishedAt: new Date().toISOString() };
    const stagedReceipt = join(payloadAnchor, RECEIPT_NAME);
    await atomicJson(stagedReceipt, receipt, 0o400, payloadHandle);
    receiptHandle = await open(stagedReceipt, constants.O_RDONLY | constants.O_NOFOLLOW);
    await verifyHeldPublicationReceipt(stagedReceipt, receiptHandle, receipt);
    await syncTreeDirectories(payload, payloadHandle); await syncDirectory(stage);
    // This is the last no-effect point. Recheck authority and every owning
    // directory immediately before the single atomic visibility change.
    assertBinding(body, context); await assertConfiguredRoot(root, rootHandle);
    if (skillHandle) {
      await assertSkillDirectoryAnchor(configuredSkillDir, skillHandle);
      const skillAnchor = `/proc/self/fd/${skillHandle.fd}`; const installDir = join(skillAnchor, body.version);
      try { await lstat(installDir); throw new SkillBundleError('SKILL_VERSION_EXISTS', 'Skill version appeared before publication', 409); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await hooks.beforeVisibility?.(); await assertSkillDirectoryAnchor(payload, payloadHandle);
      await verifyHeldPublicationReceipt(join(payload, RECEIPT_NAME), receiptHandle, receipt);
      assertBinding(body, context); await assertConfiguredRoot(root, rootHandle); await assertSkillDirectoryAnchor(configuredSkillDir, skillHandle);
      await rename(payload, installDir); await skillHandle.sync();
      try {
        await hooks.afterVisibility?.(); await assertConfiguredRoot(root, rootHandle);
        await assertSkillDirectoryAnchor(configuredSkillDir, skillHandle); await assertSkillDirectoryAnchor(installDir, payloadHandle);
        await verifyHeldPublicationReceipt(join(installDir, RECEIPT_NAME), receiptHandle, receipt);
        if (await verifyTree(installDir, expectedTree(body)) !== tree) throw new Error('Published tree digest differs after commit');
      } catch (error) { await rollbackExactVisible(installDir, payloadHandle, stage); throw error; }
    } else {
      try { await lstat(join(rootAnchor, body.skillName)); throw new SkillBundleError('SKILL_VERSION_EXISTS', 'Skill identity appeared before publication', 409); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const container = join(stage, 'container'); await mkdir(container, { mode: 0o755 }); containerHandle = await openSkillDirectoryAnchor(container);
      await rename(payload, join(container, body.version)); await syncDirectory(container);
      const stagedVersion = join(`/proc/self/fd/${containerHandle.fd}`, body.version);
      await assertSkillDirectoryAnchor(stagedVersion, payloadHandle);
      await hooks.beforeVisibility?.();
      await assertSkillDirectoryAnchor(stagedVersion, payloadHandle);
      await verifyHeldPublicationReceipt(join(stagedVersion, RECEIPT_NAME), receiptHandle, receipt);
      assertBinding(body, context); await assertConfiguredRoot(root, rootHandle);
      const visibleSkill = join(rootAnchor, body.skillName);
      await assertSkillDirectoryAnchor(container, containerHandle); await rename(container, visibleSkill); await rootHandle.sync();
      try {
        await hooks.afterVisibility?.(); await assertConfiguredRoot(root, rootHandle);
        await assertSkillDirectoryAnchor(configuredSkillDir, containerHandle);
        const publishedVersion = join(`/proc/self/fd/${containerHandle.fd}`, body.version);
        await assertSkillDirectoryAnchor(publishedVersion, payloadHandle);
        await verifyHeldPublicationReceipt(join(publishedVersion, RECEIPT_NAME), receiptHandle, receipt);
        if (await verifyTree(publishedVersion, expectedTree(body)) !== tree) throw new Error('Published tree digest differs after commit');
      } catch (error) { await rollbackExactVisible(visibleSkill, containerHandle, stage); throw error; }
    }
    return response(receipt);
  } finally {
    if (createdStage) await discardExactStage(stage, body, context).catch(() => {});
    await receiptHandle?.close(); await containerHandle?.close(); await payloadHandle?.close(); await skillHandle?.close(); await mutex.close(); await rootHandle.close();
  }
}

export type SkillRecovery = { status: number; body: string };
export function skillPublicationNotCommitted(body: SkillPublicationBody, context: ManagedExecutionContext): SkillRecovery {
  return { status: 409, body: JSON.stringify({ success: false, error: { code: 'SKILL_PUBLICATION_NOT_COMMITTED',
    message: 'The interrupted publication committed no visible skill version' }, data: { skillName: body.skillName,
    version: body.version, bundleSha256: body.bundleSha256, commandId: context.commandId,
    requestSha256: context.requestSha256, effect: 'none' } }) };
}
export async function recoverSkillPublication(bodyInput: unknown, context: ManagedExecutionContext, rootInput: string): Promise<SkillRecovery> {
  const body = skillPublicationBodySchema.parse(bodyInput);
  if (skillBundleSha256(body.bundle) !== body.bundleSha256) throw new Error('Recovery bundle identity differs');
  const configuredRoot = await openConfiguredRoot(rootInput, true); const root = configuredRoot.path; const rootHandle = configuredRoot.handle;
  const rootAnchor = `/proc/self/fd/${rootHandle.fd}`; const mutex = await acquire(rootAnchor);
  const stage = join(rootAnchor, `.skill-publish-${sha256(`${context.commandId}\0${context.requestSha256}`)}`);
  let skillHandle: FileHandle | undefined;
  try {
    await assertConfiguredRoot(root, rootHandle); skillHandle = await optionalOwnedDirectory(join(rootAnchor, body.skillName));
    if (skillHandle) {
      await assertSkillDirectoryAnchor(join(root, body.skillName), skillHandle);
      try {
        const result = response(await existingReceipt(join(`/proc/self/fd/${skillHandle.fd}`, body.version), body, context));
        try { await discardExactStage(stage, body, context); await rootHandle.sync(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        return { status: 200, body: JSON.stringify(result) };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    try {
      await discardExactStage(stage, body, context); await rootHandle.sync();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await assertConfiguredRoot(root, rootHandle);
    return skillPublicationNotCommitted(body, context);
  } finally { await skillHandle?.close(); await mutex.close(); await rootHandle.close(); }
}
