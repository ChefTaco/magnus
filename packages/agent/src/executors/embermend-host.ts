import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, lstat, rename, unlink } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { isIP } from 'node:net';
import { z } from 'zod';
import { embermendCanonical, type EmbermendOperation } from '@hivemagnus/magnus-contracts/embermend';
import { rootControlled, type EmbermendNodeConfig } from './embermend-config.js';
import { privateDirectory, readJson, writeJson, syncDirectory } from './execution-supervisor-state.js';

const exec = promisify(execFile);
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const hash = (value: unknown): string => sha(embermendCanonical(value));
type JsonObject = Record<string, z.infer<ReturnType<typeof z.json>>>;
async function command(binary: string, args: string[]): Promise<string> { return (await exec(binary, args, { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' }, timeout: 300000, maxBuffer: 1024 * 1024 })).stdout; }
async function fileState(path: string) {
  await rootControlled(dirname(path));
  const info = await lstat(path).catch((error: unknown) => { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null; throw error; });
  if (!info) return { exists: false as const, digest: hash({ exists: false }), content: null, mode: 0o600 };
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.nlink !== 1 || info.mode & 0o022 || info.size > 1024 * 1024) throw new Error('Protected regular configuration file required');
  const content = await readFile(path, 'utf8'); const mode = info.mode & 0o7777; return { exists: true as const, content, mode, digest: hash({ exists: true, contentDigest: sha(content), mode }) };
}
async function atomicFile(path: string, content: string, mode: number): Promise<void> {
  await rootControlled(dirname(path)); const temporary = join(dirname(path), '.embermend-' + sha(path + ':' + content) + '.tmp');
  const fd = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
  try { await fd.writeFile(content); await fd.sync(); } finally { await fd.close(); }
  await rename(temporary, path); await syncDirectory(dirname(path));
}
export async function rememberRecovery(request: EmbermendOperation, artifact: JsonObject): Promise<void> {
  const directory = resolve(process.env['AGENT_INSTALL_DIR'] ?? process.cwd(), '.magnus/embermend-recovery'); await privateDirectory(directory);
  await writeJson(directory, sha(request.operationId) + '.json', { operationId: request.operationId, requestDigest: hash(request), actionVersion: request.action.version, artifact });
}
async function serviceState(unit: string) {
  const agentUnit = process.env['EMBERMEND_AGENT_UNIT'];
  if (!agentUnit || unit === agentUnit || /magnus.*agent|systemd|dbus|ssh(?:d)?\.service/.test(unit)) throw new Error('Management and system services cannot use generic service actions');
  const raw = await command('/usr/bin/systemctl', ['show', unit, '--property=ActiveState', '--property=UnitFileState', '--property=LoadState']);
  const fields = Object.fromEntries(raw.trim().split('\n').map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));
  if (fields['LoadState'] !== 'loaded') throw new Error('Loaded allowlisted service required');
  const result = { unit, active: fields['ActiveState'] ?? 'unknown', enabled: fields['UnitFileState'] ?? 'unknown' }; return { ...result, beforeDigest: hash(result) };
}
export async function hostResourceObservations(config: EmbermendNodeConfig): Promise<JsonObject> {
  const result: JsonObject = {};
  for (const [id, resource] of Object.entries(config.resources)) {
    if (resource.kind === 'ssh') { const state = await fileState(resource.path); const effective = await command('/usr/sbin/sshd', ['-T']); result[id] = { exists: state.exists, beforeDigest: state.digest, permitRootLogin: /^permitrootlogin (.+)$/m.exec(effective)?.[1] ?? 'unknown', passwordAuthentication: /^passwordauthentication (.+)$/m.exec(effective)?.[1] ?? 'unknown' }; }
    if (resource.kind === 'service') result[id] = await serviceState(resource.unit);
    if (resource.kind === 'firewall') { const status = await command('/usr/sbin/ufw', ['status', 'numbered']); result[id] = { status, beforeDigest: hash(status) }; }
    if (resource.kind === 'compose') { const state = await fileState(resource.overridePath); const base = await fileState(resource.path); result[id] = { configurationDigest: sha(base.content ?? ''), beforeDigest: state.digest }; }
  }
  return result;
}
export async function executeHostAction(request: EmbermendOperation, config: EmbermendNodeConfig): Promise<JsonObject> {
  const action = request.action; const params = action.parameters;
  if (action.version === 'service-state.v1' || action.version === 'restart-service.v1') {
    const input = action.version === 'service-state.v1' ? z.object({ resourceId: z.string(), enabled: z.boolean(), active: z.boolean(), beforeDigest: z.string() }).strict().parse(params) : z.object({ resourceId: z.string(), beforeDigest: z.string() }).strict().parse(params);
    const resource = config.resources[input.resourceId]; if (!resource || resource.kind !== 'service') throw new Error('Allowlisted service required');
    if (action.class !== (action.version === 'restart-service.v1' ? 'restart' : 'host-change')) throw new Error('Service action effect mismatch');
    const before = await serviceState(resource.unit); if (before.beforeDigest !== input.beforeDigest) throw new Error('Service precondition changed');
    await rememberRecovery(request, { resourceId: input.resourceId, kind: 'service', before });
    if ('enabled' in input) {
      const desired = z.object({ enabled: z.boolean(), active: z.boolean() }).parse(input);
      if ((!desired.enabled || !desired.active) && !resource.allowDisable) throw new Error('Disabling this service is outside node policy');
      await command('/usr/bin/systemctl', [desired.enabled ? 'enable' : 'disable', resource.unit]); await command('/usr/bin/systemctl', [desired.active ? 'start' : 'stop', resource.unit]);
    } else await command('/usr/bin/systemctl', ['restart', resource.unit]);
    return { resourceId: input.resourceId, before, after: await serviceState(resource.unit), verification: 'Fresh application-specific security and health verification remains required' };
  }
  if (action.version === 'ssh-policy.v1') {
    if (action.class !== 'host-change') throw new Error('Host change effect required');
    const input = z.object({ resourceId: z.string(), permitRootLogin: z.enum(['no', 'prohibit-password']), passwordAuthentication: z.boolean(), beforeDigest: z.string(), managementProbeId: z.string() }).strict().parse(params);
    const resource = config.resources[input.resourceId]; if (!resource || resource.kind !== 'ssh' || resource.managementProbeId !== input.managementProbeId) throw new Error('SSH resource and management-path binding required');
    // Normalize the boolean PasswordAuthentication setting for state receipts.
    const sshAuthEnabled = input.passwordAuthentication === true;
    const before = await fileState(resource.path); if (before.digest !== input.beforeDigest) throw new Error('SSH configuration changed');
    const content = `# Managed by a reviewed Magnus security action\nPermitRootLogin ${input.permitRootLogin}\nPasswordAuthentication ${sshAuthEnabled ? 'yes' : 'no'}\n`;
    await rememberRecovery(request, { resourceId: input.resourceId, kind: 'file', path: resource.path, content: before.content, mode: before.mode });
    await atomicFile(resource.path, content, 0o600);
    try {
      await command('/usr/sbin/sshd', ['-t']); const effective = await command('/usr/sbin/sshd', ['-T']);
      if (!effective.includes(`permitrootlogin ${input.permitRootLogin === 'prohibit-password' ? 'without-password' : 'no'}\n`) || !effective.includes(`passwordauthentication ${sshAuthEnabled ? 'yes' : 'no'}\n`)) throw new Error('Effective SSH policy differs from requested policy');
      await command('/usr/bin/systemctl', ['reload', 'ssh.service']);
      return { resourceId: input.resourceId, permitRootLogin: input.permitRootLogin, passwordAuthentication: sshAuthEnabled, securityCheckPassed: true, managementPath: 'Magnus HTTPS agent remains the authorized management path; SSH access itself is not inferred' };
    } catch (error) {
      if (before.content === null) { await unlink(resource.path); await syncDirectory(dirname(resource.path)); } else await atomicFile(resource.path, before.content, before.mode);
      throw error;
    }
  }
  if (action.version === 'firewall-rule.v1') {
    if (action.class !== 'host-change') throw new Error('Host change effect required');
    const input = z.object({ resourceId: z.string(), protocol: z.enum(['tcp', 'udp']), port: z.number().int().min(1).max(65535), sourceCidr: z.string(), allow: z.boolean(), beforeDigest: z.string(), managementProbeId: z.string() }).strict().parse(params);
    const resource = config.resources[input.resourceId]; const [address, prefix] = input.sourceCidr.split('/'); const family = address ? isIP(address) : 0;
    if (!resource || resource.kind !== 'firewall' || resource.managementProbeId !== input.managementProbeId || !family || prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128))) throw new Error('Allowlisted firewall and CIDR required');
    if (!resource.protectedPorts.includes(Number(process.env['NODE_MANAGER_PORT'] ?? 4100)) || !resource.protectedPorts.includes(22) || !input.allow && resource.protectedPorts.includes(input.port)) throw new Error('Authorized management ports must remain protected');
    const before = await command('/usr/sbin/ufw', ['status', 'numbered']); if (hash(before) !== input.beforeDigest) throw new Error('Firewall state changed');
    await rememberRecovery(request, { resourceId: input.resourceId, kind: 'firewall', before });
    await command('/usr/sbin/ufw', ['--force', input.allow ? 'allow' : 'deny', 'proto', input.protocol, 'from', input.sourceCidr, 'to', 'any', 'port', String(input.port)]);
    return { resourceId: input.resourceId, status: await command('/usr/sbin/ufw', ['status', 'numbered']), verification: 'Configured rules do not establish reachability or Docker-published-port filtering; scoped vantage verification remains required' };
  }
  if (action.version === 'compose-deploy.v1') {
    if (action.class !== 'deploy') throw new Error('Deployment effect required');
    const input = z.object({ deploymentId: z.string(), artifactDigest: z.string().regex(/^[a-f0-9]{64}$/), configurationDigest: z.string(), beforeDigest: z.string() }).strict().parse(params);
    const resource = config.resources[input.deploymentId]; if (!resource || resource.kind !== 'compose') throw new Error('Allowlisted deployment required');
    const base = await fileState(resource.path); const before = await fileState(resource.overridePath);
    if (sha(base.content ?? '') !== input.configurationDigest || before.digest !== input.beforeDigest) throw new Error('Deployment configuration changed');
    const image = `${resource.imageRepository}@sha256:${input.artifactDigest}`;
    const override = JSON.stringify({ services: { [resource.service]: { image } } }); await rememberRecovery(request, { resourceId: input.deploymentId, kind: 'file', path: resource.overridePath, content: before.content, mode: before.mode });
    await atomicFile(resource.overridePath, override, 0o600);
    const args = ['compose', '-f', resource.path, '-f', resource.overridePath];
    await command('/usr/bin/docker', [...args, 'config', '--quiet']); await command('/usr/bin/docker', [...args, 'up', '--detach', '--no-build', '--wait', resource.service]);
    const containers = (await command('/usr/bin/docker', [...args, 'ps', '--quiet', resource.service])).trim().split('\n').filter(Boolean);
    if (!containers.length) throw new Error('Deployment has no running instances');
    const expectedImageId = (await command('/usr/bin/docker', ['image', 'inspect', image, '--format', '{{.Id}}'])).trim();
    for (const container of containers) {
      if (!/^[a-f0-9]{12,64}$/.test(container)) throw new Error('Unexpected container identity');
      if ((await command('/usr/bin/docker', ['inspect', container, '--format', '{{.Image}}'])).trim() !== expectedImageId || (await command('/usr/bin/docker', ['inspect', container, '--format', '{{.Config.Image}}'])).trim() !== image) throw new Error('Actual deployed artifact differs');
    }
    const health = await fetch(resource.healthUrl, { redirect: 'error', signal: AbortSignal.timeout(10000) }).then(response => response.ok, () => false);
    return { deploymentId: input.deploymentId, deployedArtifactDigest: input.artifactDigest, instances: containers, imageId: expectedImageId, healthPassed: health, securityVerification: 'outstanding' };
  }
  if (action.version === 'configuration-recover.v1') {
    if (action.class !== 'recovery') throw new Error('Explicit recovery effect required');
    const input = z.object({ originalOperationId: z.string(), recoveryArtifactId: z.string(), beforeDigest: z.string() }).strict().parse(params);
    if (input.recoveryArtifactId !== input.originalOperationId) throw new Error('Original recovery artifact required');
    const directory = resolve(process.env['AGENT_INSTALL_DIR'] ?? process.cwd(), '.magnus/embermend-recovery');
    const retained = await readJson<unknown>(directory, sha(input.originalOperationId) + '.json');
    const modeRecord = z.object({ operationId: z.literal(input.originalOperationId), artifact: z.object({ kind: z.literal('mode'), resourceId: z.string(), path: z.string(), mode: z.number().int().min(0).max(0o7777), dev: z.number(), ino: z.number() }).strict() }).passthrough().safeParse(retained);
    if (modeRecord.success) {
      const artifact = modeRecord.data.artifact; const resource = config.resources[artifact.resourceId];
      if (!resource || resource.kind !== 'file' || resource.path !== artifact.path) throw new Error('Recovery resource binding changed');
      await rootControlled(artifact.path); const fd = await open(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await fd.stat();
        if (!info.isFile() || info.nlink !== 1 || info.dev !== artifact.dev || info.ino !== artifact.ino || hash({ mode: info.mode & 0o7777, uid: info.uid, gid: info.gid, dev: info.dev, ino: info.ino }) !== input.beforeDigest) throw new Error('Recovery inode or precondition changed');
        await rememberRecovery(request, { originalOperationId: input.originalOperationId, kind: 'recovery' });
        await fd.chmod(artifact.mode); await fd.sync();
        if (((await fd.stat()).mode & 0o7777) !== artifact.mode) throw new Error('Recovered mode did not match');
        return { originalOperationId: input.originalOperationId, restoredMode: artifact.mode, activationAndHealthVerification: 'outstanding' };
      } finally { await fd.close(); }
    }
    const record = z.object({ operationId: z.literal(input.originalOperationId), artifact: z.object({ resourceId: z.string(), kind: z.literal('file'), path: z.string(), content: z.string().nullable(), mode: z.number().int() }) }).passthrough().parse(retained);
    const resource = config.resources[record.artifact.resourceId]; if (!resource || !(resource.kind === 'ssh' && resource.path === record.artifact.path || resource.kind === 'compose' && resource.overridePath === record.artifact.path)) throw new Error('Recovery resource binding changed');
    if ((await fileState(record.artifact.path)).digest !== input.beforeDigest) throw new Error('Recovery precondition changed');
    await rememberRecovery(request, { originalOperationId: input.originalOperationId, kind: 'recovery' });
    if (record.artifact.content === null) { await unlink(record.artifact.path); await syncDirectory(dirname(record.artifact.path)); } else await atomicFile(record.artifact.path, record.artifact.content, record.artifact.mode);
    if (resource.kind === 'ssh') { await command('/usr/sbin/sshd', ['-t']); await command('/usr/bin/systemctl', ['reload', 'ssh.service']); }
    return { originalOperationId: input.originalOperationId, restoredConfiguration: true, activationAndHealthVerification: 'outstanding' };
  }
  throw new Error('Unsupported reviewed host action');
}
