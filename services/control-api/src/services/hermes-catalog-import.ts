import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getSkillsDir, listManifests } from '@hivemagnus/magnus-skills';
import { getDb } from '../db/index.js';
import { assignSkillTargets, isDeployHost, publishRevision } from './hermes-registry-service.js';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function importPackageSkills(): Promise<{ published: number; held: number; targets: number }> {
  const root = getSkillsDir();
  const db = getDb();
  const installations = await db.hermesInstallation.findMany({ select: { id: true, hostname: true } });
  const named = new Set(installations.filter(row => isDeployHost(row.hostname.split('.')[0]!.toLowerCase())).map(row => row.id));
  let published = 0; let held = 0; let targets = 0;
  for (const manifest of listManifests()) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(manifest.name)) continue;
    const directory = join(root, manifest.name);
    const files: Array<{ path: string; contentBase64: string; sha256: string; mode: 420 | 493 }> = [];
    async function visit(current: string, relative = ''): Promise<void> {
      for (const item of await readdir(current, { withFileTypes: true })) {
        const path = relative ? `${relative}/${item.name}` : item.name;
        if (path.split('/').some(part => !/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(part) || part.includes('..')))
          throw new Error(`Unsafe packaged skill path: ${path}`);
        if (item.isDirectory()) { await visit(join(current, item.name), path); continue; }
        if (!item.isFile()) throw new Error(`Packaged skill has non-file entry: ${path}`);
        const bytes = await readFile(join(current, item.name));
        const mode = ((await stat(join(current, item.name))).mode & 0o111) ? 493 : 420;
        files.push({ path, contentBase64: bytes.toString('base64'), sha256: digest(bytes), mode });
      }
    }
    await visit(directory);
    files.sort((a, b) => a.path.localeCompare(b.path));
    const result = await publishRevision({ kind: 'skill', slug: manifest.name,
      artifact: { format: 'magnus-hermes-skill-v1', installPath: manifest.name, files },
      metadata: { tags: manifest.tags, packageVersion: manifest.version, source: 'magnus-skills' },
      publishedBy: 'system:magnus-skills' });
    if (!result.duplicate) published++;
    if (result.revision.status !== 'published') { held++; continue; }
    targets += await assignSkillTargets(manifest.name, manifest.tags);
    const old = await db.hermesSkillAssignment.findMany({ where: { source: 'magnus-skills', skillSlug: manifest.name, enabled: true } });
    for (const assignment of old.filter(row => named.has(row.installationId)
      && (!row.pinnedVersion || row.pinnedVersion === manifest.version))) {
      await db.hermesRegistryTarget.upsert({ where: { kind_slug_installationId_profileId: { kind: 'skill', slug: manifest.name,
        installationId: assignment.installationId, profileId: assignment.profileId } },
      create: { kind: 'skill', slug: manifest.name, installationId: assignment.installationId, profileId: assignment.profileId,
        pinnedRevision: assignment.pinnedVersion ? result.revision.revision : null }, update: {} });
      targets++;
    }
  }
  return { published, held, targets };
}
