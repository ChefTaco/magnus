import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkRepositoryDocs } from './check-repository-docs.mjs';

test('local doc links distinguish real missing files from external and historical absolute references', t => {
  const root = mkdtempSync(join(tmpdir(), 'magnus-docs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'guide.md'), '[guide](next%20step.md#anchor)\n[web](https://example.com)\n[host](/opt/magnus/evidence.json)\n[missing](lost.md)\n');
  writeFileSync(join(root, 'docs', 'next step.md'), '# Next step');
  const result = checkRepositoryDocs(root, ['docs/guide.md']);
  assert.equal(result.links, 2);
  assert.deepEqual(result.failures, ['docs/guide.md:4: missing local link target lost.md']);
});

test('a new workspace must have guides and appear in each canonical package map', t => {
  const root = mkdtempSync(join(tmpdir(), 'magnus-docs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'packages', 'new-runtime'), { recursive: true });
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'packages', 'new-runtime', 'package.json'), '{}');
  const first = checkRepositoryDocs(root, []);
  assert.equal(first.packages, 1);
  assert.equal(first.failures.length, 5);
  for (const guide of ['README.md', 'AGENTS.md']) writeFileSync(join(root, 'packages', 'new-runtime', guide), '# Guide');
  for (const map of ['README.md', 'AGENTS.md', 'docs/APP_ARCHITECTURE.md']) {
    writeFileSync(join(root, map), '| `packages/new-runtime` | Runtime |');
  }
  assert.deepEqual(checkRepositoryDocs(root, []).failures, []);
});
