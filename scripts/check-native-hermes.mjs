#!/usr/bin/env node
// Explicit developer proof against a disposable external HTTPS protocol fixture.
// No existing Hermes profile, sign-in session or inference service is selected.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:https';

const execute = (program, args, options = {}) => new Promise((done, reject) => {
  const child = execFile(program, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
    if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
    else done({ stdout, stderr });
  });
  child.stdin.on('error', () => undefined);
  child.stdin.end();
});
const argument = process.argv.indexOf('--artifact');
assert(argument >= 0 && process.argv[argument + 1], '--artifact PRIVATE_DESCRIPTOR is required');
const descriptorFile = resolve(process.argv[argument + 1]), descriptor = JSON.parse(await readFile(descriptorFile));
assert.equal(descriptor.product, 'hermes-agent');
assert(/^[A-Za-z0-9._-]+\.tar\.gz$/.test(descriptor.archive));
const archive = join(dirname(descriptorFile), descriptor.archive);
assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), descriptor.sha256);
const scratch = await mkdtemp(join(tmpdir(), 'native-hermes-proof-'));
const home = join(scratch, 'home'), profile = join(scratch, 'profile'), runtime = join(scratch, 'runtime');
let fixture, calls = 0;
const diagnostics = { paths: [], tlsErrors: [], rejected: [] };
try {
  for (const directory of [home, profile, runtime]) await mkdir(directory, { mode: 0o700 });
  const listing = (await execute('tar', ['-tzf', archive])).stdout.trim().split('\n');
  assert(listing.every(name => !name.startsWith('/') && !name.includes('..') && !name.includes('\\') && !/\.(gguf|ggml|safetensors)$/i.test(name)));
  assert((await execute('tar', ['-tvzf', archive])).stdout.trim().split('\n').every(line => ['d', '-'].includes(line[0])));
  await execute('tar', ['-xzf', archive, '-C', runtime, '--no-same-owner', '--no-same-permissions']);
  const cert = join(scratch, 'fixture.pem'), key = join(scratch, 'fixture.key'), authority = join(scratch, 'authority.pem');
  const authorityKey = join(scratch, 'authority.key'), csr = join(scratch, 'fixture.csr'), extensions = join(scratch, 'leaf.extensions');
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', authorityKey, '-out', authority, '-subj', '/CN=Synthetic test authority', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-days', '1']);
  await execute('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', '/CN=localhost']);
  await writeFile(extensions, 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n', { mode: 0o600 });
  await execute('openssl', ['x509', '-req', '-in', csr, '-CA', authority, '-CAkey', authorityKey, '-set_serial', '12345', '-out', cert, '-days', '1', '-extfile', extensions]);
  await chmod(key, 0o600);
  fixture = createServer({ cert: await readFile(cert), key: await readFile(key) }, async (req, res) => {
    try {
      diagnostics.paths.push(req.url);
      assert.equal(req.headers.authorization, 'Bearer obviously-fake-fixture-key');
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end('{}'); return; }
      const chunks = []; let size = 0;
      for await (const bytes of req) { chunks.push(bytes); size += bytes.length; assert(size < 1024 * 1024); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.model, 'synthetic-external-model');
      assert.equal(body.stream, true);
      assert(!body.tools?.length, 'Harmless native acceptance must not enable tools');
      calls++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const event = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'chatcmpl_synthetic', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      event({ role: 'assistant', content: '' }); event({ content: 'REA' });
      await new Promise(done => setTimeout(done, 30)); event({ content: 'DY' }); event({}, 'stop');
      res.end('data: [DONE]\n\n');
    } catch (error) { diagnostics.rejected.push(error.name); res.writeHead(400).end('{}'); }
  }).listen(0, '127.0.0.1');
  fixture.on('tlsClientError', error => diagnostics.tlsErrors.push(error.code));
  await new Promise(done => fixture.once('listening', done));
  const config = `model:\n  default: synthetic-external-model\n  provider: suite_fixture\nproviders:\n  suite_fixture:\n    base_url: https://127.0.0.1:${fixture.address().port}/v1\n    key_env: EMBERPATH_API_KEY\n    api_mode: chat_completions\n    ssl_ca_cert: ${authority}\ndisplay:\n  streaming: true\nagent:\n  max_turns: 1\n  learning_mode: false\ncompression:\n  enabled: false\nmemory:\n  memory_enabled: false\n  user_profile_enabled: false\nskills:\n  auto_load: false\ntelemetry:\n  enabled: false\n`;
  await writeFile(join(profile, 'config.yaml'), config, { mode: 0o600 });
  const file = join(scratch, 'native.env'), retained = 'obviously-fake-preserved-profile-value';
  await writeFile(file, `EMBERPATH_API_KEY=obviously-fake-fixture-key\nHERMES_CA_BUNDLE=${authority}\nSSL_CERT_FILE=${authority}\nRETAINED_PROFILE_CREDENTIAL=${retained}\n`, { mode: 0o600 });
  const original = await readFile(file);
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8' };
  const pythonDirectory = (await readdir(join(runtime, 'app/python'))).find(name => /^cpython-3\.13\.13-linux-/.test(name));
  assert(pythonDirectory);
  const sqliteProof = await execute(join(runtime, 'app/python', pythonDirectory, 'bin/python3.13'), ['-I', '-B', '-c',
    'import sqlite3,sys; assert sqlite3.sqlite_version_info >= (3,51,3); db=sqlite3.connect(sys.argv[1]); assert db.execute("PRAGMA journal_mode=WAL").fetchone()[0]=="wal"; db.execute("CREATE TABLE preserved(value TEXT)"); db.execute("INSERT INTO preserved VALUES (?)", ("synthetic",)); db.commit(); db.close(); db=sqlite3.connect(sys.argv[1]); assert db.execute("SELECT value FROM preserved").fetchone()[0]=="synthetic"; print(sqlite3.sqlite_version)', join(scratch, 'synthetic.sqlite')], { env, timeout: 20_000 });
  assert.equal(sqliteProof.stdout.trim(), descriptor.provenance.sqlite);
  const executable = join(runtime, descriptor.executable), args = ['--env-file', file, '--profile-path', profile];
  const beforePreflight = (await readdir(profile)).sort();
  const uninitialized = await execute(executable, [...args, '--native-preflight'], { env, timeout: 60_000 });
  assert.equal(uninitialized.stdout.trim(), 'hermes-agent ' + descriptor.version);
  assert.deepEqual((await readdir(profile)).sort(), beforePreflight, 'Preflight must not initialize the selected profile');
  const initialized = await execute(executable, [...args, '--native-init-profile'], { env, timeout: 20_000 });
  assert.equal(JSON.parse(initialized.stdout).initialized, true);
  const verified = await execute(executable, [...args, '--native-verify-profile'], { env, timeout: 20_000 });
  assert.equal(JSON.parse(verified.stdout).readOnly, true);
  const version = await execute(executable, [...args, '--native-preflight'], { env, timeout: 60_000 });
  assert.equal(version.stdout.trim(), 'hermes-agent ' + descriptor.version);
  const result = await execute(executable, [...args, '--native-acceptance'], { env, timeout: 90_000, maxBuffer: 1024 * 1024 });
  const acceptance = JSON.parse(result.stdout.trim());
  assert.equal(acceptance.ok, true); assert.equal(acceptance.streaming, true);
  assert.equal(calls, 1, 'A harmless acceptance turn must not replay');
  assert.deepEqual(await readFile(file), original);
  assert.equal(await readFile(join(profile, 'config.yaml'), 'utf8'), config);
  await assert.rejects(execute(executable, [...args, '--native-preflight'], { env: { ...env, HERMES_HOME: home }, timeout: 20_000 }));
  await chmod(file, 0o644);
  await assert.rejects(execute(executable, [...args, '--native-preflight'], { env, timeout: 20_000 }));
  console.log(JSON.stringify({ product: descriptor.product, version: descriptor.version, artifactSHA256: descriptor.sha256,
    isolatedProfile: true, preflightBeforeInitialization: true, nativeChatGeneration: true, streaming: true, privateCaVerified: true, fixedSqliteWalReopen: true, existingCredentialBytesRetained: true,
    wrongProfileAndWideEnvironmentRefused: true, inferenceRuntimeInstalled: false, productionCutover: false }));
} finally {
  if (calls !== 1) console.error(JSON.stringify({ fixtureDiagnostics: diagnostics, generationCalls: calls }));
  if (fixture) { fixture.closeAllConnections(); await new Promise(done => fixture.close(done)); }
  await rm(scratch, { recursive: true, force: true });
}
