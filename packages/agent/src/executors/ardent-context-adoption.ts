import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readFile, rename, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ArdentContextAdoptionInputSchema } from '@hivemagnus/magnus-contracts';
import { managedExecution } from '../security/managed-context.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export const contextAdoptionInput = ArdentContextAdoptionInputSchema;
const bundleSchema = z.object({ schema_version: z.literal(1), engine_version: z.literal('0.1.0'), validator_version: z.literal('4.6.7'),
  files: z.array(z.object({ path: z.string().regex(/^(?:ardent\/(?:context|context-checkpoints|context-maintenance)\.js|emberfold\/(?:package\.json|LICENSE|NOTICE|README\.md|dist\/[A-Za-z0-9._-]+)|zod\/(?:package\.json|index\.js|LICENSE|v4\/[A-Za-z0-9_./-]+\.js))$/),
    sha256: sha, content: z.string().max(4 * 1024 * 1024) }).strict()).min(10).max(1000) }).strict();
export type ContextBundle = z.infer<typeof bundleSchema>;
export type AdoptionRoot = { owner: string; home: string; root: string; install: string };
const journalSchema = contextAdoptionInput.extend({ schema_version: z.literal(1), target_sha256: sha, profile: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  package_name: z.string().regex(/^@[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}$/),
  state: z.enum(['staging', 'prepared', 'stopping', 'switching', 'active', 'rollback-stopping', 'rollback-switching', 'rolled-back', 'restoring', 'failed']),
  acceptance: z.record(z.string(), z.unknown()).optional(), candidate_sha256: sha.optional(), rollback_verified: z.boolean().default(false) }).strict();
type Journal = z.infer<typeof journalSchema>;

export async function inspectContextAdoption(root: AdoptionRoot, profile: string, releaseId: string): Promise<Journal> {
  z.string().guid().parse(releaseId);
  z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).parse(profile);
  const path = join(process.env['AGENT_INSTALL_DIR'] ?? '/opt/magnus-agent', '.magnus/ardent-context-adoptions', releaseId + '.json');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o077) !== 0 || info.size > 1024 * 1024)
    throw new Error('Context adoption journal is unsafe');
  const journal = journalSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
  if (journal.release_id !== releaseId || journal.profile !== profile
    || journal.target_sha256 !== hash(JSON.stringify([root.owner, root.home, root.root, root.install, profile])))
    throw new Error('Context adoption journal belongs to a different target');
  return journal;
}

function requireMaintenanceOwner(reserve = 1000) {
  const context = managedExecution.getStore();
  if (!context?.coordination || context.signal?.aborted || context.coordination.expiresAt - Date.now() <= reserve)
    throw new Error('Context maintenance requires a live signed owner; inspect retained state without replay');
  return context;
}

export interface ContextActivationDriver {
  phase(state: Journal['state']): Promise<void>;
  inspect(which: 'candidate' | 'active'): Promise<unknown>;
  check(which: 'candidate' | 'active', snapshot: unknown): Promise<void>;
  stop(): Promise<void>;
  start(): Promise<void>;
  backup(): Promise<void>;
  activate(): Promise<void>;
  rollback(): Promise<void>;
  verify(which: 'candidate' | 'active'): Promise<void>;
}

export async function activateContextWithRollbackCheck(driver: ContextActivationDriver): Promise<void> {
  const beforeStop = await driver.inspect('candidate');
  await driver.phase('stopping'); await driver.stop(); await driver.check('candidate', beforeStop); await driver.backup();
  await driver.phase('switching'); await driver.activate(); await driver.start(); await driver.verify('active');
  const beforeRollback = await driver.inspect('active');
  await driver.phase('rollback-stopping'); await driver.stop(); await driver.check('active', beforeRollback);
  await driver.phase('rollback-switching'); await driver.rollback(); await driver.start(); await driver.verify('candidate');
  await driver.phase('rolled-back');
  const beforeRestore = await driver.inspect('candidate');
  await driver.phase('restoring'); await driver.stop(); await driver.check('candidate', beforeRestore);
  await driver.activate(); await driver.start(); await driver.verify('active'); await driver.phase('active');
}

export function validateContextBundle(input: unknown): ContextBundle {
  const bundle = bundleSchema.parse(input);
  const names = new Set<string>();
  let size = 0;
  for (const file of bundle.files) {
    if (file.path.split('/').some(part => ['.', '..', ''].includes(part)) || names.has(file.path)) throw new Error('Context payload path is invalid or duplicated');
    const bytes = Buffer.from(file.content, 'base64');
    if (bytes.toString('base64') !== file.content || hash(bytes) !== file.sha256) throw new Error('Context payload digest differs');
    names.add(file.path); size += bytes.length;
  }
  if (size > 12 * 1024 * 1024) throw new Error('Context payload exceeds limit');
  for (const required of ['ardent/context.js', 'ardent/context-checkpoints.js', 'ardent/context-maintenance.js',
    'emberfold/package.json', 'emberfold/dist/index.js', 'emberfold/dist/compat.js', 'zod/package.json', 'zod/index.js'])
    if (!names.has(required)) throw new Error('Context payload is incomplete');
  for (const [path, name, version] of [['emberfold/package.json', '@hivemagnus/emberfold', bundle.engine_version],
    ['zod/package.json', 'zod', bundle.validator_version]] as const) {
    z.object({ name: z.literal(name), version: z.literal(version), type: z.literal('module') })
      .parse(JSON.parse(Buffer.from(bundle.files.find(file => file.path === path)!.content, 'base64').toString('utf8')) as unknown);
  }
  return bundle;
}

export async function contextRelease(): Promise<{ bundle: ContextBundle; sha256: string }> {
  const path = fileURLToPath(new URL('../ardent-context-bundle.json', import.meta.url));
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 20 * 1024 * 1024) throw new Error('Context release payload is unsafe');
  const bytes = await readFile(path);
  return { bundle: validateContextBundle(JSON.parse(bytes.toString('utf8')) as unknown), sha256: hash(bytes) };
}

async function durableJson(path: string, value: unknown): Promise<void> {
  const next = path + '.next';
  const file = await open(next, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  await rename(next, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function ownerProcess(root: AdoptionRoot, command: string, args: string[], input?: string, timeout = 120000): Promise<string> {
  const context = requireMaintenanceOwner();
  const deadline = context.coordination!.expiresAt;
  const account = (await readFile('/etc/passwd', 'utf8')).split('\n').map(row => row.split(':')).find(row => row[0] === root.owner);
  const uid = Number(account?.[2]);
  if (!Number.isSafeInteger(uid) || uid <= 0 || account?.[5] !== root.home) throw new Error('Configured Ardent owner differs from its account');
  requireMaintenanceOwner();
  return new Promise((accept, reject) => {
    const child = spawn('/usr/sbin/runuser', ['-u', root.owner, '--', command, ...args], { detached: true,
      env: { PATH: '/usr/sbin:/usr/bin:/bin', HOME: root.home, USER: root.owner, LOGNAME: root.owner,
        LANG: 'C.UTF-8', ARDENT_HOME: root.root, XDG_RUNTIME_DIR: `/run/user/${uid}` },
      stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; const errors: Buffer[] = []; let errorSize = 0; let size = 0; let timedOut = false;
    const stop = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') reject(new Error('Maintenance process group could not be stopped; outcome is uncertain'));
    } };
    const abort = () => { timedOut = true; stop(); };
    const timer = setTimeout(abort, Math.min(timeout, Math.max(1, deadline - Date.now() - 1000)));
    context.signal?.addEventListener('abort', abort, { once: true });
    if (context.signal?.aborted) abort();
    child.stdin.on('error', () => {}); child.stdin.end(input);
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) stop(); else chunks.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { errorSize += chunk.length; if (errorSize <= 65536) errors.push(chunk); });
    child.on('error', error => { clearTimeout(timer); context.signal?.removeEventListener('abort', abort); reject(error); });
    child.on('close', async code => { clearTimeout(timer); context.signal?.removeEventListener('abort', abort); if (code !== 0 || timedOut || size > 1024 * 1024) {
      const diagnosticId = randomUUID();
      const path = join(process.env['AGENT_INSTALL_DIR'] ?? '/opt/magnus-agent', '.magnus/ardent-context-adoptions', diagnosticId + '.stderr');
      try { await writeFile(path, Buffer.concat(errors), { flag: 'wx', mode: 0o600 }); }
      catch (error) { reject(new Error('Maintenance failed and its private diagnostic could not be retained', { cause: error })); return; }
      reject(new Error(`Owner maintenance process failed; inspect private diagnostic ${diagnosticId} before continuing`));
    }
      else accept(Buffer.concat(chunks).toString('utf8')); });
  });
}

const materialize = `import{mkdir,readFile,writeFile,lstat}from'node:fs/promises';import{join}from'node:path';
let input='';for await(const chunk of process.stdin)input+=chunk;const{directory,name,bundle,verify_only}=JSON.parse(input);
for(const file of bundle.files){const parts=file.path.split('/');const group=parts.shift();let base=group==='ardent'?join(directory,'node_modules',name,'dist'):group==='emberfold'?join(directory,'node_modules/@hivemagnus/emberfold'):join(directory,'node_modules/@hivemagnus/emberfold/node_modules/zod');
const path=join(base,...parts);const parents=path.split('/');let current='/';for(const part of parents.slice(1,-1)){current=join(current,part);if(!verify_only)await mkdir(current,{recursive:true,mode:448});const info=await lstat(current);if(info.isSymbolicLink()||!info.isDirectory())throw Error('Unsafe candidate path');}
const info=await lstat(path).catch(error=>{if(error.code==='ENOENT')return null;throw error});if(info?.isSymbolicLink())throw Error('Unsafe candidate file');const bytes=Buffer.from(file.content,'base64');if(verify_only){if(!bytes.equals(await readFile(path)))throw Error('Candidate payload differs');}else await writeFile(path,bytes,{mode:420});}
if(verify_only)process.exit(0);
const path=join(directory,'node_modules',name,'package.json');const manifest=JSON.parse(await readFile(path,'utf8'));manifest.dependencies={...manifest.dependencies,'@hivemagnus/emberfold':bundle.engine_version};await writeFile(path,JSON.stringify(manifest,null,2)+'\\n');
await writeFile(join(directory,'context-adoption.json'),JSON.stringify({schema_version:1,...JSON.parse(input).receipt,engine_version:bundle.engine_version}),{flag:'wx',mode:420});`;

export interface ContextAdoptionHooks {
  packageName(): Promise<string>;
  treeDigest(path: string): Promise<string>;
  service(action: 'service-stop' | 'service-start'): Promise<unknown>;
  profiles(): Promise<string[]>;
  checkService(): Promise<void>;
}

export async function manageContextAdoption(root: AdoptionRoot, profile: string,
  action: 'context-stage' | 'context-adopt' | 'context-rollback', raw: unknown, hooks: ContextAdoptionHooks): Promise<Record<string, unknown>> {
  if (process.getuid?.() !== 0) throw new Error('Context adoption requires a privileged node manager');
  requireMaintenanceOwner();
  z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).parse(profile);
  const input = contextAdoptionInput.parse(raw);
  const targetSha256 = hash(JSON.stringify([root.owner, root.home, root.root, root.install, profile]));
  if (root.install === root.home || root.root === root.home || root.root.startsWith(root.install + sep) || root.install.startsWith(root.root + sep))
    throw new Error('Runtime and profile storage must be separate directories beneath the owner home');
  if (JSON.stringify(await hooks.profiles()) !== JSON.stringify([profile])) throw new Error('Context adoption requires exactly the selected profile in this install');
  await hooks.checkService();
  const release = await contextRelease();
  if (release.sha256 !== input.expected_bundle_sha256) throw new Error('Context release pin differs');
  for (const path of [root.home, root.root, root.install, join(root.root, 'profiles', profile)]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || !resolve(path).startsWith(resolve(root.home) + sep) && path !== root.home)
      throw new Error('Ardent context adoption path is unsafe');
  }
  const name = await hooks.packageName();
  const packagePath = (install: string) => join(install, 'node_modules', name);
  const policyPath = join(root.root, 'model-policy/active.json');
  const assertPins = async () => {
    if (hash(await readFile(policyPath)) !== input.expected_policy_sha256) throw new Error('Model policy changed during adoption');
    if (hash(await readFile(join(root.root, 'profiles', profile, 'config.yaml'))) !== input.expected_config_sha256) throw new Error('Profile configuration changed during adoption');
  };
  await assertPins();
  const work = join(dirname(root.install), 'ardent-context-adoptions', input.release_id);
  const candidate = join(work, 'candidate');
  const previous = join(work, 'previous');
  const journalRoot = join(process.env['AGENT_INSTALL_DIR'] ?? '/opt/magnus-agent', '.magnus/ardent-context-adoptions');
  await mkdir(journalRoot, { recursive: true, mode: 0o700 });
  const journalInfo = await lstat(journalRoot);
  if (!journalInfo.isDirectory() || journalInfo.isSymbolicLink() || journalInfo.uid !== 0 || (journalInfo.mode & 0o077) !== 0)
    throw new Error('Context adoption journal must be root-controlled and private');
  const journalPath = join(journalRoot, input.release_id + '.json');
  const runWorker = async (install: string, operation: 'inspect' | 'backup' | 'verify' | 'accept' | 'check', prior = root.install, snapshot?: unknown) => {
    const output = await ownerProcess(root, '/usr/bin/node', [join(packagePath(install), 'dist/context-maintenance.js')],
      JSON.stringify({ operation, profile_dir: join(root.root, 'profiles', profile), work_dir: work,
        previous_module: join(packagePath(prior), 'dist/context-checkpoints.js'), expected_policy_sha256: input.expected_policy_sha256,
        expected_config_sha256: input.expected_config_sha256,
        ...(snapshot === undefined ? {} : { snapshot }) }), operation === 'accept' ? 650000 : 90000);
    return z.record(z.string(), z.unknown()).parse(JSON.parse(output) as unknown);
  };
  const save = (journal: Journal) => { requireMaintenanceOwner(); return durableJson(journalPath, journal); };
  const service = async (action: 'service-stop' | 'service-start') => { requireMaintenanceOwner(125000); await assertPins(); return hooks.service(action); };
  const move = (from: string, to: string) => ownerProcess(root, '/usr/bin/node', ['--input-type=module', '-e',
    "import{rename,lstat}from'node:fs/promises';if(await lstat(process.argv[2]).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error}))throw Error('Adoption destination already exists');await rename(process.argv[1],process.argv[2]);", from, to]);
  if (action === 'context-stage') {
    if (await lstat(join(root.install, 'context-adoption.json')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }))
      throw new Error('An existing context adoption must be inspected before another overlay is prepared');
    if (await lstat(journalPath).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }))
      throw new Error('Adoption release already exists; inspect it without repeating work');
    if (await hooks.treeDigest(packagePath(root.install)) !== input.expected_base_sha256) throw new Error('Installed runtime changed before staging');
    const allocation = Number((await ownerProcess(root, '/usr/bin/du', ['-s', '-B1', '--', root.install])).split(/\s+/)[0]);
    const databaseSize = (await lstat(join(root.root, 'profiles', profile, 'state/ardent.sqlite'))).size;
    const disk = await statfs(root.install);
    if (!Number.isSafeInteger(allocation) || allocation < 1 || disk.bavail * disk.bsize < allocation * 2 + databaseSize * 3 + 64 * 1024 * 1024)
      throw new Error('Insufficient verified disk space for context staging, backup, and rollback');
    const journal: Journal = { ...input, schema_version: 1, target_sha256: targetSha256, profile, package_name: name, state: 'staging', rollback_verified: false };
    await save(journal);
    await ownerProcess(root, '/usr/bin/mkdir', ['-p', '-m', '700', work]);
    await ownerProcess(root, '/usr/bin/cp', ['-a', '--reflink=auto', root.install, candidate]);
    await ownerProcess(root, '/usr/bin/node', ['--input-type=module', '-e', materialize], JSON.stringify({ directory: candidate, name, bundle: release.bundle,
      receipt: { release_id: input.release_id, bundle_sha256: release.sha256, base_sha256: input.expected_base_sha256 } }));
    await runWorker(candidate, 'inspect');
    const acceptance = await runWorker(candidate, 'accept');
    await assertPins();
    journal.candidate_sha256 = await hooks.treeDigest(packagePath(candidate));
    journal.acceptance = acceptance; journal.state = 'prepared'; await save(journal);
    return { state: journal.state, release_id: input.release_id, engine_version: release.bundle.engine_version, acceptance };
  }
  const journal = journalSchema.parse(JSON.parse(await readFile(journalPath, 'utf8')) as unknown);
  for (const key of ['release_id', 'expected_bundle_sha256', 'expected_base_sha256', 'expected_policy_sha256', 'expected_config_sha256'] as const)
    if (journal[key] !== input[key]) throw new Error('Adoption request differs from the retained release');
  if (journal.profile !== profile || journal.package_name !== name || journal.target_sha256 !== targetSha256) throw new Error('Adoption target differs from its journal');
  if (action === 'context-adopt') {
    if (journal.state !== 'prepared' || journal.acceptance?.['rebuilt'] !== true) throw new Error('A verified prepared release is required');
    if (await hooks.treeDigest(packagePath(root.install)) !== input.expected_base_sha256) throw new Error('Installed runtime changed before activation');
    if (!journal.candidate_sha256 || await hooks.treeDigest(packagePath(candidate)) !== journal.candidate_sha256) throw new Error('Prepared candidate changed before activation');
    await ownerProcess(root, '/usr/bin/node', ['--input-type=module', '-e', materialize], JSON.stringify({ directory: candidate, name, bundle: release.bundle, verify_only: true }));
    await activateContextWithRollbackCheck({
      phase: async state => { journal.state = state; if (state === 'rolled-back') journal.rollback_verified = true; await save(journal); },
      inspect: async which => (await runWorker(which === 'active' ? root.install : candidate, 'inspect'))['snapshot'],
      check: async (which, snapshot) => { await runWorker(which === 'active' ? root.install : candidate, 'check', root.install, snapshot); },
      backup: async () => { await runWorker(candidate, 'backup'); },
      stop: async () => { await service('service-stop'); }, start: async () => { await service('service-start'); },
      activate: async () => { await move(root.install, previous); await move(candidate, root.install); },
      rollback: async () => { await move(root.install, candidate); await move(previous, root.install); },
      verify: async which => { await runWorker(which === 'active' ? root.install : candidate, 'verify', which === 'active' ? previous : root.install); }
    });
  } else {
    if (journal.state !== 'active') throw new Error('Only a proven active release can be rolled back');
    const beforeRollback = await runWorker(root.install, 'inspect', previous);
    journal.state = 'rollback-stopping'; await save(journal); await service('service-stop');
    await runWorker(root.install, 'check', previous, beforeRollback['snapshot']);
    journal.state = 'rollback-switching'; await save(journal);
    await move(root.install, candidate); await move(previous, root.install);
    await service('service-start'); await runWorker(candidate, 'verify', root.install);
    journal.state = 'rolled-back'; await save(journal);
  }
  return { state: journal.state, release_id: input.release_id, engine_version: release.bundle.engine_version,
    rollback_verified: journal.rollback_verified, originals_preserved: true, acceptance: journal.acceptance };
}
