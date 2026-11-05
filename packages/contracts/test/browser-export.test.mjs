import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportBrowserContracts } from '../../../scripts/export-browser-contracts.mjs';

function repository(contents) {
  const root = mkdtempSync(join(tmpdir(), 'magnus-contract-'));
  const git = (args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git(['init', '--quiet']);
  mkdirSync(join(root, 'packages/contracts/src'), { recursive: true });
  writeFileSync(join(root, 'packages/contracts/src/browser.ts'), contents);
  git(['add', 'packages']);
  git(['-c', 'user.name=Example Contributor', '-c', 'user.email=contributor@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'test: public contract']);
  return { root, revision: git(['rev-parse', 'HEAD']).toString().trim() };
}

test('exports exact committed bytes with SHA-256 provenance and refuses overwrites', () => {
  const contents = "import { z } from 'zod';\n// Synthetic public contract\n";
  const { root, revision } = repository(contents);
  try {
    writeFileSync(join(root, 'packages/contracts/src/browser.ts'), '// Unreviewed bytes\n');
    const output = join(root, 'export');
    exportBrowserContracts(root, output);
    assert.equal(readFileSync(join(output, 'browser.ts'), 'utf8'), contents);
    assert.deepEqual(JSON.parse(readFileSync(join(output, 'provenance.json'), 'utf8')), {
      schema: 1,
      product: 'magnus-browser',
      version: 1,
      repository: 'https://github.com/ChefTaco/magnus',
      revision,
      files: [{
        path: 'browser.ts',
        source: 'packages/contracts/src/browser.ts',
        sha256: createHash('sha256').update(contents).digest('hex'),
      }],
    });
    assert.equal(statSync(output).mode & 0o777, 0o700);
    assert.throws(() => exportBrowserContracts(root, output));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses a contract that imports server code', () => {
  const { root } = repository("import { secret } from '../../services/control-api/src/server.js';\n");
  try {
    assert.throws(() => exportBrowserContracts(root, join(root, 'export')), /server implementation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
