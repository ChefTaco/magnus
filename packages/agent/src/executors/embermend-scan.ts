import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { mkdir, chmod, rm, readFile, realpath, lstat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { rootControlled } from './embermend-config.js';

const exec = promisify(execFile);
async function boundedJson(response: Response, maximum: number): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('Remote broker unavailable');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const row = await reader.read(); if (row.done) break; size += row.value.length; if (size > maximum) throw new Error('Remote broker response exceeded budget'); chunks.push(row.value); } }
  finally { await reader.cancel().catch(() => undefined); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export const scanWorkerConfigSchema = z.object({
  user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/), uid: z.number().int().positive(), home: z.string().regex(/^\/[a-zA-Z0-9_./-]+$/), workspaceRoot: z.string().regex(/^\/[a-zA-Z0-9_./-]+$/),
  workspaceMiB: z.number().int().min(32).max(2048).default(512),
  scannerImage: z.string().regex(/^(?:sha256:[a-f0-9]{64}|.+@sha256:[a-f0-9]{64})$/),
  validationProfiles: z.record(z.string(), z.array(z.string().max(1000)).min(1).max(64)).default({}),
  repositories: z.record(z.string(), z.object({ providerId: z.string(), cloneUrl: z.url().refine(value => /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(value)) }).strict()),
  model: z.object({ baseUrl: z.url(), model: z.string(), ref: z.string(), local: z.boolean(), tokenFile: z.string().startsWith('/') }).strict(),
}).strict().superRefine((value, context) => { const url = new URL(value.model.baseUrl); if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && value.model.local)) context.addIssue({ code: 'custom', message: 'Approved local HTTP model or verified HTTPS required' }); });
export type ScanWorkerConfig = z.infer<typeof scanWorkerConfigSchema>;
export async function workerContainerGone(config: ScanWorkerConfig, operationId: string): Promise<boolean> {
  const name = 'embermend-scan-' + createHash('sha256').update(operationId).digest('hex');
  try {
    const result = await exec('/usr/sbin/runuser', ['-u', config.user, '--', '/usr/bin/docker', 'ps', '--all', '--filter', `name=^${name}$`, '--format', '{{.ID}}'], { env: { PATH: '/usr/bin:/bin', HOME: config.home, XDG_RUNTIME_DIR: `/run/user/${config.uid}`, DOCKER_HOST: `unix:///run/user/${config.uid}/docker.sock` }, timeout: 10000, maxBuffer: 8192 });
    const workspace = join(config.workspaceRoot, createHash('sha256').update(operationId).digest('hex'));
    const mounts = await readFile('/proc/self/mountinfo', 'utf8');
    return result.stdout.trim() === '' && !mounts.split('\n').some(line => line.split(' ')[4] === workspace);
  } catch { return false; }
}
const requestSchema = z.object({ repositoryId: z.string(), providerId: z.string(), commit: z.string().regex(/^[a-f0-9]{40,64}$/), operationId: z.string(), deadline: z.iso.datetime({ offset: true }), sourcePolicy: z.object({ allowRemoteModel: z.boolean() }).passthrough() }).passthrough();
export async function scanRepository(raw: unknown, config: ScanWorkerConfig, mode: 'scan' | 'prepare' | 'source' = 'scan'): Promise<unknown> {
  const preparation = mode === 'prepare' ? z.object({ id: z.string(), repositoryId: z.string(), providerId: z.string(), baseCommit: z.string(), deadline: z.string(), validationProfileId: z.string() }).passthrough().parse(raw) : null;
  const source = mode === 'source' ? z.object({ id: z.string(), repositoryId: z.string(), providerId: z.string(), commit: z.string(), deadline: z.string() }).passthrough().parse(raw) : null;
  const request = preparation ? requestSchema.parse({ ...preparation, commit: preparation.baseCommit, operationId: preparation.id, sourcePolicy: { allowRemoteModel: false } }) : source ? requestSchema.parse({ ...source, operationId: source.id, sourcePolicy: { allowRemoteModel: false } }) : requestSchema.parse(raw); const repository = config.repositories[request.repositoryId];
  if (!repository || repository.providerId !== request.providerId || mode === 'scan' && (!config.model.local && !request.sourcePolicy.allowRemoteModel)) throw new Error('Repository or model source-access policy denied');
  const identityUrl = new URL(repository.cloneUrl);
  const identity = await fetch('https://api.github.com/repos' + identityUrl.pathname.replace(/\.git$/, ''), { redirect: 'error', signal: AbortSignal.timeout(10000), headers: { accept: 'application/vnd.github+json' } });
  if (!identity.ok || String(z.object({ id: z.number().int().positive() }).parse(await boundedJson(identity, 65536)).id) !== repository.providerId) throw new Error('Repository identity or access changed');
  let token = '';
  if (mode === 'scan') { await rootControlled(config.model.tokenFile); if ((await lstat(config.model.tokenFile)).mode & 0o077 || (await lstat(config.model.tokenFile)).size > 8192) throw new Error('Protected model credential file required'); token = (await readFile(config.model.tokenFile, 'utf8')).trim(); }
  const owner = (await exec('/usr/bin/id', ['-u', config.user], { env: { PATH: '/usr/bin:/bin' } })).stdout.trim();
  if (owner !== String(config.uid) || config.uid === 0) throw new Error('Dedicated non-root worker identity required');
  if (await realpath(config.home) !== config.home || await realpath(config.workspaceRoot) !== config.workspaceRoot) throw new Error('Canonical worker directories required');
  const workspace = join(config.workspaceRoot, createHash('sha256').update(request.operationId).digest('hex'));
  const containerName = 'embermend-scan-' + createHash('sha256').update(request.operationId).digest('hex');
  await mkdir(workspace, { mode: 0o700 }); await chmod(workspace, 0o700);
  let mounted = false;
  await exec('/usr/bin/chown', [String(config.uid), workspace], { env: { PATH: '/usr/bin:/bin' } });
  const environment = { PATH: '/usr/bin:/bin', HOME: config.home, XDG_RUNTIME_DIR: `/run/user/${config.uid}`, DOCKER_HOST: `unix:///run/user/${config.uid}/docker.sock`, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const userCommand = async (binary: string, args: string[]): Promise<string> => (await exec('/usr/sbin/runuser', ['-u', config.user, '--', binary, ...args], { env: environment, timeout: 180000, maxBuffer: 1024 * 1024 })).stdout;
  try {
    await exec('/usr/bin/mount', ['-t', 'tmpfs', '-o', `size=${config.workspaceMiB}m,nodev,nosuid,noexec,mode=0755,uid=${config.uid},gid=${config.uid}`, 'embermend-worker', workspace], { env: { PATH: '/usr/bin:/bin' }, timeout: 10000, maxBuffer: 8192 }); mounted = true;
    const info = z.object({ SecurityOptions: z.array(z.string()) }).parse(JSON.parse(await userCommand('/usr/bin/docker', ['info', '--format', '{{json .}}'])));
    if (!info.SecurityOptions.some(value => value.includes('rootless'))) throw new Error('Rootless worker daemon required');
    await userCommand('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', 'init', workspace]);
    await userCommand('/usr/bin/git', ['-C', workspace, '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', 'fetch', '--depth=1', repository.cloneUrl, request.commit]);
    await userCommand('/usr/bin/git', ['-C', workspace, '-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', 'FETCH_HEAD']);
    if ((await userCommand('/usr/bin/git', ['-C', workspace, 'rev-parse', 'HEAD'])).trim() !== request.commit) throw new Error('Immutable checkout identity mismatch');
    let members = 0;
    const readable = async (directory: string): Promise<void> => {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        if (++members > 100000) throw new Error('Repository member budget exceeded');
        const path = join(directory, item.name); const info = await lstat(path);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) { await chmod(path, 0o755); await readable(path); }
        else if (info.isFile() && info.nlink === 1) await chmod(path, 0o644 | (info.mode & 0o111));
        else throw new Error('Unsupported repository filesystem member');
      }
    };
    await readable(workspace); await chmod(workspace, 0o755);
    const validationArgv = preparation ? config.validationProfiles[preparation.validationProfileId] : undefined;
    if (preparation && !validationArgv) throw new Error('Reviewed validation profile required');
    const entry = preparation ? '/app/packages/scanner/dist/preparation-cli.js' : source ? '/app/packages/scanner/dist/source-cli.js' : null;
    const child = spawn('/usr/sbin/runuser', ['-u', config.user, '--', '/usr/bin/docker', 'run', '--name', containerName, '--rm', '--interactive', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=1g', '--cpus=1', preparation ? '--user=0:0' : '--user=1000:1000', ...(entry ? ['--entrypoint=/usr/local/bin/node'] : []), '--mount', `type=bind,source=${workspace},target=/source${preparation ? '' : ',readonly'}`, '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', config.scannerImage, ...(entry ? [entry] : [])], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    // Make the read-only checkout readable by the container's non-root user.
    // Only this disposable source tree is shared; no home, socket or credentials.
    const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    let stderrBytes = 0; child.stderr.on('data', (value: Buffer) => { stderrBytes += value.length; if (stderrBytes > 65536) child.kill('SIGKILL'); });
    const timer = setTimeout(() => child.kill('SIGKILL'), Math.max(1, Date.parse(request.deadline) - Date.now()));
    child.stdin.write(JSON.stringify(preparation ? { request: raw, validationArgv } : source ? { request: raw } : { request: raw, modelRef: config.model.ref, localModel: config.model.local }) + '\n');
    let result: unknown; let outputBytes = 0;
    try {
      for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        outputBytes += Buffer.byteLength(line); if (outputBytes > 8 * 1024 * 1024) throw new Error('Scanner output budget exceeded');
        const message = z.discriminatedUnion('kind', [z.object({ kind: z.literal('model-request'), id: z.string(), system: z.string().max(16000), content: z.string().max(100000) }).strict(), z.object({ kind: z.literal('result'), result: z.unknown() }).strict()]).parse(JSON.parse(line));
        if (message.kind === 'result') { result = message.result; continue; }
        if (mode !== 'scan') throw new Error('Source reading or validation cannot request model access');
        const base = new URL(config.model.baseUrl.endsWith('/') ? config.model.baseUrl : config.model.baseUrl + '/');
        if (base.username || base.password || base.search || base.hash) throw new Error('Credential-free configured model URL required');
        const reply = await fetch(new URL('chat/completions', base), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(Math.min(120000, Math.max(1, Date.parse(request.deadline) - Date.now()))), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ model: config.model.model, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: message.system }, { role: 'user', content: message.content }] }) });
        if (!reply.ok || Number(reply.headers.get('content-length')) > 1024 * 1024) throw new Error('Configured model unavailable');
        const parsed = z.object({ choices: z.array(z.object({ finish_reason: z.literal('stop'), message: z.object({ content: z.string().max(1000000) }) })).min(1) }).parse(await boundedJson(reply, 1024 * 1024));
        const choice = parsed.choices[0]; if (!choice) throw new Error('Missing model completion');
        child.stdin.write(JSON.stringify({ id: message.id, result: JSON.parse(choice.message.content) }) + '\n');
      }
      const code = await exited; if (code !== 0 || result === undefined) throw new Error('Scanner did not produce a complete terminal result'); return result;
    } finally { clearTimeout(timer); child.stdin.destroy(); if (child.exitCode === null) { child.kill('SIGKILL'); await exited.catch(() => undefined); } }
  } finally {
    await userCommand('/usr/bin/docker', ['rm', '--force', containerName]).catch(() => undefined);
    let retained: string;
    try { retained = await userCommand('/usr/bin/docker', ['ps', '--all', '--filter', `name=^${containerName}$`, '--format', '{{.ID}}']); } catch { throw new Error('WORKER_CLEANUP_UNCERTAIN'); }
    if (retained.trim()) throw new Error('WORKER_CLEANUP_UNCERTAIN');
    if (mounted) { try { await exec('/usr/bin/umount', [workspace], { env: { PATH: '/usr/bin:/bin' }, timeout: 10000, maxBuffer: 8192 }); } catch { throw new Error('WORKER_CLEANUP_UNCERTAIN'); } }
    await rm(workspace, { recursive: true, force: true });
  }
}
