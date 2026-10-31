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

/** Skills directory — uses SKILLS_DIR env var or the magnus-skills package path */
export function getSkillsDir(): string {
  return process.env['SKILLS_DIR'] ?? getPackageSkillsDir();
}

function manifestPath(skillName: string): string {
  return path.join(getSkillsDir(), skillName, 'manifest.json');
}

function skillDir(skillName: string): string {
  return path.join(getSkillsDir(), skillName);
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
    const filePath = path.join(skillDir(skillName), fileName);
    // Prevent directory traversal
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(skillDir(skillName)))) return null;
    return await fs.readFile(filePath, 'utf-8');
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
  const dir = skillDir(data.name);

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
  const entryPath = path.join(dir, manifest.entryPoint);
  try {
    await fs.access(entryPath);
  } catch {
    await fs.writeFile(entryPath, `#!/usr/bin/env bash\nset -euo pipefail\n\n# ${data.name} — entry point\necho "${data.name} v${data.version}"\n`, 'utf-8');
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
  if (data.entryPoint !== undefined) manifest.entryPoint = data.entryPoint;
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
  const filePath = path.join(skillDir(skillName), fileName);
  // Prevent directory traversal
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(skillDir(skillName)))) {
    throw new Error('Invalid file path');
  }
  await fs.writeFile(filePath, content, 'utf-8');
}

/** Delete a skill directory entirely. */
export async function deleteSkill(name: string): Promise<void> {
  const dir = skillDir(name);
  await fs.rm(dir, { recursive: true, force: true });
}
