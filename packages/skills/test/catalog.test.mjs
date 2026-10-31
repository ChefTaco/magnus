// Validates the skill catalogue with Node's built-in test runner.
import assert from 'node:assert/strict';
import { accessSync, constants, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const skillsDir = fileURLToPath(new URL('../skills/', import.meta.url));
const bundles = readdirSync(skillsDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
const index = JSON.parse(readFileSync(join(skillsDir, 'index.json'), 'utf8'));

test('the catalogue is not empty and the index lists every bundle', () => {
  assert.ok(bundles.length > 0);
  assert.equal(index.count, bundles.length);
  assert.deepEqual(index.skills.map(skill => skill.path).sort(), [...bundles].sort());
});

for (const slug of bundles) {
  test(`${slug} has a valid manifest, entry point and SKILL.md`, () => {
    assert.match(slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    const manifest = JSON.parse(readFileSync(join(skillsDir, slug, 'manifest.json'), 'utf8'));
    assert.equal(manifest.name, slug);
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    for (const field of ['description', 'author', 'entryPoint']) assert.equal(typeof manifest[field], 'string', field);
    assert.ok(Array.isArray(manifest.dependencies) && Array.isArray(manifest.tags));
    const entry = join(skillsDir, slug, manifest.entryPoint);
    assert.ok(statSync(entry).isFile());
    accessSync(entry, constants.X_OK);
    const skill = readFileSync(join(skillsDir, slug, 'SKILL.md'), 'utf8');
    assert.ok(skill.startsWith(`---\nname: ${slug}\n`));
  });
}
