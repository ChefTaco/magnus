import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { open, lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { resolve } from 'node:path';
import { privateDirectory, readJson, writeJson } from './execution-supervisor-state.js';
import { embermendOperationSchema, embermendCanonical, type EmbermendOperation } from '@hivemagnus/magnus-contracts/embermend';
import { loadEmbermendConfig, rootControlled, type EmbermendNodeConfig } from './embermend-config.js';
import { scanRepository } from './embermend-scan.js';
import { executeHostAction, hostResourceObservations, rememberRecovery } from './embermend-host.js';

import { requestReboot, RebootOutcomeUnknown } from './embermend-reboot.js';
import { assessImageVulnerabilities } from './embermend-trivy.js';
import { assessUbuntuOval } from './embermend-oval.js';
import { packageActivation } from './embermend-activation.js';

const exec = promisify(execFile);
const hash = (value: unknown): string => createHash('sha256').update(embermendCanonical(value)).digest('hex');
async function command(binary: string, args: string[]): Promise<string> {
  const result = await exec(binary, args, { timeout: 720000, maxBuffer: 3 * 1024 * 1024, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'l' } }); return result.stdout;
}
const packagesSchema = z.array(z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?$/), version: z.string().regex(/^[A-Za-z0-9.+:~_-]+$/).max(200) }).strict()).min(1).max(200);
async function securityPreview(packages: z.infer<typeof packagesSchema>, config: EmbermendNodeConfig) {
  if (!packages.every(item => config.securityPackages.includes(item.name))) throw new Error('Package outside node security-update allowlist');
  if ((await command('/usr/bin/dpkg', ['--audit'])).trim()) throw new Error('Interrupted package transaction requires separate repair');
  const held = (await command('/usr/bin/apt-mark', ['showhold'])).trim().split('\n');
  if (packages.some(item => held.includes(item.name))) throw new Error('Held package requires explicit owner intervention');
  for (const item of packages) {
    const policy = await command('/usr/bin/apt-cache', ['policy', item.name]);
    const lines = policy.split('\n'); const start = lines.findIndex(line => new RegExp('^\\s*(?:\\*\\*\\*\\s*)?' + item.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+\\d+\\s*$').test(line));
    if (start < 0) throw new Error('Requested version absent from authenticated package metadata');
    const sources: string[] = [];
    for (let index = start + 1; index < lines.length; index++) { const line = lines[index] ?? ''; if (/^\s*(?:\*\*\*\s*)?\S+\s+\d+\s*$/.test(line)) break; sources.push(line); }
    if (!sources.some(line => /\bnoble-security\//.test(line))) throw new Error('Requested package version must come from the Ubuntu 24.04 security pocket');
  }
  const simulation = await command('/usr/bin/apt-get', ['--simulate', '--no-remove', '--no-install-recommends', 'install', ...packages.map(item => `${item.name}=${item.version}`)]);
  const inventory = await command('/usr/bin/dpkg-query', ['-W', '-f=${binary:Package}\t${Version}\n']);
  return { packages, simulation, inventoryDigest: hash(inventory), previewDigest: hash({ packages, simulation, inventoryDigest: hash(inventory) }) };
}
export async function executeEmbermend(request: EmbermendOperation, config: EmbermendNodeConfig): Promise<Record<string, z.infer<ReturnType<typeof z.json>>>> {
  if (Date.parse(request.expiresAt) <= Date.now()) throw new Error('Operation expired before execution');
  const os = await readFile('/etc/os-release', 'utf8'); if (!/^ID=ubuntu$/m.test(os) || !/^VERSION_ID="24.04"$/m.test(os)) throw new Error('Ubuntu 24.04 capability required');
  const action = request.action;
  if (action.version === 'repository-scan.v1') {
    if (action.class !== 'assess' || action.targetKind !== 'worker' || !config.worker) throw new Error('Isolated worker assessment capability required');
    const parameters = z.object({ request: z.unknown() }).strict().parse(action.parameters);
    return { scanResult: z.json().parse(await scanRepository(parameters.request, config.worker)) };
  }
  if (action.version === 'repository-prepare.v1') {
    if (action.class !== 'prepare' || action.targetKind !== 'worker' || !config.worker) throw new Error('Isolated worker preparation capability required');
    const parameters = z.object({ request: z.unknown() }).strict().parse(action.parameters);
    return { preparationResult: z.json().parse(await scanRepository(parameters.request, config.worker, 'prepare')) };
  }
  if (action.version === 'repository-source.v1') {
    if (action.class !== 'assess' || action.targetKind !== 'worker' || !config.worker) throw new Error('Isolated worker source-read capability required');
    const parameters = z.object({ request: z.unknown() }).strict().parse(action.parameters);
    return { sourceResult: z.json().parse(await scanRepository(parameters.request, config.worker, 'source')) };
  }
  if (action.version === 'image-vulnerabilities.v1') {
    if (action.class !== 'assess' || action.targetKind !== 'host') throw new Error('Managed image assessment required');
    return { imageVulnerabilities: z.json().parse(await assessImageVulnerabilities(action.parameters, config)) };
  }
  if (action.version === 'ubuntu-oval.v1') {
    if (action.class !== 'assess' || action.targetKind !== 'host' || !config.ovalEnabled) throw new Error('Reviewed Ubuntu OVAL capability required');
    z.object({}).strict().parse(action.parameters); return { ubuntuOval: z.json().parse(await assessUbuntuOval()) };
  }
  if (action.targetKind !== 'host') throw new Error('Host action cannot change another namespace');
  if (action.version === 'reboot.v1') return requestReboot(request, config);
  if (action.version === 'inventory.v1') {
    if (action.class !== 'assess') throw new Error('Assessment effect required');
    const parameters = z.object({ sections: z.array(z.enum(['packages', 'services', 'listeners', 'configuration', 'docker', 'compose', 'oval'])).min(1), profileId: z.string() }).strict().parse(action.parameters);
    const failures: { section: string; reason: string }[] = [];
    const result: Record<string, z.infer<ReturnType<typeof z.json>>> = { magnus: { boundary: 'supervised-http-v1', protocol: 1 }, failures, platform: 'ubuntu-24.04', observedAt: new Date().toISOString(), sections: parameters.sections, bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(), coverage: 'complete' };
    for (const section of parameters.sections) {
      try {
      if (section === 'packages') {
        result[section] = await command('/usr/bin/dpkg-query', ['-W', '-f=${binary:Package}\t${Version}\n']);
        if (config.securityPackages.length) {
          const activation = await packageActivation(config.securityPackages); result['packageActivation'] = z.json().parse(activation);
          if (activation.coverage !== 'complete') { failures.push({ section, reason: 'PACKAGE_MAPPING_COVERAGE_PARTIAL' }); result['coverage'] = 'partial'; }
        }
      }
      else if (section === 'services') result[section] = await command('/usr/bin/systemctl', ['list-unit-files', '--type=service', '--no-pager', '--no-legend']);
      else if (section === 'listeners') result[section] = await command('/usr/bin/ss', ['-H', '-lntu']);
      else if (section === 'docker') {
        const ids = (await command('/usr/bin/docker', ['ps', '--no-trunc', '--format', '{{.ID}}'])).trim().split('\n').filter(Boolean);
        if (ids.length > 1000) throw new Error('Container inventory exceeds bounded coverage');
        const instances = [];
        for (const id of ids) {
          if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Unexpected container identity');
          const format = '{"id":{{json .Id}},"imageId":{{json .Image}},"imageRef":{{json .Config.Image}},"user":{{json .Config.User}},"privileged":{{json .HostConfig.Privileged}},"readOnly":{{json .HostConfig.ReadonlyRootfs}},"securityOptions":{{json .HostConfig.SecurityOpt}},"capAdd":{{json .HostConfig.CapAdd}},"capDrop":{{json .HostConfig.CapDrop}},"startedAt":{{json .State.StartedAt}}}';
          instances.push(z.object({ id: z.string(), imageId: z.string(), imageRef: z.string(), user: z.string(), privileged: z.boolean(), readOnly: z.boolean(), securityOptions: z.array(z.string()).nullable(), capAdd: z.array(z.string()).nullable(), capDrop: z.array(z.string()).nullable(), startedAt: z.string() }).strict().parse(JSON.parse(await command('/usr/bin/docker', ['inspect', '--format', format, id]))));
        }
        result[section] = instances; result['containerPosture'] = { applicable: instances.length > 0, ...(instances.length ? { allNonPrivileged: instances.every(item => !item.privileged), allReadOnly: instances.every(item => item.readOnly), allNoNewPrivileges: instances.every(item => item.securityOptions?.some(option => option === 'no-new-privileges' || option === 'no-new-privileges:true') === true) } : {}) };
      }
      else if (section === 'compose') result[section] = await command('/usr/bin/docker', ['compose', 'ls', '--format', 'json']);
      else if (section === 'configuration') {
        const files: Record<string, z.infer<ReturnType<typeof z.json>>> = {};
        for (const [id, resource] of Object.entries(config.resources)) if (resource.kind === 'file') { await rootControlled(resource.path); const info = await lstat(resource.path); files[id] = { mode: (info.mode & 0o777).toString(8).padStart(4, '0'), uid: info.uid, gid: info.gid, beforeDigest: hash({ mode: info.mode & 0o7777, uid: info.uid, gid: info.gid, dev: info.dev, ino: info.ino }) }; }
        result[section] = files;
        result['resources'] = await hostResourceObservations(config);
      } else throw new Error('Use the separately advertised vendor OVAL capability');
      } catch { failures.push({ section, reason: 'SECTION_UNAVAILABLE_OR_UNSUPPORTED' }); result['coverage'] = 'partial'; }
    }
    return result;
  }
  if (action.version === 'file-mode.v1') {
    if (action.class !== 'host-change') throw new Error('Host change effect required');
    const parameters = z.object({ resourceId: z.string(), mode: z.enum(['0600', '0640', '0700', '0750']), beforeDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(action.parameters);
    const resource = config.resources[parameters.resourceId]; if (!resource || resource.kind !== 'file' || !resource.allowedModes.includes(parameters.mode)) throw new Error('File mode outside node allowlist');
    // Parent traversal is checked before opening; O_NOFOLLOW binds the final
    // inode, and ownership checks prevent an untrusted account swapping parents.
    await rootControlled(resource.path);
    const fd = await open(resource.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await fd.stat(); if ((!stat.isFile() && !stat.isDirectory()) || stat.nlink !== 1) throw new Error('Unsupported resource');
      const before = { mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid, dev: stat.dev, ino: stat.ino };
      if (hash(before) !== parameters.beforeDigest) throw new Error('Resource precondition changed');
      await rememberRecovery(request, { kind: 'mode', resourceId: parameters.resourceId, path: resource.path, mode: before.mode, dev: before.dev, ino: before.ino });
      await fd.chmod(Number.parseInt(parameters.mode, 8)); await fd.sync(); const after = await fd.stat();
      if ((after.mode & 0o7777) !== Number.parseInt(parameters.mode, 8)) throw new Error('Effective mode did not match');
      return { resourceId: parameters.resourceId, before, after: { mode: after.mode & 0o7777, uid: after.uid, gid: after.gid }, recovery: { originalMode: (stat.mode & 0o7777).toString(8) }, securityCheckPassed: true };
    } finally { await fd.close(); }
  }
  if (action.version === 'security-update-preview.v1') {
    if (action.class !== 'assess') throw new Error('Assessment effect required');
    const parameters = z.object({ packages: packagesSchema }).strict().parse(action.parameters); return securityPreview(parameters.packages, config);
  }
  if (action.version === 'security-update.v1') {
    if (action.class !== 'host-change') throw new Error('Host change effect required');
    const parameters = z.object({ packages: packagesSchema, previewDigest: z.string().regex(/^[a-f0-9]{64}$/), allowDependencyChanges: z.boolean(), allowServiceRestarts: z.boolean() }).strict().parse(action.parameters);
    const preview = await securityPreview(parameters.packages, config);
    if (preview.previewDigest !== parameters.previewDigest) throw new Error('Package preview changed');
    const changedPackages = preview.simulation.split('\n').filter(line => line.startsWith('Inst ')).map(line => line.split(' ')[1]);
    if (!parameters.allowDependencyChanges && changedPackages.some(name => !parameters.packages.some(item => item.name === name))) throw new Error('Dependency changes require a revised plan');
    // maintainer scripts may restart services. Require this impact to be explicit.
    if (!parameters.allowServiceRestarts) throw new Error('Package scripts may restart services; explicit authorization required');
    await command('/usr/bin/apt-get', ['--assume-yes', '--no-remove', '--no-install-recommends', 'install', ...parameters.packages.map(item => `${item.name}=${item.version}`)]);
    const installed = await command('/usr/bin/dpkg-query', ['-W', '-f=${binary:Package}\t${Version}\n', ...parameters.packages.map(item => item.name)]);
    const rebootRequired = await readFile('/var/run/reboot-required', 'utf8').then(() => true, (error: unknown) => { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false; throw error; });
    return { installed, rebootRequired, activationVerification: 'outstanding', recovery: 'Package downgrade is not guaranteed; use a separately authorized forward repair or reviewed recovery' };
  }
  return executeHostAction(request, config);
}
if (process.argv[1]?.endsWith('/embermend-worker.js')) {
  try {
    const request = embermendOperationSchema.parse(JSON.parse(process.env['EMBERMEND_REQUEST'] ?? 'null'));
    const result = await executeEmbermend(request, await loadEmbermendConfig());
    const directory = resolve(process.env['AGENT_INSTALL_DIR'] ?? process.cwd(), '.magnus/embermend-results');
    await privateDirectory(directory);
    const resultKey = createHash('sha256').update(request.operationId + ':' + hash(request)).digest('hex');
    const full = { success: true, data: result }; if (Buffer.byteLength(JSON.stringify(full)) > 7 * 1024 * 1024) throw new Error('Result exceeds declared evidence budget');
    const prior = await readJson<unknown>(directory, resultKey + '.json', 8 * 1024 * 1024);
    if (prior && hash(prior) !== hash(full)) throw new Error('Immutable native result identity conflict');
    if (!prior) await writeJson(directory, resultKey + '.json', full);
    process.stdout.write(JSON.stringify({ resultKey, resultDigest: hash(full) }));
  } catch (error) {
    // No source or credentials enter ordinary logs. Detached worker cleanup
    // uncertainty must retain the original node lease.
    process.stderr.write('Embermend worker failed; inspect retained operation evidence\n');
    process.exitCode = error instanceof RebootOutcomeUnknown || error instanceof Error && error.message === 'WORKER_CLEANUP_UNCERTAIN' ? 70 : 1;
  }
}
