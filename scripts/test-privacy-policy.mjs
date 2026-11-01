import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forbiddenPath, privateInfrastructureFindings, secretFindings } from './privacy-policy.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('blocks credential and local-state paths while allowing example configuration', () => {
  for (const path of ['.env.production', 'a/.npmrc', 'a/state/events.jsonl', 'artifacts/proof.json', 'a/private.key', 'data.sqlite-wal', 'AGENTS.local.md', '.hive-dev/config.json', '.ssh/id_ed25519', '.vscode/mcp.json']) {
    assert.equal(forbiddenPath(path), true, path);
  }
  for (const path of ['a/.env.example', 'a/README.md', 'src/state.ts']) assert.equal(forbiddenPath(path), false, path);
});

test('detects provider tokens even when unrelated text says example', () => {
  for (const token of ['npm_' + 'A'.repeat(36), 'ghp_' + 'B'.repeat(36), 'github_pat_' + 'C'.repeat(50),
    'sk-' + 'D'.repeat(30), 'AKIA' + 'E'.repeat(16), 'xoxb-' + '1234567890'.repeat(3)]) {
    const findings = secretFindings(`example: ${token}`);
    assert.ok(findings.length);
    assert.ok(!JSON.stringify(findings).includes(token));
  }
});

test('finds quoted credentials and only exempts the actual placeholder value', () => {
  const value = 'unrelated-opaque-' + 'A'.repeat(20);
  assert.ok(secretFindings(`API_SECRET="${value}" # example`).length);
  assert.ok(secretFindings(`{"SESSION_SECRET": "${value}"}`).length);
  assert.equal(secretFindings('API_SECRET="replace-with-a-random-secret"').length, 0);
  assert.equal(secretFindings('API_SECRET: process.env.API_SECRET').length, 0);
  assert.ok(secretFindings(`API_SECRET=${'A'.repeat(32)}`).length);
});

test('detects private-key headers without including their values in findings', () => {
  assert.equal(secretFindings('-----BEGIN ' + 'OPENSSH PRIVATE KEY-----')[0].rule, 'private key');
});

test('blocks private infrastructure patterns without an operator denylist', () => {
  const domain = ['node', 'private', 'ts', 'net'].join('.');
  assert.equal(privateInfrastructureFindings(`https://${domain}`).length, 1);
  assert.equal(privateInfrastructureFindings('/home/' + 'personal-account/project').length, 1);
  assert.equal(privateInfrastructureFindings('/home/operator/project https://node.example.com').length, 0);
});

test('the scanner checks staged blobs even when the working copy is sanitized', () => {
  const root = mkdtempSync(join(tmpdir(), 'magnus-secret-gate-'));
  try {
    mkdirSync(join(root, 'scripts'));
    for (const file of ['scan-secrets.mjs', 'privacy-policy.mjs']) {
      cpSync(resolve(import.meta.dirname, file), join(root, 'scripts', file));
    }
    execFileSync('git', ['init', '-q'], { cwd: root });
    const token = 'npm_' + 'Z'.repeat(36);
    const file = join(root, 'space in name.txt');
    writeFileSync(file, `example ${token}`);
    execFileSync('git', ['add', '--', 'space in name.txt'], { cwd: root });
    writeFileSync(file, 'sanitized working copy');
    const result = spawnSync(process.execPath, [join(root, 'scripts/scan-secrets.mjs')], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /npm token \[redacted\]/);
    assert.ok(!`${result.stderr}${result.stdout}`.includes(token));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('private-data failures redact denied content and reject local-state files', () => {
  const root = mkdtempSync(join(tmpdir(), 'magnus-private-gate-'));
  try {
    mkdirSync(join(root, 'scripts'));
    cpSync(resolve(import.meta.dirname, 'check-private-data.sh'), join(root, 'scripts/check-private-data.sh'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    const privateTerm = 'private-' + 'fixture-name';
    writeFileSync(join(root, '.private-terms'), privateTerm);
    writeFileSync(join(root, 'notes.txt'), privateTerm);
    mkdirSync(join(root, 'state'));
    writeFileSync(join(root, 'state/events.jsonl'), '{}');
    execFileSync('git', ['add', 'notes.txt', 'state/events.jsonl'], { cwd: root });
    const result = spawnSync('bash', [join(root, 'scripts/check-private-data.sh'), '--staged'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /forbidden file: state\/events.jsonl/);
    assert.match(result.stderr, /notes.txt:1 \[redacted\]/);
    assert.ok(!result.stderr.includes(privateTerm));
    writeFileSync(join(root, '.private-terms'), '[');
    const invalid = spawnSync('bash', [join(root, 'scripts/check-private-data.sh')], { encoding: 'utf8' });
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /invalid regular expression/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('npm package checking scans generated file contents as well as names', () => {
  const root = mkdtempSync(join(tmpdir(), 'magnus-pack-gate-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'bin'));
    for (const file of ['check-npm-packs.mjs', 'privacy-policy.mjs']) {
      cpSync(resolve(import.meta.dirname, file), join(root, 'scripts', file));
    }
    const directories = ['packages/contracts', 'packages/skills', 'packages/ardent', 'packages/agent', 'services/control-api', 'apps/dashboard', 'packages/magnus'];
    const files = ['package.json', 'README.md', 'LICENSE', 'dist/index.js',
      'dist/app/apps/dashboard/server-tls.mjs', 'dist/app/apps/dashboard/server.js', 'launcher/launcher.mjs'];
    for (const directory of directories) {
      for (const file of files) {
        const target = join(root, directory, file);
        mkdirSync(resolve(target, '..'), { recursive: true });
        writeFileSync(target, 'fixture content');
      }
      writeFileSync(join(root, directory, 'package.json'), JSON.stringify({
        name: '@hivemagnus/fixture', version: '1.0.0', license: 'Apache-2.0', publishConfig: { access: 'public' }, main: 'dist/index.js',
      }));
    }
    writeFileSync(join(root, 'bin/npm'), `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify([{ files: files.map(path => ({ path })) }]))});\n`, { mode: 0o755 });
    const options = { encoding: 'utf8', env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` } };
    const run = () => spawnSync(process.execPath, [join(root, 'scripts/check-npm-packs.mjs')], options);
    assert.equal(run().status, 0);
    const token = 'ghp_' + 'Q'.repeat(36);
    writeFileSync(join(root, 'packages/contracts/dist/index.js'), `const example = "${token}";`);
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stdout, /dist\/index.js:1: GitHub token \[redacted\]/);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(token));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('package builds remove outputs for deleted source files', { timeout: 60_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'magnus-clean-build-'));
  try {
    for (const directory of ['packages/agent', 'packages/contracts', 'packages/skills', 'services/control-api']) {
      const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', directory, 'package.json'), 'utf8'));
      const cwd = join(root, directory);
      mkdirSync(join(cwd, 'src'), { recursive: true });
      mkdirSync(join(cwd, 'scripts'));
      for (const file of ['build-index.mjs', 'copy-assets.mjs']) writeFileSync(join(cwd, 'scripts', file), '');
      writeFileSync(join(cwd, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: manifest.scripts }));
      writeFileSync(join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
        target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', types: [],
        outDir: 'dist', rootDir: 'src', composite: ['packages/agent', 'services/control-api'].includes(directory),
      }, include: ['src'] }));
      writeFileSync(join(cwd, 'src/index.ts'), 'export const retained = true;');
      writeFileSync(join(cwd, 'src/removed.ts'), 'export const removed = true;');
      const options = { cwd, env: { ...process.env, PATH: `${resolve(import.meta.dirname, '../node_modules/.bin')}:${process.env.PATH}` }, stdio: 'pipe', timeout: 20_000 };
      execFileSync('npm', ['run', 'build'], options);
      assert.ok(existsSync(join(cwd, 'dist/removed.js')), directory);
      rmSync(join(cwd, 'src/removed.ts'));
      execFileSync('npm', ['run', 'build'], options);
      assert.ok(!existsSync(join(cwd, 'dist/removed.js')), directory);
      assert.ok(existsSync(join(cwd, 'dist/index.js')), directory);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
