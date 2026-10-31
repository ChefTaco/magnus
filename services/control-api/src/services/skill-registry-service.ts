import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getDb } from '../db/index.js';
import * as skillService from './skill-service.js';

// ─── Helpers ───

/** Compute SHA-256 of content string. */
function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/** Default skills directory — same as skill-service */
const DEFAULT_SKILLS_DIR = path.resolve(import.meta.dirname, '../../skills');

function getSkillsDir(): string {
  return process.env['SKILLS_DIR'] ?? DEFAULT_SKILLS_DIR;
}

// ─── Registry API ───

/**
 * List all registry entries with version count, tag count, and install count.
 * Merges filesystem skills that have no registry entry yet.
 */
export async function listRegistryEntries(): Promise<unknown[]> {
  const db = getDb();

  const entries = await db.skillRegistryEntry.findMany({
    orderBy: { slug: 'asc' },
    include: {
      versions: { orderBy: { createdAt: 'desc' }, take: 5 },
      tags: true,
      installations: { select: { nodeId: true, status: true, version: true } },
    },
  });

  return entries.map((e) => ({
    id: e.id,
    slug: e.slug,
    displayName: e.displayName,
    description: e.description,
    author: e.author,
    source: e.source,
    sourceUrl: e.sourceUrl,
    entryPoint: e.entryPoint,
    dependencies: JSON.parse(e.dependencies as string) as string[],
    metadata: JSON.parse(e.metadata as string) as Record<string, unknown>,
    latestVersion: e.latestVersion,
    status: e.status,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    versionCount: e.versions.length,
    versions: e.versions.map(formatVersion),
    tags: e.tags.map((t) => ({
      id: t.id,
      tag: t.tag,
      versionId: t.versionId,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    })),
    installations: e.installations.map((i) => ({
      nodeId: i.nodeId,
      status: i.status,
      version: i.version,
    })),
  }));
}

/** Get a single registry entry by slug with full version history. */
export async function getRegistryEntry(slug: string): Promise<unknown | null> {
  const db = getDb();

  const entry = await db.skillRegistryEntry.findUnique({
    where: { slug },
    include: {
      versions: { orderBy: { createdAt: 'desc' } },
      tags: true,
      installations: { select: { nodeId: true, status: true, version: true } },
    },
  });

  if (!entry) return null;

  return {
    id: entry.id,
    slug: entry.slug,
    displayName: entry.displayName,
    description: entry.description,
    author: entry.author,
    source: entry.source,
    sourceUrl: entry.sourceUrl,
    entryPoint: entry.entryPoint,
    dependencies: JSON.parse(entry.dependencies as string) as string[],
    metadata: JSON.parse(entry.metadata as string) as Record<string, unknown>,
    latestVersion: entry.latestVersion,
    status: entry.status,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
    versions: entry.versions.map(formatVersion),
    tags: entry.tags.map((t) => ({
      id: t.id,
      tag: t.tag,
      versionId: t.versionId,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    })),
    installations: entry.installations.map((i) => ({
      nodeId: i.nodeId,
      status: i.status,
      version: i.version,
    })),
  };
}

/**
 * Publish a new version of a filesystem skill to the registry.
 * Creates the registry entry if it doesn't exist yet.
 * Snapshots all files + computes content hash for the version.
 */
export async function publishVersion(data: {
  slug: string;
  version: string;
  changelog?: string;
  tagNames?: string[];
  publishedBy: string;
}): Promise<{ entry: unknown; version: unknown }> {
  const db = getDb();
  const { slug, version, changelog, tagNames, publishedBy } = data;

  // 1. Read the filesystem skill
  const fsSkill = await skillService.getSkill(slug);
  if (!fsSkill) {
    throw new Error(`Skill "${slug}" not found on filesystem`);
  }

  // 2. Snapshot files + compute hashes
  const skillDir = path.join(getSkillsDir(), slug);
  const fileEntries: Array<{ path: string; size: number; sha256: string }> = [];
  let totalSize = 0;

  for (const fileName of fsSkill.files) {
    const filePath = path.join(skillDir, fileName);
    const content = await fs.readFile(filePath, 'utf-8');
    const hash = sha256(content);
    const size = Buffer.byteLength(content, 'utf-8');
    fileEntries.push({ path: fileName, size, sha256: hash });
    totalSize += size;
  }

  // Content hash = hash of sorted file hashes (deterministic)
  const contentHash = sha256(
    fileEntries
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => `${f.path}:${f.sha256}`)
      .join('\n'),
  );

  // 3. Upsert registry entry
  let entry = await db.skillRegistryEntry.findUnique({ where: { slug } });

  if (!entry) {
    entry = await db.skillRegistryEntry.create({
      data: {
        slug,
        displayName: fsSkill.name,
        description: fsSkill.description,
        author: fsSkill.author,
        source: 'local',
        entryPoint: fsSkill.entryPoint,
        dependencies: JSON.stringify(fsSkill.dependencies),
        metadata: JSON.stringify({}),
        latestVersion: version,
        status: 'active',
      },
    });
  }

  // 4. Check for duplicate version
  const existingVersion = await db.skillVersion.findUnique({
    where: { skillId_version: { skillId: entry.id, version } },
  });
  if (existingVersion) {
    throw new Error(`Version "${version}" already exists for skill "${slug}"`);
  }

  // 5. Create version record
  const skillVersion = await db.skillVersion.create({
    data: {
      skillId: entry.id,
      version,
      changelog: changelog ?? '',
      contentHash,
      files: JSON.stringify(fileEntries),
      entryPoint: fsSkill.entryPoint,
      sizeBytes: totalSize,
      publishedBy,
    },
  });

  // 6. Update latest version on entry
  entry = await db.skillRegistryEntry.update({
    where: { id: entry.id },
    data: {
      latestVersion: version,
      description: fsSkill.description,
      author: fsSkill.author,
      entryPoint: fsSkill.entryPoint,
      dependencies: JSON.stringify(fsSkill.dependencies),
    },
  });

  // 7. Set tags (always set "latest", plus any user-provided tags)
  const allTags = new Set(tagNames ?? []);
  allTags.add('latest');

  for (const tag of allTags) {
    await db.skillTag.upsert({
      where: { skillId_tag: { skillId: entry.id, tag } },
      create: { skillId: entry.id, tag, versionId: skillVersion.id },
      update: { versionId: skillVersion.id },
    });
  }

  return {
    entry: {
      id: entry.id,
      slug: entry.slug,
      displayName: entry.displayName,
      description: entry.description,
      latestVersion: entry.latestVersion,
      status: entry.status,
    },
    version: formatVersion(skillVersion),
  };
}

/** Get version history for a skill. */
export async function getVersions(slug: string): Promise<unknown[]> {
  const db = getDb();
  const entry = await db.skillRegistryEntry.findUnique({ where: { slug } });
  if (!entry) return [];

  const versions = await db.skillVersion.findMany({
    where: { skillId: entry.id },
    orderBy: { createdAt: 'desc' },
  });

  return versions.map(formatVersion);
}

/** Get a single version detail (with file list). */
export async function getVersionDetail(slug: string, version: string): Promise<unknown | null> {
  const db = getDb();
  const entry = await db.skillRegistryEntry.findUnique({ where: { slug } });
  if (!entry) return null;

  const ver = await db.skillVersion.findUnique({
    where: { skillId_version: { skillId: entry.id, version } },
  });
  if (!ver) return null;

  return {
    ...formatVersion(ver),
    files: JSON.parse(ver.files as string) as Array<{ path: string; size: number; sha256: string }>,
  };
}

/** Set or move a tag to a specific version. */
export async function setTag(
  slug: string,
  tag: string,
  versionId: string,
): Promise<unknown> {
  const db = getDb();
  const entry = await db.skillRegistryEntry.findUnique({ where: { slug } });
  if (!entry) throw new Error(`Skill "${slug}" not found in registry`);

  // Verify the version exists
  const version = await db.skillVersion.findFirst({
    where: { id: versionId, skillId: entry.id },
  });
  if (!version) throw new Error(`Version not found`);

  const skillTag = await db.skillTag.upsert({
    where: { skillId_tag: { skillId: entry.id, tag } },
    create: { skillId: entry.id, tag, versionId },
    update: { versionId },
  });

  return {
    id: skillTag.id,
    tag: skillTag.tag,
    versionId: skillTag.versionId,
    version: version.version,
    createdAt: skillTag.createdAt.toISOString(),
    updatedAt: skillTag.updatedAt.toISOString(),
  };
}

/** Sync all filesystem skills into registry (creates entries + initial versions for untracked skills). */
export async function syncFromFilesystem(publishedBy: string): Promise<{
  created: string[];
  updated: string[];
  skipped: string[];
}> {
  const fsSkills = await skillService.listSkills();
  const db = getDb();
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];

  for (const skill of fsSkills) {
    const existing = await db.skillRegistryEntry.findUnique({
      where: { slug: skill.name },
      include: { versions: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });

    if (!existing) {
      // Create entry + initial version
      await publishVersion({
        slug: skill.name,
        version: skill.version,
        changelog: 'Initial import from filesystem',
        publishedBy,
      });
      created.push(skill.name);
    } else if (existing.latestVersion !== skill.version) {
      // Version on filesystem differs — publish a new version
      try {
        await publishVersion({
          slug: skill.name,
          version: skill.version,
          changelog: 'Synced from filesystem',
          publishedBy,
        });
        updated.push(skill.name);
      } catch {
        // Version may already exist — skip
        skipped.push(skill.name);
      }
    } else {
      skipped.push(skill.name);
    }
  }

  return { created, updated, skipped };
}

/** Delete a registry entry and all its versions/tags. */
export async function deleteRegistryEntry(slug: string): Promise<void> {
  const db = getDb();
  const entry = await db.skillRegistryEntry.findUnique({ where: { slug } });
  if (!entry) throw new Error(`Skill "${slug}" not found in registry`);

  // Cascade delete handles versions and tags
  await db.skillRegistryEntry.delete({ where: { id: entry.id } });
}

// ─── Internal helpers ───

interface VersionRow {
  id: string;
  version: string;
  changelog: string;
  contentHash: string;
  files: string;
  entryPoint: string;
  sizeBytes: number;
  publishedBy: string;
  createdAt: Date;
}

function formatVersion(v: VersionRow): {
  id: string;
  version: string;
  changelog: string;
  contentHash: string;
  entryPoint: string;
  sizeBytes: number;
  fileCount: number;
  publishedBy: string;
  createdAt: string;
} {
  const files = JSON.parse(v.files as string) as unknown[];
  return {
    id: v.id,
    version: v.version,
    changelog: v.changelog,
    contentHash: v.contentHash,
    entryPoint: v.entryPoint,
    sizeBytes: v.sizeBytes,
    fileCount: files.length,
    publishedBy: v.publishedBy,
    createdAt: v.createdAt.toISOString(),
  };
}
