import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';

// ─── Skill manifest shape (mirrors skills/<name>/manifest.json) ───

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  entryPoint: string;
  dependencies: string[];
  tags: string[];
}

export interface SkillDetail extends SkillManifest {
  /** All file names within the skill directory */
  files: string[];
}

// ─── Helpers ───

import { getSkillsDir as getPackageSkillsDir } from '@hivemagnus/magnus-skills';
import { SKILL_FILE_NAME_PATTERN, SKILL_NAME_PATTERN } from '../schemas/skills.js';

/** Skills directory — uses SKILLS_DIR env var or the magnus-skills package path */
export function getSkillsDir(): string {
  return process.env['SKILLS_DIR'] ?? getPackageSkillsDir();
}

const SAFE_VERSION_TEXT = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/** One path segment: no separator, no NUL, and neither `.` nor `..`. */
function isPathSegment(value: string): boolean {
  return value.length > 0 && value.length <= 255 && value !== '.' && value !== '..' && !/[/\\\0]/.test(value);
}

/** Refused before any path is built, so a name can never reach outside the skills directory. */
export class InvalidSkillPathError extends Error {
  readonly status = 400;
  readonly code = 'VALIDATION_ERROR';
}

/**
 * The directory of one skill. The name is one plain path segment, so the result is always a
 * direct child of the skills directory. Names from older installs may hold dots or spaces and
 * stay readable; path separators, `.` and `..` are never accepted.
 */
function skillDir(skillName: string): string {
  if (!isPathSegment(skillName)) throw new InvalidSkillPathError('Invalid skill name');
  return path.join(getSkillsDir(), skillName);
}

function manifestPath(skillName: string): string {
  return path.join(skillDir(skillName), 'manifest.json');
}

/** A file directly inside a skill directory. */
function skillFilePath(skillName: string, fileName: string): string {
  if (!isPathSegment(fileName)) throw new InvalidSkillPathError('Invalid skill file name');
  return path.join(skillDir(skillName), fileName);
}

async function readManifest(skillName: string): Promise<SkillManifest> {
  const raw = await fs.readFile(manifestPath(skillName), 'utf-8');
  return JSON.parse(raw) as SkillManifest;
}

async function writeManifest(skillName: string, manifest: SkillManifest): Promise<void> {
  await fs.writeFile(manifestPath(skillName), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

async function listFilesInDir(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => e.name);
}

// ─── Public API ───

/** List all skills by scanning the skills directory for manifest.json files. */
export async function listSkills(): Promise<SkillDetail[]> {
  const dir = getSkillsDir();

  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // Skills dir doesn't exist yet
    return [];
  }

  const skills: SkillDetail[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = await readManifest(entry.name);
      const files = await listFilesInDir(path.join(dir, entry.name));
      skills.push({ ...manifest, files });
    } catch {
      // Skip directories without valid manifest
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** Get a single skill by name. Returns null if not found. */
export async function getSkill(name: string): Promise<SkillDetail | null> {
  try {
    const manifest = await readManifest(name);
    const files = await listFilesInDir(skillDir(name));
    return { ...manifest, files };
  } catch {
    return null;
  }
}

/** Read a specific file from a skill directory. */
export async function getSkillFile(skillName: string, fileName: string): Promise<string | null> {
  try {
    return await fs.readFile(skillFilePath(skillName, fileName), 'utf-8');
  } catch {
    return null;
  }
}

/** Create a new skill directory with manifest.json and optional entry point. */
export async function createSkill(data: {
  name: string;
  version: string;
  description?: string;
  author?: string;
  entryPoint?: string;
  dependencies?: string[];
  tags?: string[];
}): Promise<SkillDetail> {
  if (!SKILL_NAME_PATTERN.test(data.name)) throw new InvalidSkillPathError('A skill name may contain only letters, digits, underscores and hyphens');
  const dir = skillDir(data.name);
  // Resolved before anything is created, so a refused entry point leaves no half-made skill.
  const entryPoint = data.entryPoint ?? 'run.sh';
  if (!SKILL_FILE_NAME_PATTERN.test(entryPoint)) throw new InvalidSkillPathError('Invalid skill entry point');
  const entryPath = skillFilePath(data.name, entryPoint);

  // Ensure directory doesn't already exist
  try {
    await fs.access(dir);
    throw new Error(`Skill "${data.name}" already exists`);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('already exists')) throw err;
    // ENOENT is expected — proceed
  }

  await fs.mkdir(dir, { recursive: true });

  const manifest: SkillManifest = {
    name: data.name,
    version: data.version,
    description: data.description ?? '',
    author: data.author ?? '',
    entryPoint: data.entryPoint ?? 'run.sh',
    dependencies: data.dependencies ?? [],
    tags: data.tags ?? [],
  };

  await writeManifest(data.name, manifest);

  // Create a stub entry point if it doesn't exist
  try {
    await fs.access(entryPath);
  } catch {
    // The script quotes the name and version, so only text that is safe inside a shell string goes in.
    const label = SAFE_VERSION_TEXT.test(data.version) ? `${data.name} v${data.version}` : data.name;
    await fs.writeFile(entryPath, `#!/usr/bin/env bash\nset -euo pipefail\n\n# ${data.name} — entry point\necho "${label}"\n`, 'utf-8');
    await fs.chmod(entryPath, 0o755);
  }

  const files = await listFilesInDir(dir);
  return { ...manifest, files };
}

/** Update a skill's manifest fields. */
export async function updateSkill(
  name: string,
  data: Partial<Omit<SkillManifest, 'name'>>,
): Promise<SkillDetail> {
  const manifest = await readManifest(name);

  if (data.version !== undefined) manifest.version = data.version;
  if (data.description !== undefined) manifest.description = data.description;
  if (data.author !== undefined) manifest.author = data.author;
  if (data.entryPoint !== undefined) {
    if (!SKILL_FILE_NAME_PATTERN.test(data.entryPoint)) throw new InvalidSkillPathError('Invalid skill entry point');
    manifest.entryPoint = data.entryPoint;
  }
  if (data.dependencies !== undefined) manifest.dependencies = data.dependencies;
  if (data.tags !== undefined) manifest.tags = data.tags;

  await writeManifest(name, manifest);

  const files = await listFilesInDir(skillDir(name));
  return { ...manifest, files };
}

/** Update (or create) a file within a skill directory. */
export async function updateSkillFile(
  skillName: string,
  fileName: string,
  content: string,
): Promise<void> {
  await fs.writeFile(skillFilePath(skillName, fileName), content, 'utf-8');
}

/** Delete a skill directory entirely. */
export async function deleteSkill(name: string): Promise<void> {
  const dir = skillDir(name);
  await fs.rm(dir, { recursive: true, force: true });
}
