import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { getSkillsDir } from './skill-service.js';

const MAX_FILES = 256;
const MAX_BYTES = 3 * 1024 * 1024;

const safeSegment = z.string().min(1).max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/)
  .refine(value => value !== '.' && value !== '..' && !value.includes('..'), 'Unsafe skill identity');
const registryFileSchema = z.object({
  path: z.string().min(1).max(240),
  size: z.number().int().nonnegative().max(MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export interface SkillBundleEntry {
  path: string;
  mode: 420 | 493;
  sha256: string;
  contentBase64: string;
}

export interface SkillPublicationBundle {
  skillName: string;
  version: string;
  registryContentSha256: string;
  bundleSha256: string;
  treeSha256: string;
  bundle: {
    format: 'magnus-skill-bundle-v1';
    entries: SkillBundleEntry[];
  };
}

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

function safeRelativeFile(value: string): string {
  if (value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || value.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('Published skill version contains an unsafe file path');
  }
  return value;
}

/**
 * Snapshot exactly the files retained by the immutable registry version.
 * The managed node request carries the bytes, so publication never depends on
 * a mutable download URL or on a second unauthenticated fetch.
 */
export async function buildSkillPublicationBundle(input: {
  skillName: string;
  version: string;
  registryContentSha256: string;
  registryFilesJson: string;
}): Promise<SkillPublicationBundle> {
  const skillName = safeSegment.parse(input.skillName);
  const version = safeSegment.parse(input.version);
  if (!/^[a-f0-9]{64}$/.test(input.registryContentSha256)) throw new Error('Published skill version digest is invalid');
  const registryFiles = z.array(registryFileSchema).min(1).max(MAX_FILES).parse(JSON.parse(input.registryFilesJson));
  if (new Set(registryFiles.map(file => safeRelativeFile(file.path))).size !== registryFiles.length)
    throw new Error('Published skill version contains duplicate files');
  if (!registryFiles.some(file => file.path === 'manifest.json')) throw new Error('Published skill version lacks manifest.json');
  // The registry stores the exact order used by its existing content-hash
  // producer. The wire bundle separately uses code-unit order.
  const registryDigest = sha256(registryFiles.map(file => `${file.path}:${file.sha256}`).join('\n'));
  if (registryDigest !== input.registryContentSha256) throw new Error('Published skill registry digest differs from its file index');
  const files = [...registryFiles].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  const root = await realpath(getSkillsDir());
  const skillRoot = await realpath(path.join(root, skillName));
  if (skillRoot !== path.join(root, skillName)) throw new Error('Published skill source must not traverse a symbolic link');
  const entries: SkillBundleEntry[] = [];
  let totalBytes = 0;
  for (const expected of files) {
    const relative = safeRelativeFile(expected.path);
    const absolute = path.join(skillRoot, ...relative.split('/'));
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size !== expected.size || before.mode & 0o6022)
        throw new Error('Published skill source file type, size, link count or mode is unsafe');
      totalBytes += before.size;
      if (totalBytes > MAX_BYTES) throw new Error('Published skill bundle exceeds the bounded payload size');
      const content = await handle.readFile();
      const after = await handle.stat();
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs || content.byteLength !== before.size)
        throw new Error('Published skill source changed while it was captured');
      const contentSha256 = sha256(content);
      if (contentSha256 !== expected.sha256) throw new Error('Published skill source differs from its immutable registry version');
      entries.push({ path: relative, mode: before.mode & 0o111 ? 493 : 420,
        sha256: contentSha256, contentBase64: content.toString('base64') });
    } finally {
      await handle.close();
    }
  }
  const manifestEntry = entries.find(entry => entry.path === 'manifest.json')!;
  const manifest = z.object({ name: z.literal(skillName), version: z.literal(version) }).passthrough()
    .parse(JSON.parse(Buffer.from(manifestEntry.contentBase64, 'base64').toString('utf8')));
  void manifest;
  const bundle = { format: 'magnus-skill-bundle-v1' as const, entries };
  const bundleSha256 = sha256(JSON.stringify(bundle));
  const treeSha256 = sha256(JSON.stringify({ format: 'magnus-skill-tree-v1',
    entries: entries.map(({ path: filePath, mode, sha256: fileSha256 }) => ({ path: filePath, mode, sha256: fileSha256 })) }));
  return { skillName, version, registryContentSha256: input.registryContentSha256,
    bundleSha256, treeSha256, bundle };
}
