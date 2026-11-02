import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { managedExecution } from '/source/packages/agent/dist/security/managed-context.js';
import { contextRelease, inspectContextAdoption, manageContextAdoption } from '/source/packages/agent/dist/executors/ardent-context-adoption.js';
import { ardentUserUnit, packageTreeDigest } from '/source/packages/agent/dist/executors/ardent-manager.js';

execFileSync('/usr/sbin/useradd', ['-m', '-u', '1001', '-g', 'operator', 'operator']);
await symlink(process.execPath, '/usr/bin/node').catch(error => { if (error.code !== 'EEXIST') throw error; });
const root = { owner: 'operator', home: '/home/operator', root: '/home/operator/.ardent', install: '/home/operator/.local/share/ardent' };
const profile = 'example';
const name = '@hivemagnus/ardent';
const packagePath = join(root.install, 'node_modules', name);
const profilePath = join(root.root, 'profiles', profile);
await mkdir(join(root.home, '.local/share'), { recursive: true });
await cp('/fixture/fixture', root.install, { recursive: true });
const baseManifest = JSON.parse(await readFile(join(packagePath, 'package.json'), 'utf8'));
assert.equal(baseManifest.version, '1.1.2');
assert.equal(baseManifest.dependencies['@hivemagnus/emberfold'], undefined);
const originalExtension = 'export const unrelatedCapability = "preserve-exactly";\n';
await writeFile(join(packagePath, 'dist/extension-fixture.js'), originalExtension);
await cp('/fixture/codex.mjs', join(root.home, 'codex.mjs'));
await chmod(join(root.home, 'codex.mjs'), 0o755);
const { initProfile } = await import(join(packagePath, 'dist/config.js'));
await initProfile(profilePath, { profile, apiPort: 18120 });
const require = createRequire(join(packagePath, 'package.json'));
const YAML = require('yaml');
const dotenv = require('dotenv');
const configPath = join(profilePath, 'config.yaml');
const config = YAML.parse(await readFile(configPath, 'utf8'));
config.execution.backend = 'codex';
config.providers.codex.command = join(root.home, 'codex.mjs');
config.providers.codex.model = 'gpt-6.1-sol';
config.providers.codex.auth_mode = 'chatgpt';
config.a2a.enabled = false;
for (const channel of Object.values(config.channels)) channel.enabled = false;
config.memory = { provider: 'none' };
config.research.enabled = false;
config.plugins = [];
await writeFile(configPath, YAML.stringify(config), { mode: 0o600 });
const policyBytes = JSON.stringify({ schema_version: 1, revision: 1,
  primary: { codex: { model: 'gpt-6.1-sol', reasoning_effort: 'medium' }, llamacpp: { mode: 'profile' } },
  compaction: { enabled: true, routes: [{ backend: 'codex', model: 'gpt-6.1-sol', reasoning_effort: 'medium' }],
    prompt_budget_tokens: 32000, output_reserve_tokens: 8000, checkpoint_max_tokens: 4000, recent_max_tokens: 8000, trigger_ratio: 0.7 } });
await mkdir(join(root.root, 'model-policy'), { recursive: true, mode: 0o700 });
const policyPath = join(root.root, 'model-policy/active.json');
await writeFile(policyPath, policyBytes, { mode: 0o600 });
const { parseModelPolicy } = await import(join(packagePath, 'dist/model-policy.js'));
const { TaskStore } = await import(join(packagePath, 'dist/store.js'));
const { ContextCheckpoints } = await import(join(packagePath, 'dist/context-checkpoints.js'));
const databasePath = join(profilePath, 'state/ardent.sqlite');
const store = new TaskStore(databasePath);
const session = store.session('fixture', 'direct', 'original');
for (const prompt of ['Original first exchange', 'Original second exchange', 'Original third exchange']) {
  const task = store.accept({ caller: 'fixture', context: 'direct', sessionId: session.id, prompt, backend: 'codex', deadlineMs: Date.now() + 60000 });
  store.startQueued(task.id); store.finishWithAssistant(task.id, 'completed', 'Original answer');
}
const unknown = store.accept({ caller: 'fixture', context: 'direct', prompt: 'Uncertain external effect', backend: 'codex', deadlineMs: Date.now() + 60000 });
store.startQueued(unknown.id); store.setState(unknown.id, 'unknown', null, 'Retain uncertainty');
const summary = async () => JSON.stringify({ items: [{ kind: 'open_item', text: 'Original unfinished work', source_message_ids: [1], historical_status: 'historical_unverified' }] });
const oldManager = new ContextCheckpoints(store, summary);
await oldManager.prepare({ id: 'preview:original', session_id: session.id, caller: 'fixture', context: 'direct', prompt: '' },
  'Original policy', [], { ...parseModelPolicy(policyBytes), path: policyPath }, AbortSignal.timeout(5000), { apply: true, force: true });
const originalMessages = JSON.stringify(store.db.prepare('SELECT * FROM session_messages ORDER BY sequence').all());
store.close();
await chmod(databasePath, 0o600);
const unitPath = join(root.home, '.config/systemd/user', `ardent@${profile}.service`);
await mkdir(join(root.home, '.config/systemd/user'), { recursive: true });
await writeFile(unitPath, ardentUserUnit(root, profile, name));
execFileSync('/usr/bin/chown', ['-R', 'operator:operator', root.home]);
process.env.AGENT_INSTALL_DIR = '/tmp/context-manager';
process.env.NODE_MANAGER_SECRET = 'fixture-agent-secret-must-not-reach-owner';
process.env.RESULT_SIGNING_SECRET = 'fixture-signing-secret-must-not-reach-owner';
let gateway;
const tokenEnv = dotenv.parse(await readFile(join(profilePath, '.env')));
const token = tokenEnv[config.api.token_env];
const health = async () => {
  const response = await fetch('http://127.0.0.1:18120/api/v1/profile', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(1000) });
  const data = await response.json();
  assert.equal(data.profile, profile); return response.ok;
};
async function service(action) {
  if (action === 'service-stop') {
    assert.ok(gateway && gateway.exitCode === null);
    const child = gateway;
    const exited = new Promise((accept, reject) => { child.once('close', code => code === 0 || code === null ? accept() : reject(new Error('Gateway failed to stop'))); });
    process.kill(-child.pid, 'SIGTERM');
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Gateway did not stop')), 15000).unref())]);
    gateway = undefined;
    await assert.rejects(health());
    return;
  }
  gateway = spawn('/usr/bin/node', [join(packagePath, 'dist/cli.js'), '--profile', profile, 'gateway', 'run'],
    { detached: true, uid: 1001, gid: Number(execFileSync('/usr/bin/id', ['-g', root.owner], { encoding: 'utf8' }).trim()),
      env: { PATH: '/usr/bin:/bin', HOME: root.home, USER: root.owner, LANG: 'C.UTF-8', ARDENT_HOME: root.root }, stdio: ['ignore', 'ignore', 'inherit'] });
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if (await health()) return; } catch (error) { if (gateway.exitCode !== null) throw new Error('Gateway failed before becoming healthy', { cause: error }); }
    await new Promise(accept => setTimeout(accept, 100));
  }
  throw new Error('Gateway health deadline exceeded');
}
const hooks = { packageName: async () => name, profiles: async () => [profile], treeDigest: packageTreeDigest,
  service, checkService: async () => { assert.equal(await readFile(unitPath, 'utf8'), ardentUserUnit(root, profile, name)); } };
const release = await contextRelease();
const input = { release_id: randomUUID(), expected_bundle_sha256: release.sha256,
  expected_base_sha256: await packageTreeDigest(packagePath), expected_policy_sha256: createHash('sha256').update(policyBytes).digest('hex'),
  expected_config_sha256: createHash('sha256').update(await readFile(configPath)).digest('hex') };
const configBytes = await readFile(configPath);
const credentialBytes = await readFile(join(profilePath, '.env'));
const invoke = action => managedExecution.run({ commandId: 'fixture-' + randomUUID(), requestSha256: 'a'.repeat(64),
  claim: { leaseId: 'fixture-lease', nodeId: 'fixture', nodeFqdn: 'node.example.com' },
  coordination: { version: 1, resourceKey: 'node:fixture:ardent', fence: '1', expiresAt: Date.now() + 850000 } },
  () => manageContextAdoption(root, profile, action, input, hooks));
try {
  await service('service-start');
  const staged = await invoke('context-stage');
  assert.equal(staged.state, 'prepared');
  assert.equal(staged.acceptance.rebuilt, true);
  assert.equal((await inspectContextAdoption(root, profile, input.release_id)).state, 'prepared');
  await assert.rejects(inspectContextAdoption({ ...root, owner: 'different' }, profile, input.release_id), /different target/);
  await assert.rejects(inspectContextAdoption(root, 'different', input.release_id), /different target/);
  assert.equal(await packageTreeDigest(packagePath), input.expected_base_sha256);
  const adopted = await invoke('context-adopt');
  assert.equal(adopted.state, 'active'); assert.equal(adopted.rollback_verified, true);
  assert.equal(await readFile(join(packagePath, 'dist/extension-fixture.js'), 'utf8'), originalExtension);
  assert.equal(JSON.parse(await readFile(join(packagePath, 'package.json'), 'utf8')).dependencies['@hivemagnus/emberfold'], '0.1.0');
  assert.equal(await health(), true);
  const rolledBack = await invoke('context-rollback');
  assert.equal(rolledBack.state, 'rolled-back');
  assert.equal(await packageTreeDigest(packagePath), input.expected_base_sha256);
  assert.deepEqual(await readFile(configPath), configBytes);
  assert.deepEqual(await readFile(join(profilePath, '.env')), credentialBytes);
  const reopened = new TaskStore(databasePath);
  assert.equal(JSON.stringify(reopened.db.prepare('SELECT * FROM session_messages ORDER BY sequence').all()), originalMessages);
  assert.equal(reopened.get(unknown.id).state, 'unknown'); reopened.close();
  console.log(JSON.stringify({ synthetic_container: true, provider: 'protocol-fixture', staged: true, adopted: true,
    compacted: true, continued: true, recovered: true, rebuilt: true, rollback_verified: true,
    original_sources_preserved: true, unknown_effects_preserved: true, credentials_preserved: true, unrelated_capabilities_preserved: true }));
} finally { if (gateway?.exitCode === null) await service('service-stop'); }
