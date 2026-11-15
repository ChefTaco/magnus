import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { NativeSnapshots, type SnapshotDependencies } from './index.js';
import { ardentUserUnit } from '../executors/ardent-manager.js';
import { runNativeSnapshot } from './cli.js';
import { sha256 } from './files.js';
import { assertNoNativeSnapshotReservation } from './reservation.js';

let base: string;
const uid = process.getuid!(), gid = process.getgid!();
beforeEach(async () => { base = await mkdtemp(join(tmpdir(), 'magnus-snapshot-')); await chmod(base, 0o700); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(base, { recursive: true, force: true }); });
async function fixture() {
  const home = join(base, 'operator'), root = join(home, '.ardent'), install = join(home, '.local/share/ardent'), agentInstall = join(base, 'agent');
  const profile = join(root, 'profiles', 'assistant'), unitDir = join(home, '.config/systemd/user');
  for (const path of [home, profile, install, agentInstall, unitDir]) await mkdir(path, { recursive: true, mode: 0o700 });
  const target = { owner: 'operator', home, root, install };
  await writeFile(join(profile, 'config.yaml'), 'schema_version: 1\nprofile: assistant\nname: Assistant\nexecution:\n  backend: llamacpp\na2a:\n  enabled: false\napi:\n  host: 127.0.0.1\n  port: 9910\n  token_env: ARDENT_API_TOKEN\n', { mode: 0o600 });
  await writeFile(join(profile, '.env'), 'ARDENT_API_TOKEN=fixture-only-token\n', { mode: 0o600 });
  await mkdir(join(profile, 'state'), { mode: 0o700 });
  const db = new DatabaseSync(join(profile, 'state/ardent.sqlite'));
  db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY,state TEXT); INSERT INTO tasks VALUES('fixture','completed'); CREATE TABLE channel_deliveries(id TEXT,state TEXT);"); db.close();
  await chmod(join(profile, 'state/ardent.sqlite'), 0o600);
  await writeFile(join(install, 'package-receipt.json'), JSON.stringify({ name: '@hivemagnus/ardent', version: '1.0.0' }), { mode: 0o600 });
  await writeFile(join(install, 'runtime.js'), '// fixture runtime; never executed\n', { mode: 0o640 });
  await chmod(join(install, 'runtime.js'), 0o640);
  await mkdir(join(install, 'bin'), { mode: 0o700 }); await symlink('../runtime.js', join(install, 'bin/runtime'));
  await writeFile(join(unitDir, 'ardent@assistant.service'), ardentUserUnit(target, 'assistant'), { mode: 0o644 });
  vi.stubEnv('AGENT_INSTALL_DIR', agentInstall);
  const units = new Map<string, { active: boolean; enabled: string; clean: boolean; cgroupEmpty: boolean }>([
    ['magnus-agent.service', { active: true, enabled: 'enabled', clean: true, cgroupEmpty: false }],
    ['ardent@assistant.service', { active: true, enabled: 'enabled', clean: true, cgroupEmpty: false }],
  ]);
  const actions: string[] = [];
  const deps: Partial<SnapshotDependencies> = {
    privileged: () => true, rootUid: uid, root: async () => target,
    account: async () => ({ uid, gid, home }), machine: async () => 'fixture-machine-id',
    packageReceipt: async dir => JSON.parse(await readFile(join(dir, 'package-receipt.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return 'null'; throw error; })) as unknown,
    service: async (_target, unit, scope) => ({ unit, scope, ...(units.get(unit) ?? { active: false, enabled: 'not-found', clean: true, cgroupEmpty: true }) }),
    serviceAction: async (_target, unit, _scope, action) => {
      actions.push(action + ':' + unit);
      if (action === 'daemon-reload') {
        for (const [id, value] of units) if (id.startsWith('ardent@')) {
          const present = await lstat(join(unitDir, id)).then(() => true, () => false);
          if (!present) { value.active = false; value.cgroupEmpty = true; value.enabled = 'not-found'; }
          else if (value.enabled === 'not-found') value.enabled = 'disabled';
        }
      } else if (action === 'enable' || action === 'disable') units.get(unit)!.enabled = action === 'enable' ? 'enabled' : 'disabled';
      else if (action !== 'daemon-reload') { const value = units.get(unit)!; value.active = action === 'start'; value.cgroupEmpty = action === 'stop'; }
    },
  };
  const product = new NativeSnapshots(deps);
  const quiesce = async () => { const state = join(base, randomUUID()); const value = await product.quiesce(randomUUID(), state); return { state, value }; };
  return { target, product, deps, profile, install, unitDir, units, actions, quiesce };
}
describe('product-owned stopped native snapshots', () => {
  it('requires real privilege at the product boundary and rejects unknown CLI before any shutdown', async () => {
    const f = await fixture();
    await expect(new NativeSnapshots({ ...f.deps, privileged: () => false }).inspect()).rejects.toThrow('require root');
    await expect(runNativeSnapshot(['other'], f.product)).rejects.toThrow('Unsupported'); expect(f.actions).toEqual([]);
    await expect(runNativeSnapshot(['quiesce', '--request-file', '-'], f.product, async () => '{"state":"/run/test","session":"bad"}')).rejects.toThrow();
    expect(f.actions).toEqual([]);
  });
  it('discovers all profiles, captures shared runtime, policy, credentials and internal links with original metadata', async () => {
    const f = await fixture();
    await mkdir(join(f.target.root, 'model-policy'), { mode: 0o700 }); await writeFile(join(f.target.root, 'model-policy/active.json'), '{"fixture":true}', { mode: 0o600 });
    const inspect = await runNativeSnapshot(['inspect', '--request-file', '-'], f.product, async () => '{}');
    expect(inspect).toMatchObject({ schemaVersion: 1, profiles: [{ id: 'assistant' }] });
    const { state } = await f.quiesce(), bundle = join(base, 'bundle');
    const result = await f.product.capture(state, bundle); expect(result).toMatchObject({ profiles: ['assistant'], manifestSHA256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(f.actions.slice(0, 2)).toEqual(['stop:magnus-agent.service', 'stop:ardent@assistant.service']);
    expect((await lstat(join(bundle, 'files/runtime/runtime.js'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(bundle, 'files/root/profiles/assistant/.env'), 'utf8')).toContain('fixture-only');
    await expect(lstat(join(bundle, 'files/runtime/bin/runtime'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8')).trees.find((t: { label: string }) => t.label === 'runtime').entries)
      .toContainEqual(expect.objectContaining({ path: 'runtime.js', mode: 0o640, uid, gid }));
    await f.product.resume(state); expect(f.actions.slice(-2)).toEqual(['start:ardent@assistant.service', 'start:magnus-agent.service']);
    await expect(lstat(join(base, 'agent/.native-snapshot-reservation.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('discovers a later-created profile sharing the runtime and retains its disabled/inactive state', async () => {
    const f = await fixture(), second = join(f.target.root, 'profiles/second');
    await cp(f.profile, second, { recursive: true });
    await writeFile(join(second, 'config.yaml'), (await readFile(join(second, 'config.yaml'), 'utf8')).replace('profile: assistant', 'profile: second').replace('9910', '9911'));
    await writeFile(join(f.unitDir, 'ardent@second.service'), ardentUserUnit(f.target, 'second'), { mode: 0o644 });
    f.units.set('ardent@second.service', { active: false, enabled: 'disabled', clean: true, cgroupEmpty: true });
    const { state } = await f.quiesce(), bundle = join(base, 'bundle');
    expect((await f.product.capture(state, bundle)).profiles).toEqual(['assistant', 'second']);
    expect((await f.product.inspect()).trees.filter(t => t.label === 'runtime')).toHaveLength(1);
    await f.product.resume(state);
    expect(f.actions).not.toContain('start:ardent@second.service');
    expect(f.units.get('ardent@second.service')).toMatchObject({ active: false, enabled: 'disabled' });
  });
  it('restores an intentionally removed profile only after validating every tree; retains previous state and source activation', async () => {
    const f = await fixture();
    const first = await f.quiesce(), bundle = join(base, 'bundle'); await f.product.capture(first.state, bundle); await f.product.resume(first.state);
    await rm(f.profile, { recursive: true });
    const next = await f.quiesce(); expect(next.value).toHaveProperty('stoppedInventorySha256');
    const result = await f.product.restore(next.state, bundle, String(next.value.stoppedInventorySha256)); expect(result.activationAllowed).toBe(true);
    expect(await readFile(join(f.profile, '.env'), 'utf8')).toContain('fixture-only');
    expect((await lstat(join(f.install, 'runtime.js'))).mode & 0o777).toBe(0o640);
    expect((await readdir(f.target.home)).some(p => p.includes('-previous'))).toBe(true);
    await f.product.resume(next.state); expect(f.units.get('ardent@assistant.service')!.active).toBe(true);
  });
  it('refuses byte tampering, extra payloads, unsafe links and foreign target binding before promotion', async () => {
    const f = await fixture(), { state } = await f.quiesce(), bundle = join(base, 'bundle'); await f.product.capture(state, bundle);
    const before = await readFile(join(f.install, 'runtime.js'), 'utf8');
    await writeFile(join(bundle, 'files/runtime/runtime.js'), 'tampered');
    await expect(f.product.verify(bundle)).rejects.toThrow('differs');
    await expect(f.product.restore(state, bundle, String((await f.product.inspect()).inventorySha256))).rejects.toThrow('differs');
    expect(await readFile(join(f.install, 'runtime.js'), 'utf8')).toBe(before);
    await writeFile(join(bundle, 'files/runtime/runtime.js'), before); await chmod(join(bundle, 'files/runtime/runtime.js'), 0o600);
    await writeFile(join(bundle, 'files/root/extra'), 'undeclared', { mode: 0o600 });
    await expect(f.product.verify(bundle)).rejects.toThrow('shape'); await rm(join(bundle, 'files/root/extra'));
    await symlink('/etc/passwd', join(bundle, 'files/root/extra')); await expect(f.product.verify(bundle)).rejects.toThrow();
    await rm(join(bundle, 'files/root/extra'));
    const manifestPath = join(bundle, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.target.machineSHA256 = sha256('foreign'); await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(f.product.verify(bundle)).rejects.toThrow('another host');
  });
  it.each(['unknown', 'queued', 'running', 'unsupported-private-state'])('preserves %s journal rows and refuses activation without replay', async stateValue => {
    const f = await fixture(), db = new DatabaseSync(join(f.profile, 'state/ardent.sqlite'));
    db.prepare('UPDATE tasks SET state=?').run(stateValue); db.close();
    const { state } = await f.quiesce(), bundle = join(base, 'bundle'); await f.product.capture(state, bundle);
    await expect(f.product.resume(state)).rejects.toThrow('pending, uncertain or unsupported');
    const copy = new DatabaseSync(join(bundle, 'files/root/profiles/assistant/state/ardent.sqlite'), { readOnly: true });
    expect(copy.prepare('SELECT state FROM tasks').get()!['state']).toBe(stateValue); copy.close();
    expect(f.actions.every(a => !a.startsWith('start:'))).toBe(true);
  });
  it('holds failed/cgroup-occupied shutdown and retains the exact reservation; never force clears execution locks', async () => {
    const f = await fixture();
    f.deps.serviceAction = async (_t, unit, _scope, action) => { f.actions.push(action + ':' + unit); const value = f.units.get(unit)!; value.active = false; value.clean = false; };
    const product = new NativeSnapshots(f.deps), state = join(base, 'held');
    await expect(product.quiesce(randomUUID(), state)).rejects.toThrow('not proven clean');
    expect(JSON.parse(await readFile(join(state, 'journal.json'), 'utf8')).phase).toBe('held');
    await expect(product.resume(state)).rejects.toThrow('held');
    expect(await lstat(join(base, 'agent/.native-snapshot-reservation.json'))).toBeTruthy();
  });
  it('fails stale inventory expectations and protects unit/custom path boundaries before shutdown', async () => {
    const f = await fixture();
    await expect(f.product.quiesce(randomUUID(), join(base, 'stale'), undefined, '0'.repeat(64))).rejects.toThrow('changed before');
    expect(f.actions).toEqual([]);
    await writeFile(join(f.unitDir, 'ardent@assistant.service'), 'custom unit');
    await expect(f.product.inspect()).rejects.toThrow('exact generated');
  });
  it('blocks daemon startup and a second snapshot owner while a session is reserved', async () => {
    const f = await fixture(); const first = await f.quiesce();
    await expect(assertNoNativeSnapshotReservation()).rejects.toThrow('holds this manager stopped');
    await expect(f.product.quiesce(randomUUID(), join(base, 'second'))).rejects.toMatchObject({ code: 'EEXIST' });
    await f.product.resume(first.state); await expect(assertNoNativeSnapshotReservation()).resolves.toBeUndefined();
  });
  it('refuses gateway and scheduler owner locks after stop without clearing them', async () => {
    const f = await fixture(), lock = join(f.profile, 'state', '.tick.lock');
    await writeFile(lock, '{"pid":123456}', { mode: 0o600 });
    await expect(f.product.quiesce(randomUUID(), join(base, 'locked'))).rejects.toThrow('execution lock remains');
    expect(await readFile(lock, 'utf8')).toContain('123456');
  });
  it('retains held staging and leaves every original tree untouched when complete runtime validation fails', async () => {
    const f = await fixture(), { state } = await f.quiesce(), bundle = join(base, 'bundle'); await f.product.capture(state, bundle);
    const original = await readFile(join(f.install, 'runtime.js'), 'utf8');
    const deps = { ...f.deps, packageReceipt: async (path: string) => path.includes('-stage') ? null : f.deps.packageReceipt!(path) };
    const product = new NativeSnapshots(deps);
    await expect(product.restore(state, bundle, (await product.inspect()).inventorySha256)).rejects.toThrow('Staged runtime');
    expect(await readFile(join(f.install, 'runtime.js'), 'utf8')).toBe(original);
    expect(JSON.parse(await readFile(join(state, 'journal.json'), 'utf8')).promotions.every((p: { phase: string }) => p.phase === 'prepared')).toBe(true);
    expect(f.actions.some(a => a.startsWith('start:'))).toBe(false);
  });
  it('restores source user enablement explicitly, then resumes without changing it', async () => {
    const f = await fixture(), first = await f.quiesce(), bundle = join(base, 'bundle'); await f.product.capture(first.state, bundle); await f.product.resume(first.state);
    f.units.get('ardent@assistant.service')!.enabled = 'disabled';
    const next = await f.quiesce();
    await f.product.restore(next.state, bundle, String(next.value.stoppedInventorySha256));
    expect(f.actions).toContain('enable:ardent@assistant.service');
    const start = f.actions.length; await f.product.resume(next.state);
    expect(f.actions.slice(start)).toEqual(['start:ardent@assistant.service', 'start:magnus-agent.service']);
  });
  it('recovers fully missing profile storage, shared runtime parents and user unit with source enablement and active state', async () => {
    const f = await fixture(), first = await f.quiesce(), bundle = join(base, 'bundle'); await f.product.capture(first.state, bundle); await f.product.resume(first.state);
    await rm(f.target.root, { recursive: true }); await rm(join(f.target.home, '.local'), { recursive: true }); await rm(join(f.unitDir, 'ardent@assistant.service'));
    Object.assign(f.units.get('ardent@assistant.service')!, { active: false, cgroupEmpty: true, enabled: 'not-found' });
    const current = await f.quiesce();
    expect((await f.product.inspect()).profiles).toEqual([]);
    await f.product.restore(current.state, bundle, String(current.value.stoppedInventorySha256));
    expect(await readFile(join(f.install, 'runtime.js'), 'utf8')).toContain('never executed');
    expect(await readFile(join(f.unitDir, 'ardent@assistant.service'), 'utf8')).toBe(ardentUserUnit(f.target, 'assistant'));
    expect(f.units.get('ardent@assistant.service')!.enabled).toBe('enabled');
    await f.product.resume(current.state); expect(f.units.get('ardent@assistant.service')!.active).toBe(true);
  });
  it('rejects external links, model assets, undeclared profiles and changed retained manager keys', async () => {
    const f = await fixture();
    await symlink('/etc/passwd', join(f.install, 'escape'));
    await expect(f.product.inspect()).rejects.toThrow('link escapes'); await rm(join(f.install, 'escape'));
    await writeFile(join(f.target.root, 'model.gguf'), 'fixture', { mode: 0o600 });
    await expect(f.product.inspect()).rejects.toThrow('Model assets'); await rm(join(f.target.root, 'model.gguf'));
    await writeFile(join(f.target.root, 'profiles/undeclared'), 'fixture', { mode: 0o600 });
    await expect(f.product.inspect()).rejects.toThrow('Undeclared'); await rm(join(f.target.root, 'profiles/undeclared'));
    const { state } = await f.quiesce(), bundle = join(base, 'bundle'); await f.product.capture(state, bundle);
    await writeFile(join(base, 'agent/.env'), 'NODE_MANAGER_SECRET=fixture-only-changed\n', { mode: 0o600 });
    await expect(f.product.resume(state)).rejects.toThrow('inventory changed');
  });
  it('archives declared internal plugin bytes without importing them and holds unproven startup capability', async () => {
    const f = await fixture(), module = join(f.profile, 'fixture-plugin.mjs');
    await writeFile(module, 'throw new Error("Snapshots must never import a captured plugin");\n', { mode: 0o600 });
    const config = join(f.profile, 'config.yaml'); await writeFile(config, (await readFile(config, 'utf8')) + 'plugins:\n  - ' + module + '\n');
    const { state } = await f.quiesce(), bundle = join(base, 'bundle');
    expect((await f.product.capture(state, bundle)).safety).toMatchObject({ unsupported: 1 });
    await expect(f.product.resume(state)).rejects.toThrow('unsupported work');
    expect(await readFile(join(bundle, 'files/root/profiles/assistant/fixture-plugin.mjs'), 'utf8')).toContain('must never import');
  });
  it('includes pending sqlite3 jobs and extensionless private journals in the captured activation hold', async () => {
    const f = await fixture();
    for (const [file, sql] of [['jobs.sqlite3', "CREATE TABLE job_windows(state TEXT); INSERT INTO job_windows VALUES('retry');"], ['private-journal', 'CREATE TABLE private_queue(payload TEXT);']]) {
      const db = new DatabaseSync(join(f.profile, 'state', file!)); db.exec(sql!); db.close();
    }
    const { state } = await f.quiesce(), bundle = join(base, 'bundle'), result = await f.product.capture(state, bundle);
    expect(result.safety).toMatchObject({ active: 1, unsupported: 1, databases: expect.any(Array) });
    await expect(f.product.resume(state)).rejects.toThrow('unsupported work');
  });
  it('reaches stable quiescence when the real final WAL-mode owner closes during service stop', async () => {
    const f = await fixture(), owner = new DatabaseSync(join(f.profile, 'state/ardent.sqlite')); let closed = false;
    owner.exec("PRAGMA journal_mode=WAL; INSERT INTO tasks VALUES('wal-fixture','completed');");
    const product = new NativeSnapshots({ ...f.deps, serviceAction: async (target, unit, scope, action) => {
      if (scope === 'user' && action === 'stop' && !closed) { owner.close(); closed = true; }
      await f.deps.serviceAction!(target, unit, scope, action);
    } });
    try {
      const state = join(base, 'wal-session'); await product.quiesce(randomUUID(), state);
      expect(JSON.parse(await readFile(join(state, 'journal.json'), 'utf8')).phase).toBe('stopped');
      expect((await readdir(join(f.profile, 'state'))).sort()).toEqual(['ardent.sqlite']);
      await product.capture(state, join(base, 'bundle'));
      expect((await readdir(join(f.profile, 'state'))).sort()).toEqual(['ardent.sqlite']);
    } finally { if (!closed) owner.close(); }
  });
  it('accepts configured protected TLS files, captures their metadata binding and refuses drift or an unauthorized path', async () => {
    const f = await fixture(), tls = join(base, 'tls'); await mkdir(tls, { mode: 0o700 });
    const cert = join(tls, 'console.crt'), key = join(tls, 'console.key');
    await writeFile(cert, 'fixture-certificate', { mode: 0o644 }); await chmod(cert, 0o644);
    await writeFile(key, 'fixture-private-key', { mode: 0o600 });
    await writeFile(join(base, 'agent/.env'), 'TLS_CERT_PATH=' + cert + '\nTLS_KEY_PATH=' + key + '\n', { mode: 0o600 });
    vi.stubEnv('TLS_CERT_PATH', cert); vi.stubEnv('TLS_KEY_PATH', key);
    const { state } = await f.quiesce(); await f.product.capture(state, join(base, 'bundle'));
    await chmod(cert, 0o640); await expect(f.product.resume(state)).rejects.toThrow('inventory changed');
    await chmod(cert, 0o644); await chmod(key, 0o644);
    await expect(f.product.inspect()).rejects.toThrow('binding file is unsafe'); await chmod(key, 0o600);
    vi.stubEnv('TLS_CERT_PATH', key); await expect(f.product.inspect()).rejects.toThrow('not authorized');
  });
  it('recovers only an explicitly pinned held initial quiescence, retains its exact failure journal and never starts work', async () => {
    const f = await fixture(); let observations = 0;
    const product = new NativeSnapshots({ ...f.deps, service: async (target, unit, scope) => {
      if (scope === 'system' && ++observations === 2) await writeFile(join(f.profile, 'state/fixture-observation'), 'fixture', { mode: 0o600 });
      return f.deps.service!(target, unit, scope);
    } });
    const state = join(base, 'recoverable'), session = randomUUID();
    await expect(product.quiesce(session, state)).rejects.toThrow('inventory changed after shutdown');
    // Exercise compatibility with a failed journal written before history retention was introduced.
    const path = join(state, 'journal.json'), legacy = JSON.parse(await readFile(path, 'utf8')); delete legacy.history;
    await writeFile(path, JSON.stringify(legacy)); const previous = await readFile(path), previousSHA = sha256(previous);
    const expectedCurrent = (await product.inspect()).inventorySha256;
    await expect(product.recoverQuiesce(state, randomUUID(), expectedCurrent, previousSHA)).rejects.toThrow('exact recoverable');
    await expect(product.recoverQuiesce(state, session, '0'.repeat(64), previousSHA)).rejects.toThrow('explicit stable pin');
    await expect(product.recoverQuiesce(state, session, expectedCurrent, '0'.repeat(64))).rejects.toThrow('approval pin');
    const result = await runNativeSnapshot(['recover-quiesce', '--request-file', '-'], product, async () => JSON.stringify({ state, session, expectedCurrent, expectedJournalSHA256: previousSHA }));
    expect(result).toMatchObject({ recovered: true, session, stoppedInventorySha256: expectedCurrent, previousJournalSHA256: previousSHA, historySHA256: previousSHA });
    expect(await readFile(String(result.historyPath))).toEqual(previous);
    const recovered = JSON.parse(await readFile(path, 'utf8'));
    expect(recovered).toMatchObject({ phase: 'stopped', failure: null, history: [expect.objectContaining({ failure: 'Native inventory changed after shutdown', journalSHA256: previousSHA })] });
    expect(f.actions.some(action => action.startsWith('start:'))).toBe(false);
    await expect(product.recoverQuiesce(state, session, expectedCurrent)).rejects.toThrow('exact recoverable');
    await product.resume(state); expect(f.actions.slice(-2)).toEqual(['start:ardent@assistant.service', 'start:magnus-agent.service']);
  });
  it('refuses held-session recovery after immutable runtime drift or any capture/promotion phase', async () => {
    const f = await fixture(); let observations = 0;
    const product = new NativeSnapshots({ ...f.deps, service: async (target, unit, scope) => {
      if (scope === 'system' && ++observations === 2) await writeFile(join(f.profile, 'state/fixture-observation'), 'fixture', { mode: 0o600 });
      return f.deps.service!(target, unit, scope);
    } });
    const state = join(base, 'drifted'), session = randomUUID();
    await expect(product.quiesce(session, state)).rejects.toThrow('inventory changed after shutdown');
    await writeFile(join(f.install, 'runtime.js'), 'changed runtime');
    await expect(product.recoverQuiesce(state, session, (await product.inspect()).inventorySha256)).rejects.toThrow('runtime or generated');
    expect(JSON.parse(await readFile(join(state, 'journal.json'), 'utf8')).phase).toBe('held');
    expect(f.actions.some(action => action.startsWith('start:'))).toBe(false);
    const path = join(state, 'journal.json'), captured = JSON.parse(await readFile(path, 'utf8'));
    captured.stoppedInventorySha256 = (await product.inspect()).inventorySha256; captured.manifestSHA256 = '0'.repeat(64);
    await writeFile(path, JSON.stringify(captured));
    await expect(product.recoverQuiesce(state, session, captured.stoppedInventorySha256)).rejects.toThrow('exact recoverable');
  });
});
