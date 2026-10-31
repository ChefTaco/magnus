import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  entryPoint: string;
  dependencies: string[];
  tags: string[];
}

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/** Absolute path to the `skills/` directory shipped with this package. */
export function getSkillsDir(): string {
  return resolve(__dirname, '..', 'skills');
}

/** Read and parse all skill manifests from the skills directory. */
export function listManifests(): SkillManifest[] {
  const dir = getSkillsDir();
  const entries = readdirSync(dir, { withFileTypes: true });
  const manifests: SkillManifest[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(dir, entry.name, 'manifest.json');
    try {
      statSync(manifestPath);
    } catch {
      continue;
    }
    const raw = readFileSync(manifestPath, 'utf-8');
    manifests.push(JSON.parse(raw) as SkillManifest);
  }

  return manifests.sort((a, b) => a.name.localeCompare(b.name));
}
