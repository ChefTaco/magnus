import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSkillPublicationBundle } from './skill-publication-bundle.js';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
let root: string;

async function fixture() {
  const skillRoot = path.join(root, 'fixture-skill');
  await mkdir(skillRoot, { recursive: true });
  const manifest = Buffer.from(JSON.stringify({ name: 'fixture-skill', version: '1.0.0' }) + '\n');
  const script = Buffer.from('#!/bin/sh\nprintf fixture\n');
  await writeFile(path.join(skillRoot, 'manifest.json'), manifest);
  await writeFile(path.join(skillRoot, 'run.sh'), script);
  await chmod(path.join(skillRoot, 'manifest.json'), 0o644);
  await chmod(path.join(skillRoot, 'run.sh'), 0o755);
  const files = [
    { path: 'run.sh', size: script.length, sha256: sha256(script) },
    { path: 'manifest.json', size: manifest.length, sha256: sha256(manifest) },
  ];
  const ordered = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files: ordered, contentHash: sha256(ordered.map(file => `${file.path}:${file.sha256}`).join('\n')) };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'skill-publication-source-'));
  vi.stubEnv('SKILLS_DIR', root);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe('skill publication bundle source', () => {
  it('captures the immutable registry files in canonical order with exact bundle and tree digests', async () => {
    const source = await fixture();
    const result = await buildSkillPublicationBundle({ skillName: 'fixture-skill', version: '1.0.0',
      registryContentSha256: source.contentHash, registryFilesJson: JSON.stringify(source.files) });
    expect(result.bundle.entries.map(entry => entry.path)).toEqual(['manifest.json', 'run.sh']);
    expect(result.bundle.entries.map(entry => entry.mode)).toEqual([420, 493]);
    expect(result.bundleSha256).toBe(sha256(JSON.stringify(result.bundle)));
    expect(result.treeSha256).toBe(sha256(JSON.stringify({ format: 'magnus-skill-tree-v1',
      entries: result.bundle.entries.map(({ path: filePath, mode, sha256: fileSha256 }) => ({ path: filePath, mode, sha256: fileSha256 })) })));
    expect(Buffer.from(result.bundle.entries[0]!.contentBase64, 'base64')).toEqual(await readFile(path.join(root, 'fixture-skill', 'manifest.json')));
  });

  it('rejects source mutation, manifest identity drift and symbolic-link files', async () => {
    const source = await fixture();
    const original = await readFile(path.join(root, 'fixture-skill', 'run.sh'));
    original[0] = original[0] === 35 ? 36 : 35;
    await writeFile(path.join(root, 'fixture-skill', 'run.sh'), original);
    await chmod(path.join(root, 'fixture-skill', 'run.sh'), 0o755);
    await expect(buildSkillPublicationBundle({ skillName: 'fixture-skill', version: '1.0.0',
      registryContentSha256: source.contentHash, registryFilesJson: JSON.stringify(source.files) })).rejects.toThrow('differs');

    const restored = await fixture();
    await writeFile(path.join(root, 'fixture-skill', 'manifest.json'), JSON.stringify({ name: 'other', version: '1.0.0' }));
    const changed = await readFile(path.join(root, 'fixture-skill', 'manifest.json'));
    const manifest = restored.files.find(file => file.path === 'manifest.json')!;
    manifest.size = changed.length; manifest.sha256 = sha256(changed);
    const ordered = [...restored.files].sort((a, b) => a.path < b.path ? -1 : 1);
    await expect(buildSkillPublicationBundle({ skillName: 'fixture-skill', version: '1.0.0',
      registryContentSha256: sha256(ordered.map(file => `${file.path}:${file.sha256}`).join('\n')),
      registryFilesJson: JSON.stringify(restored.files) })).rejects.toThrow();

    await fixture(); await rm(path.join(root, 'fixture-skill', 'run.sh'));
    await symlink('/bin/true', path.join(root, 'fixture-skill', 'run.sh'));
    await expect(buildSkillPublicationBundle({ skillName: 'fixture-skill', version: '1.0.0',
      registryContentSha256: source.contentHash, registryFilesJson: JSON.stringify(source.files) })).rejects.toThrow();
  });
});
