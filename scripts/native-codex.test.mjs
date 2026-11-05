import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, symlink, link, chmod, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acceptanceSelection, runAcceptance } from '../tooling/native-codex/acceptance.mjs';
const execute = promisify(execFile);
const selection = { model: 'synthetic-external-model', model_provider: 'synthetic', model_providers: { synthetic: { base_url: 'https://models.example.com/v1', env_key: 'SYNTHETIC_API_KEY', wire_api: 'responses', requires_openai_auth: false } } };
test('native acceptance selects only canonical external HTTPS Responses providers with protected credential references', () => {
  const env = { SYNTHETIC_API_KEY: 'obviously-fake-key' };
  assert.equal(acceptanceSelection(selection, env).envKey, 'SYNTHETIC_API_KEY');
  for (const base_url of ['http://models.example.com', 'https://user:password@models.example.com', 'https://models.example.com/v1?key=synthetic', 'https://models.example.com/v1#fragment', 'https://models.example.com/../v1', 'https://models.example.com/%76%31', 'https://models.example.com//v1']) assert.throws(() => acceptanceSelection({ ...selection, model_providers: { synthetic: { ...selection.model_providers.synthetic, base_url } } }, env));
  for (const patch of [{ auth: { command: 'never-run' } }, { gateway_oauth: {} }, { http_headers: {} }, { requires_openai_auth: true }, { wire_api: 'chat' }, { env_key: 'MISSING_KEY' }]) assert.throws(() => acceptanceSelection({ ...selection, model_providers: { synthetic: { ...selection.model_providers.synthetic, ...patch } } }, env));
});
test('native acceptance isolates configuration and credentials, validates one harmless event stream and preserves original inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-acceptance-unit-')), profile = join(root, 'profile'), environment = join(root, 'native.env');
  await mkdir(profile, { mode: 0o700 }); const config = 'original profile, not a generated acceptance config';
  await writeFile(join(profile, 'config.toml'), config, { mode: 0o600 }); await writeFile(environment, 'SYNTHETIC_API_KEY=obviously-fake-key\n', { mode: 0o600 });
  let temporaryHome, calls = 0;
  try {
    const relayFactory = async () => ({ baseURL: 'http://127.0.0.1:1/v1', capability: 'synthetic-loopback-capability', verified: () => true, close: async () => {} });
    const native = async (args, env, cwd, timeout) => {
      calls++; assert(!env.UNRELATED_SECRET && !env.SYNTHETIC_API_KEY); assert.equal(env.MAGNUS_CODEX_ACCEPTANCE_KEY, 'synthetic-loopback-capability'); assert.notEqual(env.CODEX_HOME, profile); temporaryHome = env.HOME;
      assert(cwd.startsWith(temporaryHome.slice(0, temporaryHome.lastIndexOf('/')))); assert(timeout <= 60000);
      if (args[0] === '--version') return 'codex-cli 0.166.0\n';
      const temporaryConfig = await readFile(join(env.CODEX_HOME, 'config.toml'), 'utf8');
      assert(!temporaryConfig.includes('original profile')); assert(!temporaryConfig.includes('mcp_servers')); assert(!temporaryConfig.includes('obviously-fake-key')); assert(temporaryConfig.includes('hooks = false') && temporaryConfig.includes('apps = false') && temporaryConfig.includes('shell_tool = false'));
      assert(args.includes('read-only') && args.includes('--ephemeral') && args.includes('--ignore-rules') && args.includes('--ignore-user-config') && args.includes('mcp_servers={}'));
      return JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'Model metadata for `synthetic-external-model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.' } }) + '\n' + JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'READY' } }) + '\n' + JSON.stringify({ type: 'turn.completed' });
    };
    assert.deepEqual(await runAcceptance({ profile, environment, env: { SYNTHETIC_API_KEY: 'obviously-fake-key', UNRELATED_SECRET: 'must-not-inherit' }, native, relayFactory, parseToml: () => selection, version: '0.166.0' }), { ok: true, product: '@openai/codex', version: '0.166.0', generation: true, streaming: true, externalInference: true });
    assert.equal(calls, 2); await assert.rejects(access(temporaryHome)); assert.equal(await readFile(join(profile, 'config.toml'), 'utf8'), config);
    await assert.rejects(runAcceptance({ profile, environment, env: { SYNTHETIC_API_KEY: 'obviously-fake-key', NODE_TLS_REJECT_UNAUTHORIZED: '0' }, native, relayFactory, parseToml: () => selection, version: '0.166.0' }), /Unsafe runtime/);
    await assert.rejects(runAcceptance({ profile, environment, env: { SYNTHETIC_API_KEY: 'obviously-fake-key' }, relayFactory, native: async args => args[0] === '--version' ? 'codex-cli 0.166.0' : '{"type":"item.completed","item":{"type":"command_execution"}}\n{"type":"turn.completed"}', parseToml: () => selection, version: '0.166.0' }), /harmless assistant/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('native profile selection refuses duplicate/alternate flags, links, wide permissions and conflicting saved overrides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-launcher-unit-')), profile = join(root, 'profile'), envFile = join(root, 'native.env');
  try {
    await mkdir(profile, { mode: 0o700 }); await writeFile(envFile, 'SYNTHETIC_API_KEY=obviously-fake-key\n', { mode: 0o600 });
    await copyFile(new URL('../tooling/native-codex/launcher.mjs', import.meta.url), join(root, 'launcher.mjs'));
    await mkdir(join(root, 'node_modules/@openai/codex/bin'), { recursive: true });
    await writeFile(join(root, 'node_modules/@openai/codex/bin/codex.js'), "console.log('codex-cli 0.166.0');\n");
    const run = args => execute(process.execPath, [join(root, 'launcher.mjs'), '--profile-path', profile, '--env-file', envFile, ...args], { env: { PATH: process.env.PATH }, timeout: 5000 });
    assert.equal((await run(['--version'])).stdout.trim(), 'codex-cli 0.166.0');
    for (const args of [['--profile-path', profile, '--version'], ['--env-file', envFile, '--version'], ['--profile=other', '--version'], ['-p', 'other', '--version']]) await assert.rejects(run(args));
    await link(envFile, join(root, 'hardlink')); await assert.rejects(run(['--version'])); await rm(join(root, 'hardlink'));
    await chmod(envFile, 0o644); await assert.rejects(run(['--version'])); await chmod(envFile, 0o600);
    await symlink(profile, join(root, 'alias')); await assert.rejects(execute(process.execPath, [join(root, 'launcher.mjs'), '--profile-path', join(root, 'alias'), '--env-file', envFile, '--version'], { env: { PATH: process.env.PATH } }));
    await writeFile(envFile, 'CODEX_HOME=/opt/another-profile\n', { mode: 0o600 }); await assert.rejects(run(['--version']));
    await writeFile(envFile, '', { mode: 0o600 }); await symlink(envFile, join(profile, 'config.toml')); await assert.rejects(run(['--version']));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('verification transport refuses tool-bearing model events before exposing them to native execution', async () => {
  const { safeVerificationEvent } = await import('../tooling/native-codex/verification-relay.mjs');
  assert(safeVerificationEvent({ type: 'response.output_text.delta', delta: 'READY' }));
  for (const event of [{ type: 'response.function_call_arguments.delta', delta: '{}' }, { type: 'response.output_item.added', item: { type: 'function_call', name: 'synthetic_forbidden_tool' } }, { type: 'response.completed', response: { output: [{ type: 'function_call', name: 'synthetic_forbidden_tool' }] } }, { type: 'response.content_part.added', part: { type: 'input_image' } }]) assert.equal(safeVerificationEvent(event), false);
});
test('actual HTTPS verification relay strips tools, verifies TLS, refuses redirects and blocks tool responses', async () => {
  const { createServer } = await import('node:https');
  const { verificationRelay } = await import('../tooling/native-codex/verification-relay.mjs');
  const root = await mkdtemp(join(tmpdir(), 'codex-relay-security-')), certificate = join(root, 'fixture.pem'), key = join(root, 'fixture.key');
  let server, mode = 'valid', calls = 0;
  try {
    await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1']);
    server = createServer({ cert: await readFile(certificate), key: await readFile(key) }, async (incoming, outgoing) => {
      calls++; assert.equal(incoming.headers.authorization, 'Bearer obviously-fake-key');
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); assert.deepEqual(body.tools, []); assert.equal(body.tool_choice, 'none');
      if (mode === 'redirect') { outgoing.writeHead(302, { Location: 'https://elsewhere.example.com/responses' }).end(); return; }
      outgoing.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const event = value => outgoing.write('data: ' + JSON.stringify(value) + '\n\n');
      if (mode === 'tool') event({ type: 'response.output_item.added', item: { type: 'function_call', name: 'synthetic_forbidden_tool' } });
      else { event({ type: 'response.created', response: { output: [] } }); event({ type: 'response.output_text.delta', delta: 'READY' }); event({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'READY' }] }] } }); }
      outgoing.end();
    }).listen(0, '127.0.0.1'); await new Promise(done => server.once('listening', done));
    for (const current of ['valid', 'tool', 'redirect', 'bad-ca']) {
      mode = current;
      const relay = await verificationRelay({ selected: { model: selection.model, baseURL: `https://127.0.0.1:${server.address().port}/v1`, envKey: 'SYNTHETIC_API_KEY' }, env: { SYNTHETIC_API_KEY: 'obviously-fake-key', ...(current === 'bad-ca' ? {} : { CODEX_CA_CERTIFICATE: certificate }) }, expected: 'READY' });
      try {
        const response = await fetch(relay.baseURL + '/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + relay.capability, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: selection.model, stream: true, tools: [{ type: 'function', name: 'must_be_removed' }] }) });
        assert.equal(response.status, current === 'valid' ? 200 : 502); const text = await response.text(); assert(!text.includes('obviously-fake-key') && !text.includes('synthetic_forbidden_tool'));
        assert.equal(relay.verified(), current === 'valid');
        assert.equal((await fetch(relay.baseURL + '/responses', { method: 'POST' })).status, 403);
      } finally { await relay.close(); }
    }
    assert.equal(calls, 3, 'untrusted TLS never reaches the external HTTP service');
  } finally { if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); } await rm(root, { recursive: true, force: true }); }
});
