import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { installPackedAgent, pack } from './check-packed-agent.mjs';

test('omitting development packages still rejects an inconsistent development graph', { timeout: 180_000 }, async t => {
  const root = resolve(import.meta.dirname, '..');
  const work = mkdtempSync(join(tmpdir(), 'magnus-invalid-agent-pack-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const agent = pack(join(root, 'packages/agent'), work);
  const contracts = pack(join(root, 'packages/contracts'), work);
  execFileSync('tar', ['-xzf', agent, '-C', work]);
  const lockPath = join(work, 'package/npm-shrinkwrap.json');
  const lock = JSON.parse(readFileSync(lockPath));
  // Reproduce 2.3.3: a workspace override selected nanoid below postcss's
  // standalone requirement. npm validates this graph even with --omit=dev.
  const nanoid = lock.packages['node_modules/postcss/node_modules/nanoid'];
  assert.equal(nanoid.dev, true);
  nanoid.version = '3.3.18';
  nanoid.resolved = 'https://registry.npmjs.org/nanoid/-/nanoid-3.3.18.tgz';
  nanoid.integrity = 'sha512-DTg4MJbGMWkfi6VZFdNt2/caMbQy4Ou+Op/hJQvGEWcnVfoA1QA+xzRKAzw9jD6+GVOOeYr/mIcuDSdug6F6+w==';
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  const broken = join(work, 'broken.tgz');
  execFileSync('tar', ['-czf', broken, '-C', work, 'package']);
  await assert.rejects(installPackedAgent(broken, contracts), /npm ci failed \(EUSAGE\)/);
});
