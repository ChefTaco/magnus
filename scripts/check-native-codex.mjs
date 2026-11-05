#!/usr/bin/env node
// Explicit developer proof against a disposable external HTTPS protocol fixture.
// No existing Codex profile, sign-in session or inference service is selected.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:https';
import { zstdDecompressSync, gunzipSync } from 'node:zlib';
const execute = (program, args, options = {}) => new Promise((done, reject) => {
  const child = execFile(program, args, { encoding: 'utf8', ...options }, (error, stdout, stderr) => {
    if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
    else done({ stdout, stderr });
  });
  child.stdin.on('error', () => undefined);
  child.stdin.end(); // Codex intentionally waits for EOF even with an explicit prompt.
});
const argument = process.argv.indexOf('--artifact');
assert(argument >= 0 && process.argv[argument + 1], '--artifact PRIVATE_DESCRIPTOR is required');
const descriptorFile = resolve(process.argv[argument + 1]), descriptor = JSON.parse(await readFile(descriptorFile));
assert.equal(descriptor.product, '@openai/codex');
assert(/^[A-Za-z0-9._-]+\.tar\.gz$/.test(descriptor.archive));
const archive = join(dirname(descriptorFile), descriptor.archive);
assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), descriptor.sha256);
const scratch = await mkdtemp(join(tmpdir(), 'native-codex-proof-'));
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
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', authorityKey, '-out', authority, '-subj', '/CN=Synthetic test authority', '-addext', 'basicConstraints=critical,CA:TRUE', '-days', '1']);
  await execute('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', '/CN=localhost']);
  await writeFile(extensions, 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n', { mode: 0o600 });
  await execute('openssl', ['x509', '-req', '-in', csr, '-CA', authority, '-CAkey', authorityKey, '-set_serial', '12345', '-out', cert, '-days', '1', '-extfile', extensions]);
  await chmod(key, 0o600);
  fixture = createServer({ cert: await readFile(cert), key: await readFile(key) }, async (req, res) => {
    try {
      diagnostics.paths.push(req.url);
      assert.equal(req.headers.authorization, 'Bearer obviously-fake-fixture-key');
      if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(404).end('{}'); return; }
      const chunks = []; let size = 0;
      for await (const bytes of req) { chunks.push(bytes); size += bytes.length; assert(size < 1024 * 1024); }
      let raw = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'zstd') raw = zstdDecompressSync(raw, { maxOutputLength: 1024 * 1024 });
      else if (req.headers['content-encoding'] === 'gzip') raw = gunzipSync(raw, { maxOutputLength: 1024 * 1024 });
      const body = JSON.parse(raw.toString());
      assert.equal(body.model, 'synthetic-external-model');
      assert.equal(body.stream, true);
      assert.deepEqual(body.tools, []); assert.equal(body.tool_choice, 'none'); assert.equal(body.parallel_tool_calls, false);
      diagnostics.toolNames = [];
      calls++;
      const message = { id: 'msg_synthetic_' + calls, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'READY', annotations: [] }] };
      const response = { id: 'resp_synthetic_' + calls, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: body.model,
        output: [message], usage: { input_tokens: 8, output_tokens: 1, total_tokens: 9, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const event = (type, extra) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`);
      event('response.created', { response: { ...response, status: 'in_progress', output: [] } });
      event('response.output_item.added', { output_index: 0, item: { ...message, status: 'in_progress', content: [] } });
      event('response.content_part.added', { item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      event('response.output_text.delta', { item_id: message.id, output_index: 0, content_index: 0, delta: 'READY' });
      event('response.output_text.done', { item_id: message.id, output_index: 0, content_index: 0, text: 'READY' });
      event('response.content_part.done', { item_id: message.id, output_index: 0, content_index: 0, part: message.content[0] });
      event('response.output_item.done', { output_index: 0, item: message });
      event('response.completed', { response });
      res.end();
    } catch (error) { diagnostics.rejected.push(error.name); res.writeHead(400).end('{}'); }
  }).listen(0, '127.0.0.1');
  fixture.on('tlsClientError', error => diagnostics.tlsErrors.push(error.code));
  await new Promise(done => fixture.once('listening', done));
  const config = `model = "synthetic-external-model"\nmodel_provider = "suite_fixture"\napproval_policy = "never"\nsandbox_mode = "read-only"\nweb_search = "disabled"\ncheck_for_update_on_startup = false\n[model_providers.suite_fixture]\nname = "Disposable HTTPS fixture"\nbase_url = "https://127.0.0.1:${fixture.address().port}/v1"\nenv_key = "EMBERPATH_API_KEY"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\nstream_idle_timeout_ms = 5000\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n`;
  await writeFile(join(profile, 'config.toml'), config, { mode: 0o600 });
  const file = join(scratch, 'native.env'), retained = 'obviously-fake-preserved-profile-value';
  await writeFile(file, `EMBERPATH_API_KEY=obviously-fake-fixture-key\nCODEX_CA_CERTIFICATE=${authority}\nSSL_CERT_FILE=${authority}\nRETAINED_PROFILE_CREDENTIAL=${retained}\n`, { mode: 0o600 });
  const original = await readFile(file);
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8' };
  const executable = join(runtime, descriptor.executable), args = ['--env-file', file, '--profile-path', profile];
  const version = await execute(executable, [...args, '--version'], { env, timeout: 20_000 });
  assert.equal(version.stdout.trim(), 'codex-cli ' + descriptor.version);
  assert.deepEqual(descriptor.acceptanceArguments, ['--env-file', '@ENV_FILE@', '--profile-path', '@PROFILE@', '--native-acceptance']);
  const result = await execute(executable, [...args, '--native-acceptance'], { env, timeout: 90_000, maxBuffer: 1024 * 1024 });
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, product: '@openai/codex', version: descriptor.version, generation: true, streaming: true, externalInference: true });
  assert(!result.stdout.includes('obviously-fake-fixture-key') && !result.stderr.includes('obviously-fake-fixture-key'));
  assert.equal(calls, 1, 'A harmless acceptance turn must not replay');
  assert.deepEqual(await readFile(file), original);
  assert.equal(await readFile(join(profile, 'config.toml'), 'utf8'), config);
  await assert.rejects(execute(executable, [...args, '--version'], { env: { ...env, CODEX_HOME: home }, timeout: 20_000 }));
  await chmod(file, 0o644);
  await assert.rejects(execute(executable, [...args, '--version'], { env, timeout: 20_000 }));
  console.log(JSON.stringify({ product: descriptor.product, version: descriptor.version, artifactSHA256: descriptor.sha256,
    isolatedProfile: true, nativeResponsesGeneration: true, streaming: true, privateCaVerified: true, existingCredentialBytesRetained: true,
    wrongProfileAndWideEnvironmentRefused: true, inferenceRuntimeInstalled: false, productionCutover: false }));
} finally {
  if (calls !== 1) console.error(JSON.stringify({ fixtureDiagnostics: diagnostics, generationCalls: calls }));
  if (fixture) { fixture.closeAllConnections(); await new Promise(done => fixture.close(done)); }
  await rm(scratch, { recursive: true, force: true });
}
