/**
 * HiveSkills release archives as Magnus installs them onto Ardent profiles (the skill-install action).
 * A release archive is a gzip-compressed ustar archive of regular files and directories with a root
 * SKILL.md, the format HiveSkills publishes and its Hermes bridge extracts. These checks work on the
 * uncompressed tar bytes, so they need no Node APIs: callers gunzip with an output limit of
 * ARDENT_SKILL_ARCHIVE_LIMITS.unpackedBytes first. The control API checks an archive before it is
 * dispatched and the node agent checks it again before anything is written.
 */
import { z } from 'zod';

/** Bounds of an archive Magnus installs onto an Ardent profile. Ardent reads SKILL.md, at most 64 KiB. */
export const ARDENT_SKILL_ARCHIVE_LIMITS = {
  /** The compressed archive, as published by HiveSkills. */
  archiveBytes: 1024 * 1024,
  /** The uncompressed tar stream. */
  unpackedBytes: 4 * 1024 * 1024,
  fileBytes: 1024 * 1024,
  entries: 256,
  skillMdBytes: 65_536,
} as const;
/** The file Magnus writes into each skill directory it installs; it marks the skill as replaceable by a later install. */
export const ARDENT_SKILL_RECEIPT_FILE = '.hiveskills.json';
/** What the receipt file records. */
export const ardentSkillReceiptSchema = z.object({
  schema_version: z.literal(1), source: z.literal('hiveskills'), name: z.string(), version: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u), installed_at: z.string(),
}).strict();
export type ArdentSkillReceipt = z.infer<typeof ardentSkillReceiptSchema>;

export interface SkillArchiveEntry { name: string; directory: boolean; bytes: Uint8Array }

const decoder = new TextDecoder('utf-8', { fatal: true });
const text = (block: Uint8Array, start: number, length: number) => {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return decoder.decode(end < 0 ? field : field.subarray(0, end));
};

/**
 * The entries of an uncompressed skill tar, with every safety check HiveSkills applies (checksums,
 * regular files and directories only, relative paths without `.` or `..`, no duplicates, a non-empty
 * root SKILL.md, no file overlapping a directory) plus the Ardent install bounds. Throws on any failure.
 */
export function readSkillTar(tar: Uint8Array): SkillArchiveEntry[] {
  if (tar.length > ARDENT_SKILL_ARCHIVE_LIMITS.unpackedBytes) throw new Error('Skill archive exceeds the unpacked size limit');
  const entries: SkillArchiveEntry[] = [];
  const names = new Set<string>();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every(byte => byte === 0)) break;
    let checksum = 0;
    for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : block[index]!;
    if (checksum !== Number.parseInt(text(block, 148, 8).trim(), 8)) throw new Error('Invalid tar checksum');
    const rawSize = text(block, 124, 12).trim();
    if (!/^[0-7]+$/u.test(rawSize)) throw new Error('Invalid tar size');
    const size = Number.parseInt(rawSize, 8);
    const type = text(block, 156, 1);
    if (!['', '0', '5'].includes(type)) throw new Error('Only regular files and directories are allowed');
    const prefix = text(block, 345, 155);
    const name = ((prefix ? `${prefix}/` : '') + text(block, 0, 100)).replace(/^(\.\/)+/u, '').replace(/\/$/u, '');
    offset += 512;
    if (size > ARDENT_SKILL_ARCHIVE_LIMITS.fileBytes || offset + size > tar.length || (type === '5' && size !== 0))
      throw new Error('Invalid or excessive unpacked file size');
    if (name) {
      if (name.startsWith('/') || name.includes('\\') || /[\x00-\x1f\x7f]/u.test(name)
        || name.split('/').some(part => !part || part === '.' || part === '..') || names.has(name))
        throw new Error('Unsafe or duplicate archive path');
      if (name === ARDENT_SKILL_RECEIPT_FILE) throw new Error(`${ARDENT_SKILL_RECEIPT_FILE} is reserved for the install receipt`);
      names.add(name);
      entries.push({ name, directory: type === '5', bytes: tar.subarray(offset, offset + size) });
      if (entries.length > ARDENT_SKILL_ARCHIVE_LIMITS.entries) throw new Error('Skill archive has too many entries');
    }
    offset += Math.ceil(size / 512) * 512;
  }
  if (!entries.some(entry => entry.name === 'SKILL.md' && !entry.directory && entry.bytes.length > 0)) throw new Error('Skill archive must have a root SKILL.md');
  for (const entry of entries) {
    const parts = entry.name.split('/');
    for (let index = 1; index < parts.length; index++) {
      const parent = entries.find(candidate => candidate.name === parts.slice(0, index).join('/'));
      if (parent && !parent.directory) throw new Error('Archive file overlaps a directory');
    }
  }
  return entries;
}

/** The YAML front matter of a SKILL.md, read the way Ardent reads it, or null when there is none. */
export function skillFrontmatterBlock(skillMd: string): string | null {
  if (!skillMd.startsWith('---\n')) return null;
  const end = skillMd.indexOf('\n---\n', 4);
  return end < 0 || end > 8192 ? null : skillMd.slice(4, end);
}
/** The front matter Ardent indexes: a skill appears only when `name` equals its directory name. */
export const ardentSkillFrontmatterSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u), description: z.string().min(1).max(500),
}).passthrough();

/**
 * Check an uncompressed skill tar for installation as `name` on an Ardent profile: the archive rules,
 * a UTF-8 SKILL.md within Ardent's 64 KiB, and front matter Ardent indexes under that name.
 * `parseYaml` is the caller's YAML parser. Answers the number of files and the SKILL.md text.
 */
export function checkArdentSkillArchive(tar: Uint8Array, name: string, parseYaml: (source: string) => unknown): { files: number; skillMd: string } {
  const entries = readSkillTar(tar);
  const skill = entries.find(entry => entry.name === 'SKILL.md')!;
  if (skill.bytes.length > ARDENT_SKILL_ARCHIVE_LIMITS.skillMdBytes) throw new Error('SKILL.md exceeds the 64 KiB Ardent reads');
  let skillMd: string;
  try { skillMd = decoder.decode(skill.bytes); } catch { throw new Error('SKILL.md is not UTF-8'); }
  const block = skillFrontmatterBlock(skillMd);
  if (block === null) throw new Error('SKILL.md has no front matter');
  let metadata: unknown;
  try { metadata = parseYaml(block); } catch { throw new Error('SKILL.md front matter is not valid YAML'); }
  const parsed = ardentSkillFrontmatterSchema.safeParse(metadata);
  if (!parsed.success) throw new Error('SKILL.md front matter needs a name and a description of at most 500 characters');
  if (parsed.data.name !== name) throw new Error(`SKILL.md names the skill ${parsed.data.name}, not ${name}`);
  return { files: entries.filter(entry => !entry.directory).length, skillMd };
}
