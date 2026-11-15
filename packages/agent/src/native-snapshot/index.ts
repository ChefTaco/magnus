/** Product-owned stopped native snapshots. The caller holds the reversible Control API fence. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, chown, lstat, mkdir, open, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parse as parseEnvironment } from 'dotenv';
import { bindingRecord, tlsAncestry } from './bindings.js';
import { inspectSqlite } from './sqlite.js';
export { inspectSqlite } from './sqlite.js';
import { agentPrivileged, isRoot } from '../privileged.js';
import { ardentRoot, ardentUserUnit, packageTreeDigest, profileConfig, verifiedPackageReceipt, type ArdentRoot } from '../executors/ardent-manager.js';
import { assertArdentPluginsRetained, readArdentExtensionBundle } from '../executors/ardent-extensions.js';
import { canonical, digest, durableJson, durableMove, fileHash, packTree, plainPath, privateDirectory, readJson, scanTree, sha256, sqliteFile, statOptional, syncPath,
  treeSchema, unpackTree, validateTree, verifyPayload, within, type Tree } from './files.js';

const uuid = z.string().uuid();
const name = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const serviceSchema = z.object({ unit: z.string(), scope: z.enum(['system', 'user']), active: z.boolean(), enabled: z.string(),
  clean: z.boolean(), cgroupEmpty: z.boolean() }).strict();
type Service = z.infer<typeof serviceSchema>;
const profileSchema = z.object({ id: name, missing: z.boolean(), configSHA256: digest.nullable(), unitPresent: z.boolean(), service: serviceSchema }).strict();
const safetySchema = z.object({ active: z.number().int().nonnegative(), unknown: z.number().int().nonnegative(),
  unsupported: z.number().int().nonnegative(), databases: z.array(z.object({ path: z.string(), sha256: digest })).max(256) }).strict();
type Safety = z.infer<typeof safetySchema>;
const targetSchema = z.object({ owner: z.string(), uid: z.number().int().positive(), gid: z.number().int().nonnegative(),
  home: z.string(), root: z.string(), install: z.string(), agentInstall: z.string(), agentUnit: z.string(), machineSHA256: digest }).strict();
type Target = z.infer<typeof targetSchema>;
const inventorySchema = z.object({ schemaVersion: z.literal(1), target: targetSchema, targetSha256: digest,
  profiles: z.array(profileSchema).max(128), agent: serviceSchema, trees: z.array(treeSchema).length(3),
  runtimeReceiptSHA256: digest.nullable(), managerSHA256: digest, safety: safetySchema, inventorySha256: digest }).strict();
type Inventory = z.infer<typeof inventorySchema>;
const manifestSchema = z.object({ format: z.literal('magnus-native-snapshot/v1'), session: uuid,
  target: targetSchema, targetSha256: digest, inventorySha256: digest, trees: z.array(treeSchema).length(3),
  profiles: z.array(profileSchema).max(128), initialServices: z.array(serviceSchema).max(129), stoppedAgent: serviceSchema, safety: safetySchema,
  runtimeReceiptSHA256: digest.nullable(), managerSHA256: digest }).strict();
type Manifest = z.infer<typeof manifestSchema>;
const journalSchema = z.object({ schemaVersion: z.literal(1), session: uuid, target: targetSchema, targetSha256: digest,
  phase: z.enum(['quiescing', 'stopped', 'capturing', 'captured', 'restoring', 'restored', 'resuming', 'resumed', 'held']),
  original: inventorySchema, stoppedInventorySha256: digest.nullable(), activation: z.array(serviceSchema).max(129),
  manifestSHA256: digest.nullable(), restoredInventorySha256: digest.nullable(), safety: safetySchema,
  promotions: z.array(z.object({ target: z.string(), stage: z.string(), previous: z.string(), phase: z.enum(['prepared', 'moving', 'promoted']) }).strict()),
  failure: z.string().nullable(), history: z.array(z.object({ phase: z.string(), failure: z.string(), recordedAt: z.string().datetime(), journalSHA256: digest.optional() }).strict()).max(128).default([]) }).strict();
type Journal = z.infer<typeof journalSchema>;
const exec = promisify(execFile);
export interface SnapshotDependencies {
  privileged(): boolean;
  rootUid: number;
  root(): Promise<ArdentRoot>;
  account(owner: string): Promise<{ uid: number; gid: number; home: string }>;
  machine(): Promise<string>;
  service(target: Target, unit: string, scope: Service['scope']): Promise<Service>;
  serviceAction(target: Target, unit: string, scope: Service['scope'], action: 'stop' | 'start' | 'daemon-reload' | 'enable' | 'disable'): Promise<void>;
  packageReceipt(install: string): Promise<unknown>;
}
const unitName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}\.service$/);
async function systemctl(target: Target, scope: Service['scope'], args: string[]): Promise<string> {
  const command = scope === 'system' ? '/usr/bin/systemctl' : '/usr/sbin/runuser';
  const argv = scope === 'system' ? args : ['-u', target.owner, '--', '/usr/bin/systemctl', '--user', ...args];
  return (await exec(command, argv, { timeout: 100_000, maxBuffer: 256 * 1024,
    env: { PATH: '/usr/sbin:/usr/bin:/bin', LANG: 'C', HOME: target.home, USER: target.owner, LOGNAME: target.owner, XDG_RUNTIME_DIR: `/run/user/${target.uid}` } })).stdout;
}
async function cgroupEmpty(group: string): Promise<boolean> {
  if (!group) return true;
  if (!group.startsWith('/') || group.includes('..')) throw new Error('Invalid service cgroup');
  const path = '/sys/fs/cgroup' + group;
  if (!await statOptional(path)) return true;
  const walk = async (directory: string): Promise<boolean> => {
    await plainPath(directory);
    if ((await readFile(join(directory, 'cgroup.procs'), 'utf8')).trim()) return false;
    for (const child of await readdir(directory, { withFileTypes: true })) if (child.isDirectory() && !await walk(join(directory, child.name))) return false;
    return true;
  };
  return walk(path);
}
const defaults: SnapshotDependencies = {
  privileged: () => isRoot() && agentPrivileged(), rootUid: 0, root: ardentRoot,
  account: async owner => {
    const fields = (await readFile('/etc/passwd', 'utf8')).split('\n').map(line => line.split(':')).find(parts => parts[0] === owner);
    const uid = Number(fields?.[2]), gid = Number(fields?.[3]);
    if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid < 0 || !fields?.[5]) throw new Error('Configured native owner account is unavailable');
    return { uid, gid, home: fields[5] };
  },
  machine: () => readFile('/etc/machine-id', 'utf8'),
  packageReceipt: verifiedPackageReceipt,
  service: async (target, unit, scope) => {
    unitName.parse(unit);
    const text = await systemctl(target, scope, ['show', unit, '--no-pager', '--property=LoadState,ActiveState,SubState,UnitFileState,Result,ExecMainStatus,ExecMainCode,MainPID,ControlGroup,WorkingDirectory,FragmentPath,DropInPaths']);
    const fields = Object.fromEntries(text.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
    if (fields['LoadState'] === 'not-found' && scope === 'user') return { unit, scope, active: false, enabled: 'not-found', clean: true, cgroupEmpty: true };
    if (fields['LoadState'] !== 'loaded' || fields['DropInPaths'] || (scope === 'system' && fields['WorkingDirectory'] !== target.agentInstall)) throw new Error('Native service binding or drop-ins differ');
    if (scope === 'user' && fields['FragmentPath'] !== join(target.home, '.config/systemd/user', unit)) throw new Error('Native user service path differs');
    if (!['active', 'inactive', 'failed'].includes(fields['ActiveState'] ?? '')) throw new Error('Native service is changing state');
    return { unit, scope, active: fields['ActiveState'] === 'active', enabled: fields['UnitFileState'] ?? '',
      clean: fields['Result'] === 'success' && fields['ExecMainStatus'] === '0',
      cgroupEmpty: Number(fields['MainPID'] ?? '0') === 0 && await cgroupEmpty(fields['ControlGroup'] ?? '') };
  },
  serviceAction: async (target, unit, scope, action) => { await systemctl(target, scope, action === 'daemon-reload' ? [action] : [action, unit]); },
};
const zeroSafety = (): Safety => ({ active: 0, unknown: 0, unsupported: 0, databases: [] });
const inventoryHash = (inventory: Omit<Inventory, 'inventorySha256'>) => sha256(canonical(inventory));
const targetPath = (target: Target, label: Tree['label']) => label === 'root' ? target.root : label === 'runtime' ? target.install : join(target.home, '.config/systemd/user');
const executionLock = (path: string) => /^profiles\/[^/]+\/state\/(?:.*\/)?[^/]*(?:\.lock(?:\..*)?|\.tmp)$/.test(path);
const safetyClear = (safety: Safety) => safety.active === 0 && safety.unknown === 0 && safety.unsupported === 0;
async function profilePlugins(target: ArdentRoot, plugins: string[], receipt: unknown, root = target.root, install = target.install): Promise<void> {
  const pin = z.object({ extensionBundleSha256: digest.optional() }).safeParse(receipt);
  const info = await statOptional(install);
  const bundle = info && pin.success ? await readArdentExtensionBundle(install, info.uid, pin.data.extensionBundleSha256, packageTreeDigest) : null;
  const packages: string[] = [];
  for (const specifier of plugins) {
    if (!isAbsolute(specifier) && !specifier.startsWith('file://')) { packages.push(specifier); continue; }
    const original = specifier.startsWith('file://') ? fileURLToPath(specifier) : specifier;
    let stored: string;
    if (within(target.root, original)) stored = join(root, original.slice(target.root.length));
    else if (within(target.install, original)) stored = join(install, original.slice(target.install.length));
    else throw new Error('A profile plugin is outside the declared native snapshot roots');
    await plainPath(stored);
    if (!(await lstat(stored)).isFile()) throw new Error('A profile plugin is not a captured ordinary module');
  }
  assertArdentPluginsRetained(packages, bundle);
}

export class NativeSnapshots {
  private readonly deps: SnapshotDependencies;
  constructor(deps: Partial<SnapshotDependencies> = {}) { this.deps = { ...defaults, ...deps }; }
  private guard() { if (!this.deps.privileged()) throw new Error('Native snapshots require root and privileged agent mode'); }
  private async target(agentUnit = 'magnus-agent.service'): Promise<Target> {
    this.guard(); unitName.parse(agentUnit);
    const root = await this.deps.root(), account = await this.deps.account(root.owner);
    const agentInstall = resolve(process.env['AGENT_INSTALL_DIR'] ?? process.cwd());
    if (root.home !== account.home || root.root === root.home || root.install === root.home || !within(root.home, root.root) || !within(root.home, root.install)
      || within(root.root, root.install) || within(root.install, root.root) || within(root.home, agentInstall) || within(agentInstall, root.home)) throw new Error('Native snapshot roots overlap or differ from the configured owner');
    for (const path of [root.home, root.root, root.install, agentInstall]) await plainPath(path, path !== root.home && path !== agentInstall);
    const homeInfo = await lstat(root.home);
    if (homeInfo.uid !== account.uid || (homeInfo.mode & 0o022) !== 0) throw new Error('Native owner home is unsafe');
    const agentInfo = await lstat(agentInstall);
    if (!agentInfo.isDirectory() || agentInfo.uid !== this.deps.rootUid || agentInfo.mode & 0o022) throw new Error('Native manager install is not root-controlled');
    if (await statOptional(join(root.install, 'context-adoption.json'))) throw new Error('Context adoption checkpoints need their owning recovery before a general native snapshot');
    return targetSchema.parse({ ...root, ...account, agentInstall, agentUnit, machineSHA256: sha256((await this.deps.machine()).trim()) });
  }
  private async profiles(target: Target): Promise<z.infer<typeof profileSchema>[]> {
    const directory = join(target.root, 'profiles'), names = new Set<string>();
    if (await statOptional(directory)) {
      await plainPath(directory);
      for (const child of await readdir(directory, { withFileTypes: true })) {
        name.parse(child.name); if (!child.isDirectory()) throw new Error('Undeclared or unsafe native profile entry'); names.add(child.name);
      }
    }
    const units = join(target.home, '.config/systemd/user');
    if (await statOptional(units)) {
      await plainPath(units);
      for (const child of await readdir(units)) if (child.startsWith('ardent@') && child.endsWith('.service')) names.add(name.parse(child.slice(7, -8)));
    }
    if (names.size > 128) throw new Error('Native profile inventory exceeds bounds');
    const receipt = await this.deps.packageReceipt(target.install);
    const packageName = z.object({ name: z.string() }).safeParse(receipt);
    const result = [];
    for (const id of [...names].sort()) {
      const path = join(target.root, 'profiles', id, 'config.yaml'), info = await statOptional(path);
      let configSHA256: string | null = null;
      if (info) {
        if (!info.isFile() || info.isSymbolicLink() || info.size > 200_000) throw new Error('Native profile configuration is unsafe');
        const { config } = await profileConfig(target.root, id);
        await profilePlugins(target, config.plugins, receipt);
        configSHA256 = await fileHash(path);
      }
      const unit = `ardent@${id}.service`, unitPath = join(units, unit), unitInfo = await statOptional(unitPath);
      if (unitInfo) {
        if (!unitInfo.isFile() || unitInfo.isSymbolicLink() || unitInfo.uid !== target.uid || unitInfo.gid !== target.gid || unitInfo.mode & 0o022)
          throw new Error('Native user unit ownership or shape differs');
        // A missing runtime may be repaired by restore, but custom units are never managed implicitly.
        const expected = ardentUserUnit(target, id, packageName.success ? packageName.data.name : undefined);
        if (await readFile(unitPath, 'utf8') !== expected) throw new Error('Native service differs from the exact generated user unit');
      }
      result.push({ id, missing: !info, configSHA256, unitPresent: unitInfo !== null, service: await this.deps.service(target, unit, 'user') });
    }
    return result;
  }
  private async unitTree(target: Target, profiles: Inventory['profiles']): Promise<Tree> {
    const tree: Tree = { label: 'units', entries: [{ path: '', kind: 'directory', mode: 0o700, uid: target.uid, gid: target.gid, size: 0 }] };
    for (const profile of profiles) if (profile.unitPresent) {
      const path = join(target.home, '.config/systemd/user', profile.service.unit), info = await lstat(path);
      tree.entries.push({ path: profile.service.unit, kind: 'file', uid: info.uid, gid: info.gid, mode: info.mode & 0o777, size: info.size, sha256: await fileHash(path) });
    }
    return tree;
  }
  private async managerHash(target: Target): Promise<string> {
    const entries: Array<ReturnType<typeof bindingRecord> | { label: string; path: string; missing: true }> = [];
    const configuration = join(target.agentInstall, '.env');
    await plainPath(configuration, true);
    const configurationInfo = await statOptional(configuration);
    if (configurationInfo && (!configurationInfo.isFile() || configurationInfo.isSymbolicLink() || configurationInfo.nlink !== 1
      || configurationInfo.size > 1024 * 1024 || configurationInfo.uid !== this.deps.rootUid || configurationInfo.mode & 0o022)) throw new Error('Native manager binding file is unsafe');
    const configured = configurationInfo ? parseEnvironment(await readFile(configuration)) : {};
    const paths: Array<[string, string]> = [['configuration', join(target.agentInstall, '.env')]];
    const identity = join(target.agentInstall, 'identity');
    if (await statOptional(identity)) {
      await plainPath(identity);
      const names = (await readdir(identity)).sort();
      if (names.length > 256) throw new Error('Native manager identity inventory exceeds bounds');
      for (const entry of names) paths.push(['identity/' + entry, join(identity, entry)]);
    }
    for (const key of ['TLS_CERT_PATH', 'TLS_KEY_PATH', 'CONTROL_API_CA_PATH', 'MAGNUS_AGENT_RENEWAL_CONFIG']) {
      const value = process.env[key]; if (value) paths.push([key, resolve(target.agentInstall, value)]);
    }
    for (const [label, path] of paths) {
      await plainPath(path, true); const info = await statOptional(path);
      const tls = ['TLS_CERT_PATH', 'TLS_KEY_PATH', 'CONTROL_API_CA_PATH'].includes(label);
      if (tls) {
        const allowed = configured[label];
        if (!allowed || resolve(target.agentInstall, allowed) !== path) throw new Error('TLS binding path is not authorized by the root manager configuration');
        if (!info) throw new Error('Configured TLS binding file is missing');
        await tlsAncestry(path, info.uid, this.deps.rootUid);
      }
      entries.push(info ? bindingRecord(label, path, { uid: info.uid, gid: info.gid, mode: info.mode, nlink: info.nlink, regular: info.isFile() && !info.isSymbolicLink() }, await fileHash(path), this.deps.rootUid)
        : { label, path, missing: true });
    }
    return sha256(canonical(entries));
  }
  private async safety(target: Target, tree: Tree): Promise<Safety> {
    const result = zeroSafety();
    for (const entry of tree.entries) {
      if (executionLock(entry.path)) throw new Error('Native execution owner remains; inspect it without clearing or replaying work');
      if (entry.kind !== 'file' || !await sqliteFile(join(target.root, entry.path))) continue;
      const path = join(target.root, entry.path), value = await inspectSqlite(path);
      result.active += value.active; result.unknown += value.unknown; result.unsupported += value.unsupported;
      result.databases.push({ path: entry.path, sha256: entry.sha256! });
    }
    return result;
  }
  async inspect(agentUnit?: string): Promise<Inventory> {
    const target = await this.target(agentUnit), profiles = await this.profiles(target);
    const trees = [await scanTree(target.root, 'root', target.uid, target.gid), await scanTree(target.install, 'runtime', target.uid, target.gid), await this.unitTree(target, profiles)];
    const receipt = await this.deps.packageReceipt(target.install);
    // Running profiles legitimately retain their gateway lock. Frozen checks below must reject it.
    const safetyTree = { ...trees[0]!, entries: trees[0]!.entries.filter(e => !executionLock(e.path)) };
    const safety = await this.safety(target, safetyTree);
    // Extension integrity proves bytes, not the safety of arbitrary startup consumers.
    // No external plugin currently declares a product-owned stopped-snapshot capability.
    for (const profile of profiles.filter(p => !p.missing)) if ((await profileConfig(target.root, profile.id)).config.plugins.length) safety.unsupported++;
    const value = { schemaVersion: 1 as const, target, targetSha256: sha256(canonical(target)), profiles,
      agent: await this.deps.service(target, target.agentUnit, 'system'), trees,
      runtimeReceiptSHA256: receipt ? sha256(canonical(receipt)) : null, managerSHA256: await this.managerHash(target), safety };
    return { ...value, inventorySha256: inventoryHash(value) };
  }
  private stopped(inventory: Inventory) {
    for (const service of [inventory.agent, ...inventory.profiles.map(p => p.service)])
      if (service.active || !service.clean || !service.cgroupEmpty) throw new Error('Native service shutdown is not proven clean and empty');
    for (const tree of inventory.trees) if (tree.label === 'root') for (const entry of tree.entries)
      if (executionLock(entry.path)) throw new Error('Native execution lock remains; retain it for exact recovery');
  }
  private async journal(state: string): Promise<Journal> {
    this.guard(); await privateDirectory(state, this.deps.rootUid);
    const journal = journalSchema.parse(await readJson(join(state, 'journal.json')));
    if (sha256(canonical(await this.target(journal.target.agentUnit))) !== journal.targetSha256) throw new Error('Snapshot session belongs to another native target');
    const reservation = join(journal.target.agentInstall, '.native-snapshot-reservation.json');
    const info = await lstat(reservation);
    if (info.uid !== this.deps.rootUid) throw new Error('Native snapshot reservation ownership differs');
    const owner = z.object({ session: uuid, state: z.string(), targetSha256: digest }).strict().parse(await readJson(reservation));
    if (owner.session !== journal.session || owner.state !== state || owner.targetSha256 !== journal.targetSha256) throw new Error('Native snapshot reservation belongs to another owner');
    return journal;
  }
  private save(state: string, journal: Journal) { return durableJson(join(state, 'journal.json'), journal); }
  private storage(target: Target, path: string) {
    if (!isAbsolute(path) || resolve(path) !== path || [target.home, target.agentInstall].some(root => within(root, path) || within(path, root)))
      throw new Error('Mutable snapshot storage must be outside the managed owner home and manager install');
  }
  private async ownerParents(target: Target, path: string): Promise<void> {
    if (!within(target.home, path)) throw new Error('Native restore parent leaves the configured owner home');
    const parts = path.slice(target.home.length).split('/').filter(Boolean); let current = target.home;
    for (const part of parts) {
      current = join(current, part);
      if (!await statOptional(current)) { await mkdir(current, { mode: 0o700 }); await chown(current, target.uid, target.gid); await syncPath(dirname(current)); }
      await plainPath(current); const info = await lstat(current);
      if (!info.isDirectory() || info.uid !== target.uid || info.gid !== target.gid || info.mode & 0o022) throw new Error('Native restore parent ownership or mode differs');
    }
  }
  private async hold(state: string, journal: Journal, error: unknown): Promise<never> {
    const failure = error instanceof Error ? error.message : 'Native snapshot operation failed';
    if (journal.history.length < 128) journal.history.push({ phase: journal.phase, failure, recordedAt: new Date().toISOString() });
    journal.phase = 'held'; journal.failure = failure;
    await this.save(state, journal); throw error;
  }
  async quiesce(session: string, state: string, agentUnit?: string, expectedInventorySha256?: string): Promise<Record<string, unknown>> {
    this.guard(); uuid.parse(session);
    const original = await this.inspect(agentUnit);
    this.storage(original.target, state);
    if (expectedInventorySha256 !== undefined && original.inventorySha256 !== digest.parse(expectedInventorySha256)) throw new Error('Native inventory changed before quiescence');
    await privateDirectory(state, this.deps.rootUid, true);
    const journal: Journal = { schemaVersion: 1, session, target: original.target, targetSha256: original.targetSha256, phase: 'quiescing', original,
      stoppedInventorySha256: null, activation: [original.agent, ...original.profiles.map(p => p.service)], manifestSHA256: null,
      restoredInventorySha256: null, safety: original.safety, promotions: [], failure: null, history: [] };
    await this.save(state, journal);
    // A durable per-install reservation survives either daemon/CLI restart. The caller's API fence is additional.
    const reservation = join(original.target.agentInstall, '.native-snapshot-reservation.json');
    const lock = await open(reservation, 'wx', 0o600);
    try { await lock.writeFile(JSON.stringify({ session, state, targetSha256: original.targetSha256 })); await lock.sync(); } finally { await lock.close(); }
    await syncPath(dirname(reservation));
    try {
      await this.deps.serviceAction(original.target, original.agent.unit, 'system', 'stop');
      for (const profile of original.profiles) if (profile.service.active) await this.deps.serviceAction(original.target, profile.service.unit, 'user', 'stop');
      const first = await this.inspect(agentUnit); this.stopped(first);
      const second = await this.inspect(agentUnit); this.stopped(second);
      if (first.inventorySha256 !== second.inventorySha256) throw new Error('Native inventory changed after shutdown');
      if (canonical(first.profiles.map(p => [p.id, p.configSHA256, p.unitPresent])) !== canonical(original.profiles.map(p => [p.id, p.configSHA256, p.unitPresent])))
        throw new Error('Native profile membership or configuration changed during shutdown');
      for (let i = 0; i < journal.activation.length; i++) if (journal.activation[i]!.enabled !== [second.agent, ...second.profiles.map(p => p.service)][i]?.enabled)
        throw new Error('Native unit enablement changed during shutdown');
      journal.phase = 'stopped'; journal.stoppedInventorySha256 = second.inventorySha256; journal.safety = second.safety; await this.save(state, journal);
      return { schemaVersion: 1, state, session, targetSha256: second.targetSha256, stoppedInventorySha256: second.inventorySha256, safety: second.safety };
    } catch (error) { return this.hold(state, journal, error); }
  }
  /** Explicit recovery of the exact initial quiescence refusal. Never resumes a capture or promotion. */
  async recoverQuiesce(state: string, session: string, expectedCurrent: string, expectedJournalSHA256?: string): Promise<Record<string, unknown>> {
    this.guard(); uuid.parse(session); digest.parse(expectedCurrent); await privateDirectory(state, this.deps.rootUid);
    const journalPath = join(state, 'journal.json');
    const previousJournalSHA256 = await fileHash(journalPath);
    if (expectedJournalSHA256 !== undefined && previousJournalSHA256 !== digest.parse(expectedJournalSHA256)) throw new Error('Native recovery journal differs from its explicit approval pin');
    const journal = await this.journal(state);
    if (journal.session !== session || journal.phase !== 'held' || journal.failure !== 'Native inventory changed after shutdown'
      || journal.stoppedInventorySha256 !== null || journal.manifestSHA256 !== null || journal.restoredInventorySha256 !== null || journal.promotions.length)
      throw new Error('This is not the exact recoverable initial quiescence refusal; retain its journal');
    const first = await this.inspect(journal.target.agentUnit); this.stopped(first);
    const second = await this.inspect(journal.target.agentUnit); this.stopped(second);
    if (first.inventorySha256 !== expectedCurrent || second.inventorySha256 !== expectedCurrent) throw new Error('Native recovery inventory differs from the explicit stable pin');
    const membership = (inventory: Inventory) => inventory.profiles.map(p => [p.id, p.missing, p.configSHA256, p.unitPresent]);
    const immutableRoot = (inventory: Inventory) => inventory.trees.find(t => t.label === 'root')!.entries
      .filter(entry => !/^profiles\/[^/]+\/(?:state|logs)\//.test(entry.path));
    const counts = (safety: Safety) => [safety.active, safety.unknown, safety.unsupported];
    if (journal.original.managerSHA256 !== second.managerSHA256 || canonical(membership(journal.original)) !== canonical(membership(second))
      || canonical(immutableRoot(journal.original)) !== canonical(immutableRoot(second))
      || canonical(counts(journal.original.safety)) !== canonical(counts(second.safety))) throw new Error('Native recovery membership, retained work or protected profile state changed');
    for (const label of ['runtime', 'units']) if (canonical(journal.original.trees.find(t => t.label === label)) !== canonical(second.trees.find(t => t.label === label)))
      throw new Error('Native recovery runtime or generated service state changed');
    for (const original of journal.activation) {
      const current = [second.agent, ...second.profiles.map(p => p.service)].find(s => s.scope === original.scope && s.unit === original.unit);
      if (!current || current.enabled !== original.enabled) throw new Error('Native recovery service enablement changed');
    }
    if (await fileHash(journalPath) !== previousJournalSHA256) throw new Error('Native recovery journal changed during observation');
    const previousBytes = await readFile(journalPath);
    if (sha256(previousBytes) !== previousJournalSHA256) throw new Error('Native recovery journal changed before retention');
    const historyDirectory = join(state, 'history');
    if (await statOptional(historyDirectory)) await privateDirectory(historyDirectory, this.deps.rootUid);
    else await privateDirectory(historyDirectory, this.deps.rootUid, true);
    const historyPath = join(historyDirectory, `journal-${previousJournalSHA256}.json`);
    const retained = await statOptional(historyPath);
    if (retained) {
      await plainPath(historyPath);
      if (retained.uid !== this.deps.rootUid || retained.mode & 0o077 || await fileHash(historyPath) !== previousJournalSHA256) throw new Error('Retained native failure journal differs');
    } else {
      const file = await open(historyPath, 'wx', 0o600);
      try { await file.writeFile(previousBytes); await file.sync(); } finally { await file.close(); }
      await syncPath(historyDirectory);
    }
    // Older refused journals have only `failure`. Retain it before moving to stopped; never rewrite the original inventory.
    if (!journal.history.some(entry => entry.failure === journal.failure)) {
      if (journal.history.length >= 128) throw new Error('Native failure history is full; retain the held session');
      journal.history.push({ phase: 'held', failure: journal.failure, recordedAt: new Date().toISOString() });
    }
    journal.history.find(entry => entry.failure === journal.failure)!.journalSHA256 = previousJournalSHA256;
    journal.phase = 'stopped'; journal.failure = null; journal.safety = second.safety; journal.stoppedInventorySha256 = second.inventorySha256;
    await this.save(state, journal);
    return { schemaVersion: 1, recovered: true, state, session, targetSha256: second.targetSha256,
      stoppedInventorySha256: second.inventorySha256, safety: second.safety, previousJournalSHA256,
      journalSHA256: await fileHash(journalPath), historyPath, historySHA256: await fileHash(historyPath) };
  }
  async capture(state: string, destination: string): Promise<Record<string, unknown>> {
    const journal = await this.journal(state);
    if (!['stopped', 'captured'].includes(journal.phase)) throw new Error('Snapshot session is not stopped');
    const inventory = await this.inspect(journal.target.agentUnit); this.stopped(inventory);
    if (inventory.inventorySha256 !== journal.stoppedInventorySha256) throw new Error('Stopped native inventory differs from its journal');
    if (inventory.profiles.some(p => p.missing) || (inventory.trees.find(t => t.label === 'runtime')!.entries.length > 0 && !inventory.runtimeReceiptSHA256)) throw new Error('Native profile or verified runtime is missing');
    this.storage(journal.target, destination);
    if (within(state, destination) || within(destination, state)) throw new Error('Native snapshot bundle and session storage must be separate');
    await privateDirectory(destination, this.deps.rootUid, true); journal.phase = 'capturing'; await this.save(state, journal);
    try {
      await mkdir(join(destination, 'files'), { mode: 0o700 });
      for (const tree of inventory.trees) await packTree(targetPath(inventory.target, tree.label), join(destination, 'files', tree.label), tree);
      const manifest: Manifest = { format: 'magnus-native-snapshot/v1', session: journal.session, target: inventory.target,
        targetSha256: inventory.targetSha256, inventorySha256: inventory.inventorySha256, trees: inventory.trees,
        profiles: inventory.profiles, initialServices: journal.activation, stoppedAgent: inventory.agent, safety: inventory.safety, runtimeReceiptSHA256: inventory.runtimeReceiptSHA256, managerSHA256: inventory.managerSHA256 };
      await durableJson(join(destination, 'manifest.json'), manifest);
      const verified = await this.verify(destination);
      const after = await this.inspect(journal.target.agentUnit); this.stopped(after);
      if (after.inventorySha256 !== inventory.inventorySha256) throw new Error('Native inventory changed during capture');
      journal.phase = 'captured'; journal.manifestSHA256 = verified.manifestSHA256; await this.save(state, journal);
      return { ...verified, destination, session: journal.session, stoppedInventorySha256: inventory.inventorySha256 };
    } catch (error) { return this.hold(state, journal, error); }
  }
  private async bundle(source: string): Promise<{ manifest: Manifest; manifestSHA256: string }> {
    this.guard(); await plainPath(source);
    const manifestPath = join(source, 'manifest.json'), manifestSHA256 = await fileHash(manifestPath), manifest = manifestSchema.parse(await readJson(manifestPath));
    if (sha256(canonical(manifest.target)) !== manifest.targetSha256 || sha256(canonical(await this.target(manifest.target.agentUnit))) !== manifest.targetSha256)
      throw new Error('Native snapshot is bound to another host, account or configured path');
    if (canonical([...manifest.trees.map(t => t.label)].sort()) !== canonical(['root', 'runtime', 'units'])) throw new Error('Native snapshot tree inventory differs');
    for (const tree of manifest.trees) validateTree(tree, manifest.target.uid, manifest.target.gid);
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isDirectory() || sourceInfo.mode & 0o077) throw new Error('Native snapshot source is not private');
    if (canonical((await readdir(source)).sort()) !== canonical(['files', 'manifest.json'])) throw new Error('Undeclared native snapshot source entry');
    await plainPath(join(source, 'files'));
    const declared = manifest.trees.filter(t => t.entries.length).map(t => t.label).sort();
    if (canonical((await readdir(join(source, 'files'))).sort()) !== canonical(declared)) throw new Error('Undeclared native snapshot payload tree');
    for (const tree of manifest.trees) await verifyPayload(source, tree);
    if (await fileHash(manifestPath) !== manifestSHA256) throw new Error('Native manifest changed during verification');
    return { manifest, manifestSHA256 };
  }
  async verify(source: string): Promise<{ schemaVersion: 1; manifestSHA256: string; targetSha256: string; inventorySha256: string; safety: Safety; profiles: string[] }> {
    const { manifest, manifestSHA256 } = await this.bundle(source);
    const frozen = { schemaVersion: 1 as const, target: manifest.target, targetSha256: manifest.targetSha256, profiles: manifest.profiles,
      agent: manifest.stoppedAgent, trees: manifest.trees, runtimeReceiptSHA256: manifest.runtimeReceiptSHA256,
      managerSHA256: manifest.managerSHA256, safety: manifest.safety };
    if (inventoryHash(frozen) !== manifest.inventorySha256) throw new Error('Native manifest inventory digest differs');
    this.stopped({ ...frozen, inventorySha256: manifest.inventorySha256 });
    const services = [manifest.stoppedAgent, ...manifest.profiles.map(p => p.service)];
    if (manifest.stoppedAgent.unit !== manifest.target.agentUnit || manifest.stoppedAgent.scope !== 'system'
      || canonical(manifest.initialServices.map(s => [s.scope, s.unit]).sort()) !== canonical(services.map(s => [s.scope, s.unit]).sort())
      || manifest.initialServices.some(s => !['enabled', 'disabled', 'not-found'].includes(s.enabled))) throw new Error('Native manifest original service inventory differs');
    const rootTree = manifest.trees.find(t => t.label === 'root')!;
    const profiles = rootTree.entries.filter(e => /^profiles\/[^/]+$/.test(e.path));
    if (profiles.some(p => p.kind !== 'directory') || canonical(profiles.map(p => p.path.slice(9)).sort()) !== canonical(manifest.profiles.map(p => p.id).sort()) || manifest.profiles.some(p => p.missing))
      throw new Error('Native snapshot profile inventory is incomplete or undeclared');
    const units = manifest.trees.find(t => t.label === 'units')!;
    if (canonical(units.entries.filter(e => e.path !== '').map(e => e.path).sort()) !== canonical(manifest.profiles.filter(p => p.unitPresent).map(p => p.service.unit).sort())) throw new Error('Native snapshot user unit inventory differs');
    const receipt = await this.deps.packageReceipt(join(source, 'files/runtime'));
    if ((receipt ? sha256(canonical(receipt)) : null) !== manifest.runtimeReceiptSHA256 || (manifest.trees.find(t => t.label === 'runtime')!.entries.length > 0 && !receipt)) throw new Error('Native snapshot runtime receipt differs');
    const runtimeName = z.object({ name: z.string() }).safeParse(receipt);
    let unsupportedPlugins = 0;
    for (const profile of manifest.profiles) {
      if (profile.service.scope !== 'user' || profile.service.unit !== `ardent@${profile.id}.service`) throw new Error('Native snapshot profile service identity differs');
      const { config } = await profileConfig(join(source, 'files/root'), profile.id);
      await profilePlugins(manifest.target, config.plugins, receipt, join(source, 'files/root'), join(source, 'files/runtime'));
      if (config.plugins.length) unsupportedPlugins++;
      if (await fileHash(join(source, 'files/root/profiles', profile.id, 'config.yaml')) !== profile.configSHA256) throw new Error('Native snapshot profile configuration differs');
      if (profile.unitPresent && await readFile(join(source, 'files/units', profile.service.unit), 'utf8') !== ardentUserUnit(manifest.target, profile.id, runtimeName.success ? runtimeName.data.name : undefined)) throw new Error('Native snapshot generated unit differs');
    }
    const safety = zeroSafety(); safety.unsupported = unsupportedPlugins;
    for (const entry of rootTree.entries) {
      if (executionLock(entry.path)) throw new Error('Snapshot contains an unresolved native execution lock');
      if (entry.kind === 'file' && await sqliteFile(join(source, 'files/root', entry.path))) {
        const counts = await inspectSqlite(join(source, 'files/root', entry.path));
        safety.active += counts.active; safety.unknown += counts.unknown; safety.unsupported += counts.unsupported;
        safety.databases.push({ path: entry.path, sha256: entry.sha256! });
      }
    }
    if (canonical(safety) !== canonical(manifest.safety)) throw new Error('Native snapshot work inventory differs');
    // Read-only SQLite checks must not leave payload companions or any changed source bytes.
    for (const tree of manifest.trees) await verifyPayload(source, tree);
    return { schemaVersion: 1, manifestSHA256, targetSha256: manifest.targetSha256, inventorySha256: manifest.inventorySha256, safety, profiles: manifest.profiles.map(p => p.id) };
  }
  async restore(state: string, source: string, expectedCurrent: string): Promise<Record<string, unknown>> {
    digest.parse(expectedCurrent); const journal = await this.journal(state);
    if (!['stopped', 'captured'].includes(journal.phase)) throw new Error('Restore requires a stopped snapshot session');
    const current = await this.inspect(journal.target.agentUnit); this.stopped(current);
    if (current.inventorySha256 !== expectedCurrent || journal.stoppedInventorySha256 !== expectedCurrent) throw new Error('Current native inventory differs from the explicit restore pin');
    const verified = await this.verify(source), { manifest } = await this.bundle(source);
    if (manifest.targetSha256 !== journal.targetSha256) throw new Error('Restore target differs from the stopped session');
    if (manifest.managerSHA256 !== current.managerSHA256) throw new Error('Restore requires the same retained manager identity, evidence keys, TLS and configuration binding');
    journal.phase = 'restoring'; journal.manifestSHA256 = verified.manifestSHA256; journal.activation = manifest.initialServices; journal.safety = manifest.safety; await this.save(state, journal);
    try {
      for (const tree of manifest.trees) {
        if (tree.label === 'units') continue;
        const target = targetPath(manifest.target, tree.label), stage = target + '.native-snapshot-' + journal.session + '-stage', previous = target + '.native-snapshot-' + journal.session + '-previous';
        await this.ownerParents(manifest.target, dirname(target));
        if (await statOptional(stage) || await statOptional(previous)) throw new Error('Native restore stage or recovery checkpoint already exists');
        await unpackTree(source, stage, tree);
        const staged = await scanTree(stage, tree.label, manifest.target.uid, manifest.target.gid);
        if (canonical(staged) !== canonical(tree)) throw new Error('Staged native restore tree differs');
        journal.promotions.push({ target, stage, previous, phase: 'prepared' }); await this.save(state, journal);
      }
      const unitDirectory = targetPath(manifest.target, 'units');
      await this.ownerParents(manifest.target, unitDirectory);
      for (const entry of manifest.trees.find(t => t.label === 'units')!.entries.filter(e => e.path !== '')) {
        const target = join(unitDirectory, entry.path), stage = target + '.native-snapshot-' + journal.session + '-stage', previous = target + '.native-snapshot-' + journal.session + '-previous';
        if (await statOptional(stage) || await statOptional(previous)) throw new Error('Native unit restore stage or recovery checkpoint already exists');
        const bytes = await readFile(join(source, 'files/units', entry.path));
        const handle = await open(stage, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await chown(stage, entry.uid, entry.gid); await chmod(stage, entry.mode);
        if (await fileHash(stage) !== entry.sha256) throw new Error('Staged unit differs');
        journal.promotions.push({ target, stage, previous, phase: 'prepared' }); await this.save(state, journal);
      }
      const sourceUnits = new Set(manifest.profiles.filter(p => p.unitPresent).map(p => p.service.unit));
      for (const profile of current.profiles.filter(p => p.unitPresent && !sourceUnits.has(p.service.unit))) {
        const target = join(unitDirectory, profile.service.unit), stage = target + '.native-snapshot-' + journal.session + '-absent', previous = target + '.native-snapshot-' + journal.session + '-previous';
        if (await statOptional(previous) || await statOptional(stage)) throw new Error('Native unit recovery checkpoint already exists');
        journal.promotions.push({ target, stage, previous, phase: 'prepared' }); await this.save(state, journal);
      }
      // Validate the complete runtime/profile pair before the first promotion; no installed code runs.
      const runtimeStage = journal.promotions.find(p => p.target === manifest.target.install)!.stage;
      const receipt = await this.deps.packageReceipt(runtimeStage);
      if ((receipt ? sha256(canonical(receipt)) : null) !== manifest.runtimeReceiptSHA256) throw new Error('Staged runtime receipt cannot be verified');
      const packageName = z.object({ name: z.string() }).safeParse(receipt);
      for (const profile of manifest.profiles) if (profile.unitPresent) {
        const unit = journal.promotions.find(p => p.target === join(unitDirectory, profile.service.unit))!;
        if (await readFile(unit.stage, 'utf8') !== ardentUserUnit(manifest.target, profile.id, packageName.success ? packageName.data.name : undefined)) throw new Error('Staged native unit differs from generated service');
      }
      const stable = await this.inspect(journal.target.agentUnit); this.stopped(stable);
      // Stage siblings do not belong to any captured tree; their presence cannot change this pin.
      if (stable.inventorySha256 !== expectedCurrent) throw new Error('Native target changed before restore promotion');
      const originalAgent = manifest.initialServices.find(s => s.scope === 'system')!;
      if (originalAgent.enabled !== current.agent.enabled) throw new Error('Manager service enablement differs from the source; restore its owning installation first');
      // Remove only explicit, generated units absent from the source; every previous file is retained.
      for (const profile of current.profiles.filter(p => p.unitPresent && !sourceUnits.has(p.service.unit)))
        if (profile.service.enabled === 'enabled') await this.deps.serviceAction(manifest.target, profile.service.unit, 'user', 'disable');
      for (const promotion of journal.promotions) {
        promotion.phase = 'moving'; await this.save(state, journal);
        if (await statOptional(promotion.target)) await durableMove(promotion.target, promotion.previous);
        if (await statOptional(promotion.stage)) await durableMove(promotion.stage, promotion.target);
        promotion.phase = 'promoted'; await this.save(state, journal);
      }
      await this.deps.serviceAction(manifest.target, '', 'user', 'daemon-reload');
      for (const original of manifest.initialServices.filter(s => s.scope === 'user' && sourceUnits.has(s.unit))) {
        const actual = await this.deps.service(manifest.target, original.unit, 'user');
        if (actual.enabled !== original.enabled) {
          if (!['enabled', 'disabled'].includes(original.enabled)) throw new Error('Source user service enablement cannot be restored safely');
          await this.deps.serviceAction(manifest.target, original.unit, 'user', original.enabled === 'enabled' ? 'enable' : 'disable');
        }
      }
      const restored = await this.inspect(journal.target.agentUnit); this.stopped(restored);
      for (const tree of manifest.trees) if (canonical(restored.trees.find(t => t.label === tree.label)) !== canonical(tree)) throw new Error('Promoted native tree differs from the verified source');
      journal.phase = 'restored'; journal.restoredInventorySha256 = restored.inventorySha256; await this.save(state, journal);
      return { schemaVersion: 1, state, restored: true, manifestSHA256: verified.manifestSHA256, inventorySha256: restored.inventorySha256,
        activationAllowed: safetyClear(manifest.safety), safety: manifest.safety, previous: journal.promotions.map(p => p.previous) };
    } catch (error) { return this.hold(state, journal, error); }
  }
  async resume(state: string): Promise<Record<string, unknown>> {
    const journal = await this.journal(state);
    if (!['stopped', 'captured', 'restored'].includes(journal.phase)) throw new Error('Snapshot session is held or incomplete; do not replay it');
    const inventory = await this.inspect(journal.target.agentUnit); this.stopped(inventory);
    if (inventory.inventorySha256 !== (journal.restoredInventorySha256 ?? journal.stoppedInventorySha256)) throw new Error('Native inventory changed before resume');
    if (!safetyClear(journal.safety) || !safetyClear(inventory.safety)) throw new Error('Native profile has pending, uncertain or unsupported work; leave it stopped and reconcile exact evidence');
    for (const original of journal.activation) {
      const observed = [inventory.agent, ...inventory.profiles.map(p => p.service)].find(s => s.unit === original.unit && s.scope === original.scope);
      if (!observed || observed.enabled !== original.enabled) throw new Error('Native enablement differs; do not change it implicitly');
    }
    journal.phase = 'resuming'; await this.save(state, journal);
    try {
      for (const service of journal.activation.filter(s => s.scope === 'user' && s.active)) await this.deps.serviceAction(journal.target, service.unit, service.scope, 'start');
      const reservation = join(journal.target.agentInstall, '.native-snapshot-reservation.json');
      // The durable journal is already resuming; only this exact owner removes the startup reservation.
      await rm(reservation);
      if (journal.activation.find(s => s.scope === 'system')?.active) await this.deps.serviceAction(journal.target, journal.target.agentUnit, 'system', 'start');
      for (const original of journal.activation) {
        const actual = await this.deps.service(journal.target, original.unit, original.scope);
        if (actual.active !== original.active || actual.enabled !== original.enabled) throw new Error('Native service did not return to its recorded state');
      }
      journal.phase = 'resumed'; await this.save(state, journal);
      return { schemaVersion: 1, state, resumed: true, profiles: journal.activation.filter(s => s.scope === 'user' && s.active).map(s => s.unit) };
    } catch (error) {
      const reservation = join(journal.target.agentInstall, '.native-snapshot-reservation.json');
      if (!await statOptional(reservation)) await durableJson(reservation, { session: journal.session, state, targetSha256: journal.targetSha256 });
      return this.hold(state, journal, error);
    }
  }
}
