import { Hono, type Context } from 'hono';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ZodError } from 'zod';
import { managedExecution } from '../security/managed-context.js';
import { publishSkillBundle, skillPublicationBodySchema, skillPublicationNotCommitted, type SkillPublicationHooks } from './skill-publication.js';
import { SkillBundleError } from './skill-bundle.js';

export const skillRoutes = new Hono();

export const PRIMARY_SKILLS_DIR = process.env['SKILLS_DIR'] ?? '/opt/magnus-agent/skills';

/** Validate a skill name: reject traversal patterns and path separators. */
function isValidSkillName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) && !name.includes('..');
}

/**
 * Build a list of directories to scan for installed skills.
 * Includes the primary SKILLS_DIR plus well-known locations such as
 * ~/.magnus/workspace/skills (the Magnus default workspace).
 * Deduplicates paths and only returns directories that actually exist.
 */
async function resolveSkillsDirs(): Promise<string[]> {
  const home = process.env['HOME'] ?? homedir();
  const hermesUser = process.env['HERMES_USER'] ?? '';

  const candidates = new Set<string>();
  candidates.add(PRIMARY_SKILLS_DIR);

  // ~/.magnus/workspace/skills for the current process user
  if (home) {
    candidates.add(join(home, '.magnus', 'workspace', 'skills'));
  }

  // Also check the Hermes owner's home if it differs from the running user
  if (hermesUser && /^[a-z_][a-z0-9_-]*$/.test(hermesUser)) {
    candidates.add(join('/home', hermesUser, '.magnus', 'workspace', 'skills'));
  }

  // Allow extra dirs via colon-separated SKILLS_EXTRA_DIRS env var
  const extra = process.env['SKILLS_EXTRA_DIRS'];
  if (extra) {
    for (const p of extra.split(':')) {
      if (p.trim()) candidates.add(p.trim());
    }
  }

  // Filter to directories that actually exist
  const existing: string[] = [];
  for (const dir of candidates) {
    try {
      const s = await stat(dir);
      if (s.isDirectory()) existing.push(dir);
    } catch {
      // Directory doesn't exist – skip
    }
  }
  return existing;
}

// ── List installed skills ──
skillRoutes.get('/', async (c) => {
  try {
    const dirs = await resolveSkillsDirs();
    if (dirs.length === 0) {
      return c.json({ success: true, data: [] });
    }

    const seen = new Set<string>();
    const skills = [];

    for (const skillsDir of dirs) {
      let skillDirs: string[];
      try {
        skillDirs = await readdir(skillsDir);
      } catch {
        continue;
      }

      for (const name of skillDirs) {
        // Hidden entries are install/publication staging (`.skill-install-*`, `.skill-publish-*`), never skills.
        if (name.startsWith('.')) continue;
        if (seen.has(name)) continue; // deduplicate across directories

        const skillPath = join(skillsDir, name);
        // Try to find version subdirectories or a direct manifest
        let manifestPath = join(skillPath, 'manifest.json');
        let version = 'unknown';
        let versionDir = skillPath;

        try {
          // Check for version subdirectories first (e.g., /skills/backup-manager/1.0.0/)
          const entries = await readdir(skillPath);
          const versionDirs = entries.filter((e) => /^\d/.test(e));
          if (versionDirs.length > 0) {
            // Use the latest version directory
            versionDirs.sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
            const latestVersion = versionDirs[versionDirs.length - 1]!;
            versionDir = join(skillPath, latestVersion);
            manifestPath = join(versionDir, 'manifest.json');
            version = latestVersion;
          }
        } catch {
          // Not a directory, skip
          continue;
        }

        try {
          const raw = await readFile(manifestPath, 'utf-8');
          const manifest = JSON.parse(raw) as Record<string, unknown>;

          // List file names only — do not read file contents to avoid large responses
          const allFiles = await readdir(versionDir);
          const fileList = allFiles.filter((f) => f !== 'node_modules' && f !== '.git' && f !== '.magnus-publication.json');

          seen.add(name);
          skills.push({
            name: (manifest['name'] as string) ?? name,
            version: (manifest['version'] as string) ?? version,
            description: (manifest['description'] as string) ?? '',
            author: (manifest['author'] as string) ?? '',
            entryPoint: (manifest['entryPoint'] as string) ?? '',
            dependencies: (manifest['dependencies'] as string[]) ?? [],
            tags: (manifest['tags'] as string[]) ?? [],
            files: fileList,
          });
        } catch {
          // No manifest — include with basic info
          seen.add(name);
          skills.push({
            name,
            version,
            description: '',
            author: '',
            entryPoint: '',
            dependencies: [],
            tags: [],
            files: [],
          });
        }
      }
    }

    return c.json({ success: true, data: skills });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ success: false, error: { code: 'SKILL_LIST_ERROR', message } }, 500);
  }
});

// ── Install a skill bundle ──
export function skillInstallHandler(options: { skillsDir?: string; publicationHooks?: SkillPublicationHooks } = {}) {
  return async (c: Context) => {
  const context = managedExecution.getStore();
  if (!context?.coordination) return c.json({ success: false, error: { code: 'MANAGED_PUBLICATION_REQUIRED',
    message: 'Skill publication requires an exact managed command receipt' } }, 409);
  const parsed = skillPublicationBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      { success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.issues.map(e => e.message).join('; ') } },
      400,
    );
  }

  try {
    return c.json(await publishSkillBundle(parsed.data, context, options.skillsDir ?? PRIMARY_SKILLS_DIR, options.publicationHooks));
  } catch (err: unknown) {
    if (err instanceof SkillBundleError && err.code === 'SKILL_PUBLICATION_CANCELLED') {
      const result = skillPublicationNotCommitted(parsed.data, context);
      return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json' } });
    }
    if (err instanceof SkillBundleError) return c.json({ success: false, error: { code: err.code, message: err.message } }, err.status);
    if (err instanceof ZodError) return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } }, 400);
    return c.json({ success: false, error: { code: 'SKILL_INSTALL_ERROR', message: 'Skill installation could not be published safely' } }, 500);
  }
  };
}
skillRoutes.post('/install', skillInstallHandler());

// ── Remove a skill ──
skillRoutes.delete('/:skillName', async (c) => {
  const skillName = c.req.param('skillName');
  if (!isValidSkillName(skillName)) {
    return c.json(
      { success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid skill name' } },
      400,
    );
  }
  const skillDir = join(PRIMARY_SKILLS_DIR, skillName);

  try {
    await rm(skillDir, { recursive: true, force: true });
    return c.json({ success: true, data: { removed: true } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ success: false, error: { code: 'SKILL_REMOVE_ERROR', message } }, 500);
  }
});
