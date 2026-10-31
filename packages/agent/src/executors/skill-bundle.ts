/** Bounded archive decoding; filesystem writes use only validated regular entries. */
import { gunzipSync } from 'node:zlib';
import { extract } from 'tar-stream';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 2048;
export class SkillBundleError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 409 | 500 = 400) { super(message); }
}
function archivePath(name: string, directory: boolean): string {
  if (name.length > 4096 || /[\\\x00-\x1f\x7f:]/.test(name) || name.startsWith('/'))
    throw new SkillBundleError('UNSAFE_SKILL_ARCHIVE', 'Archive member path is unsafe');
  while (name.startsWith('./')) name = name.slice(2);
  if (directory) name = name.replace(/\/+$/, '');
  if ((name === '' || name === '.') && directory) return '';
  const segments = name.split('/');
  if (segments.length > 32 || segments.some(p => !p || p === '.' || p === '..' || Buffer.byteLength(p) > 255))
    throw new SkillBundleError('UNSAFE_SKILL_ARCHIVE', 'Archive member path is not a contained relative path');
  return segments.join('/');
}

export async function extractSkillBundle(bundle: Buffer, destination: string): Promise<void> {
  const parser = extract();
  const entries = new Map<string, { directory: boolean; mode: number; body: Buffer }>();
  let count = 0; let bytes = 0;
  try {
    // Bound expansion before the parser sees metadata or file contents. No shell
    // extractor runs, and nothing is written until all effective paths are checked.
    const expanded = gunzipSync(bundle, { maxOutputLength: MAX_EXPANDED_BYTES });
    parser.end(expanded);
    for await (const entry of parser) {
      const header = entry.header;
      if (++count > MAX_ENTRIES) throw new SkillBundleError('SKILL_BUNDLE_TOO_LARGE', 'Skill bundle has too many entries');
      if (typeof header.type !== 'string' || !['file', 'directory'].includes(header.type) || header.linkname)
        throw new SkillBundleError('UNSAFE_SKILL_ARCHIVE', 'Links and special files are not allowed in skill bundles');
      const directory = header.type === 'directory';
      const name = archivePath(header.name, directory);
      if (typeof header.size !== 'number' || !Number.isSafeInteger(header.size) || header.size < 0 || header.size > MAX_EXPANDED_BYTES || (directory && header.size !== 0))
        throw new SkillBundleError('UNSAFE_SKILL_ARCHIVE', 'Archive member size is invalid');
      if (typeof header.mode !== 'number' || !Number.isSafeInteger(header.mode) || header.mode < 0 || header.mode > 0o7777)
        throw new SkillBundleError('UNSAFE_SKILL_ARCHIVE', 'Archive member mode is invalid');
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of entry) {
        if (!(chunk instanceof Uint8Array)) throw new SkillBundleError('UNSAFE_SKILL_ARCHIVE', 'Archive emitted invalid content');
        size += chunk.length; bytes += chunk.length;
        if (size > header.size || bytes > MAX_EXPANDED_BYTES) throw new SkillBundleError('SKILL_BUNDLE_TOO_LARGE', 'Skill bundle exceeds its expanded size limit');
        chunks.push(Buffer.from(chunk));
      }
      if (size !== header.size) throw new SkillBundleError('UNSAFE_SKILL_ARCHIVE', 'Archive member is truncated');
      if (!name) continue;
      if (entries.has(name)) throw new SkillBundleError('UNSAFE_SKILL_ARCHIVE', 'Duplicate archive member');
      entries.set(name, { directory, mode: directory || (header.mode & 0o111) ? 0o755 : 0o644, body: Buffer.concat(chunks) });
    }
    for (const name of entries.keys()) {
      const parts = name.split('/');
      for (let i = 1; i < parts.length; i++) {
        if (entries.get(parts.slice(0, i).join('/'))?.directory === false)
          throw new SkillBundleError('UNSAFE_SKILL_ARCHIVE', 'Archive file conflicts with a parent directory');
      }
    }
    for (const [name, entry] of entries) {
      const target = join(destination, name);
      if (entry.directory) { await mkdir(target, { recursive: true, mode: 0o755 }); continue; }
      await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, entry.mode);
      try { await file.writeFile(entry.body); } finally { await file.close(); }
    }
  } catch (error) {
    if (error instanceof SkillBundleError) throw error;
    throw new SkillBundleError('SKILL_EXTRACT_ERROR', 'Skill archive could not be safely decoded');
  } finally { parser.destroy(); }
}
