// Behaviour of the bundled scripts that write files or call out, with Node's built-in test runner.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const skillsDir = fileURLToPath(new URL('../skills/', import.meta.url));
const backup = join(skillsDir, 'backup-manager', 'backup.sh');
const reporter = join(skillsDir, 'news-reporter', 'reporter.sh');

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'magnus-skills-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('backup-manager writes private archives and purges only its own top-level archives', t => {
  const root = workspace(t);
  const source = join(root, 'source');
  const destination = join(root, 'backups');
  mkdirSync(source);
  mkdirSync(join(destination, 'other-tool'), { recursive: true });
  writeFileSync(join(source, 'file'), 'data');
  const old = new Date(Date.now() - 100 * 86_400_000);
  for (const stale of [join(destination, 'backup-old.tar.gz'), join(destination, 'other-tool', 'backup-old.tar.gz')]) {
    writeFileSync(stale, '');
    utimesSync(stale, old, old);
  }

  const result = spawnSync('bash', [backup, source, destination, '30'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const archives = readdirSync(destination).filter(name => /^backup-\d{8}-\d{6}\.tar\.gz$/.test(name));
  assert.equal(archives.length, 1);
  assert.equal(statSync(join(destination, archives[0])).mode & 0o077, 0);
  assert.equal(statSync(join(destination, 'checksums.txt')).mode & 0o077, 0);
  assert.ok(!readdirSync(destination).includes('backup-old.tar.gz'));
  assert.deepEqual(readdirSync(join(destination, 'other-tool')), ['backup-old.tar.gz']);
});

test('backup-manager refuses a retention that is not a number of days', t => {
  const root = workspace(t);
  mkdirSync(join(root, 'source'));
  const result = spawnSync('bash', [backup, join(root, 'source'), join(root, 'backups'), '1 -o -true'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.deepEqual(readdirSync(root), ['source']);
});

test('news-reporter refuses settings that would add URL parameters, before any request', t => {
  const root = workspace(t);
  const env = { PATH: process.env.PATH, NEWSAPI_KEY: 'x'.repeat(16), OUTPUT_DIR: join(root, 'out') };
  for (const override of [{ NEWS_COUNTRY: 'us&apiKey=other' }, { NEWS_CATEGORY: 'general&q=x' }, { NEWS_PAGE_SIZE: '10&page=2' }, { NEWSAPI_KEY: 'key with spaces' }]) {
    const result = spawnSync('bash', [reporter], { encoding: 'utf8', env: { ...env, ...override } });
    assert.equal(result.status, 2, JSON.stringify(override));
  }
  assert.deepEqual(readdirSync(root), []);
});
