// Exercise the same isolated, locked installation used by the Hive host installer.
// Only the unpublished contracts URL is redirected in a disposable extraction;
// its exact packed bytes, version and SHA-512 integrity must already match.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function pack(directory, destination) {
  const [report] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination],
    { cwd: directory, encoding: 'utf8' }));
  return join(destination, report.filename);
}

export async function installPackedAgent(agentTarball, contractsTarball) {
  const work = mkdtempSync(join(tmpdir(), 'magnus-packed-agent-'));
  const contracts = readFileSync(contractsTarball);
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/contracts.tgz') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': contracts.length });
    response.end(contracts);
  });
  try {
    execFileSync('tar', ['-xzf', agentTarball, '-C', work]);
    const candidate = join(work, 'package');
    const manifestPath = join(candidate, 'package.json');
    const manifestBytes = readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes);
    const lockPath = join(candidate, 'npm-shrinkwrap.json');
    const lock = JSON.parse(readFileSync(lockPath));
    assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
    const entry = lock.packages['node_modules/@hivemagnus/magnus-contracts'];
    assert.equal(entry.version, manifest.dependencies['@hivemagnus/magnus-contracts']);
    assert.equal(entry.resolved, `https://registry.npmjs.org/@hivemagnus/magnus-contracts/-/magnus-contracts-${entry.version}.tgz`);
    assert.equal(entry.integrity, 'sha512-' + createHash('sha512').update(contracts).digest('base64'),
      'The packed contracts must match the agent shrinkwrap before testing');
    await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
    entry.resolved = `http://127.0.0.1:${server.address().port}/contracts.tgz`;
    const lockBytes = JSON.stringify(lock, null, 2) + '\n';
    writeFileSync(lockPath, lockBytes);
    for (const name of ['user.npmrc', 'global.npmrc']) writeFileSync(join(work, name), '');
    const result = await new Promise((done, reject) => {
      const child = spawn('npm', ['ci', '--prefix', candidate, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
        '--loglevel=error', '--registry=https://registry.npmjs.org/', `--userconfig=${join(work, 'user.npmrc')}`,
        `--globalconfig=${join(work, 'global.npmrc')}`, `--cache=${join(work, 'npm-cache')}`],
      { cwd: work, stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
      let diagnostic = '';
      for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-65536); });
      child.once('error', reject);
      child.once('close', status => done({ status, diagnostic }));
    });
    const code = result.diagnostic.match(/^npm (?:error|ERR!) code ([A-Z][A-Z0-9_]{0,63})$/m)?.[1] ?? 'failure';
    assert.equal(result.status, 0, `Packaged agent npm ci failed (${code})`);
    assert.equal(readFileSync(manifestPath).equals(manifestBytes), true, 'npm ci must not repair the package manifest');
    assert.equal(readFileSync(lockPath, 'utf8'), lockBytes, 'npm ci must not repair the shrinkwrap');
    assert.equal(execFileSync(process.execPath, [join(candidate, 'dist/index.js'), '--version'], { encoding: 'utf8' }).trim(), manifest.version);
  } finally {
    await new Promise(done => server.close(done));
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = resolve(import.meta.dirname, '..');
  const work = mkdtempSync(join(tmpdir(), 'magnus-agent-packs-'));
  try {
    await installPackedAgent(pack(join(root, 'packages/agent'), work), pack(join(root, 'packages/contracts'), work));
    console.log('Packed agent: isolated locked installation and CLI version passed');
  } finally { rmSync(work, { recursive: true, force: true }); }
}
