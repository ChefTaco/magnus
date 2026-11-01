#!/usr/bin/env node
import { config } from 'dotenv';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, createReadStream, realpathSync } from 'node:fs';
import { access, chown, chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { childEnvironment } from './utils/child-env.js';
import { armChildTimeout } from './utils/child-timeout.js';

// Compare real paths: the service may start this file through a link (node_modules -> current/node_modules).
const invokedAsService = (() => {
  try {
    return Boolean(process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)));
  } catch {
    return false;
  }
})();
if (invokedAsService) config({ path: join(process.env['AGENT_INSTALL_DIR'] ?? '/opt/magnus-agent', '.env'), quiet: true });
const api = new URL('/api/v1/hermes-registry/', process.env['CONTROL_API_URL'] ?? 'https://localhost:4000');
const token = process.env['HERMES_REGISTRY_TOKEN'] ?? '';
const hostname = (process.env['HOST_FQDN'] ?? '').split('.')[0]?.toLowerCase();
const submitOnly = process.argv.includes('--submit-only');
const hostFqdn = (process.env['HOST_FQDN'] ?? '').toLowerCase();
// Registry pulls install desired state on this host, so they are an explicit opt-in.
const pullEnabled = (process.env['MAGNUS_HERMES_SYNC_PULL'] ?? 'false').toLowerCase() === 'true';
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** Stream a (possibly large) file through SHA-256 instead of buffering it. */
const digestFile = (path: string) => new Promise<string>((done, fail) => {
  const hash = createHash('sha256');
  createReadStream(path).on('error', fail).on('data', chunk => hash.update(chunk)).on('end', () => done(hash.digest('hex')));
});
const safeSlug = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(value) && !value.includes('..');
export const pluginEnabled = (status: string | undefined) => /^(enabled|loaded|active)$/i.test(status?.trim() ?? '');
type FileEntry = { path: string; contentBase64: string; sha256: string; mode: 420 | 493 };
type SkillArtifact = { format: 'magnus-hermes-skill-v1'; installPath: string; files: FileEntry[] };
type Component = { kind: 'skill' | 'plugin' | 'mcp'; slug: string; profileId: string; profileHome: string; hermesBin: string; installPath?: string; revision: number; sha256: string; observedRevision: number | null };
type Receipt = { revision: number; sha256: string; treeSha256: string };

async function runAsOwner(bin: string, home: string, args: string[], timeoutMs = 30_000): Promise<string> {
  const ownerHome = home.match(/^\/home\/[^/]+/)?.[0] ?? '/root';
  if (bin === 'hermes') bin = join(ownerHome, '.local/bin/hermes');
  if (!(isAbsolute(bin) && /^\/(?:home|usr|opt)\/[a-zA-Z0-9_./-]+$/.test(bin))) throw new Error('Unsafe Hermes binary path');
  const owner = await stat(home);
  return new Promise((done, fail) => {
    const child = spawn(bin, args, { env: { ...childEnvironment(), HOME: ownerHome, HERMES_HOME: home,
      XDG_RUNTIME_DIR: `/run/user/${owner.uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${owner.uid}/bus`,
      PATH: `${ownerHome}/.local/bin:/usr/local/bin:/usr/bin:/bin` }, stdio: ['ignore', 'pipe', 'pipe'],
      ...(process.getuid?.() === 0 ? { uid: owner.uid, gid: owner.gid } : {}) });
    let output = ''; let error = '';
    const disarm = armChildTimeout(child, timeoutMs, () => {});
    child.stdout.on('data', (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-128_000); });
    child.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString('utf8')).slice(-8_000); });
    child.on('error', err => { disarm(); fail(err); });
    child.on('close', code => { disarm(); if (code === 0) done(output); else fail(new Error(`Hermes ${args[0]} failed (${code}): ${error.slice(-500)}`)); });
  });
}

function runHermes(bin: string, home: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return runAsOwner(bin, home, args, timeoutMs);
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const { controlApiFetch } = await import('./tls.js');
  const response = await controlApiFetch(new URL(path, api), { method, headers: { 'x-hermes-registry-token': token,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Registry ${method} ${path} failed (${response.status})`);
  const parsed = await response.json() as { success: boolean; data: T };
  if (!parsed.success) throw new Error('Registry response was unsuccessful');
  return parsed.data;
}

function profileHome(value: string): string {
  let home = value;
  if (home.startsWith('~/')) {
    const owner = process.env['HERMES_USER'];
    if (!owner || !/^[a-z_][a-z0-9_-]*$/i.test(owner)) throw new Error('Relative Hermes home requires HERMES_USER');
    home = join('/home', owner, home.slice(2));
  }
  if (!isAbsolute(home) || !/^\/(?:home\/[a-z_][a-z0-9_-]*|root)\/\.hermes(?:\/|$)/i.test(home)
    || resolve(home) !== home) throw new Error('Unsafe Hermes profile home');
  return home;
}

export function safeInstallPath(value: string): boolean {
  return value.length <= 240 && value.split('/').every(safeSlug) && !value.startsWith('/');
}

async function collect(dir: string, installPath: string): Promise<SkillArtifact> {
  if (!safeInstallPath(installPath)) throw new Error('Unsafe skill install path');
  const files: FileEntry[] = [];
  async function visit(current: string, relative: string): Promise<void> {
    for (const item of await readdir(current, { withFileTypes: true })) {
      if (item.name === '.magnus-registry.json' || item.name.startsWith('.magnus-sync-')) continue;
      const path = relative ? `${relative}/${item.name}` : item.name;
      if (path.split('/').some(segment => !safeSlug(segment))) throw new Error('Unsafe local skill path');
      if (item.isSymbolicLink()) throw new Error('Local skill contains a symlink');
      if (item.isDirectory()) { await visit(join(current, item.name), path); continue; }
      if (!item.isFile()) throw new Error('Unsupported local skill file');
      const bytes = await readFile(join(current, item.name));
      if (bytes.length > 2 * 1024 * 1024) throw new Error('Local skill file exceeds limit');
      const details = await stat(join(current, item.name));
      files.push({ path, contentBase64: bytes.toString('base64'), sha256: digest(bytes), mode: (details.mode & 0o111) ? 493 : 420 });
    }
  }
  await visit(dir, '');
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (!files.some(file => file.path === 'SKILL.md') || files.length > 256) throw new Error('Invalid local Hermes skill');
  return { format: 'magnus-hermes-skill-v1', installPath, files };
}

export function verifyArtifact(value: unknown, expectedSha: string): SkillArtifact {
  if (!value || typeof value !== 'object') throw new Error('Missing artifact');
  const artifact = value as SkillArtifact;
  if (artifact.format !== 'magnus-hermes-skill-v1' || !safeInstallPath(artifact.installPath)
    || !Array.isArray(artifact.files) || artifact.files.length > 256)
    throw new Error('Invalid skill artifact');
  if (digest(JSON.stringify(artifact)) !== expectedSha) throw new Error('Registry artifact hash mismatch');
  const names = new Set<string>();
  let size = 0;
  for (const file of artifact.files) {
    if (typeof file.path !== 'string' || file.path.split('/').some(segment => !safeSlug(segment)) || names.has(file.path)
      || (file.mode !== 420 && file.mode !== 493)) throw new Error('Unsafe skill artifact path or mode');
    names.add(file.path);
    const bytes = Buffer.from(file.contentBase64, 'base64');
    if (bytes.toString('base64') !== file.contentBase64 || digest(bytes) !== file.sha256) throw new Error('Skill artifact file hash mismatch');
    size += bytes.length;
  }
  if (!names.has('SKILL.md') || size > 3 * 1024 * 1024) throw new Error('Incomplete skill artifact');
  return artifact;
}

async function report(component: Component, status: 'applied' | 'drifted' | 'failed' | 'busy' | 'unsupported', error?: string): Promise<void> {
  await request('/receipts', 'POST', { kind: component.kind, slug: component.slug, profileId: component.profileId,
    revision: component.revision, sha256: component.sha256, status, details: error ? { error: error.slice(0, 500) } : {} });
}

async function captureProfiles(): Promise<Set<string>> {
  const result = await request<{ hermesBin: string; profiles: Array<{ id: string; profileHome: string }> }>('/profiles');
  const captured = new Set<string>();
  const inventory: Array<{ profileId: string; kind: 'plugin' | 'mcp'; slug: string; pluginType: string | null; sourceKind: string; sourceUrl: string | null;
    commit: string | null; version: string | null; status: string }> = [];
  for (const profile of result.profiles) {
    const home = profileHome(profile.profileHome);
    const root = join(home, 'skills');
    if (!submitOnly) {
      try {
        const surface = parseToolSurface(await toolsSummary(result.hermesBin, home));
        await request('/tool-surface', 'POST', { profileId: profile.id, surface });
      } catch (error) { process.stderr.write(`Tool inventory failed: ${error instanceof Error ? error.message : String(error)}\n`); }
      try {
        const provenance = JSON.parse(await readFile(join(home, 'plugins', '.install-metadata.json'), 'utf8').catch(() => '{}')) as
          Record<string, { source?: string; revision?: string }>;
        const rows = JSON.parse(await runHermes(result.hermesBin, home, ['plugins', 'list', '--json'])) as Array<Record<string, unknown>>;
        const coreHead = (await runAsOwner('/usr/bin/git', home, ['-C', join(home, 'hermes-agent'), 'rev-parse', 'HEAD']).catch(() => '')).trim();
        for (const row of rows) {
          const slug = typeof row['name'] === 'string' ? row['name'] : '';
          if (!safeSlug(slug)) continue;
          const source = typeof row['source'] === 'string' ? row['source'] : 'unknown';
          const record = provenance[slug];
          const commit = record?.revision && /^[a-f0-9]{40}$/.test(record.revision) ? record.revision
            : source === 'bundled' && /^[a-f0-9]{40}$/.test(coreHead) ? coreHead : null;
          const candidateUrl = record?.source?.startsWith('https://') ? record.source
            : record?.source && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(record.source) ? `https://github.com/${record.source}`
              : source === 'bundled' ? 'https://github.com/NousResearch/hermes-agent' : null;
          let sourceUrl: string | null = null;
          try { if (candidateUrl) { const parsed = new URL(candidateUrl); if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash) sourceUrl = parsed.toString(); } }
          catch { /* unresolved or secret-bearing provenance stays local */ }
          const prefixes = ['memory', 'context', 'platforms', 'image_gen', 'video_gen'];
          let pluginType: string = 'general';
          for (const prefix of prefixes) {
            const candidates = [join(home, 'plugins', prefix, slug), join(home, 'hermes-agent', 'plugins', prefix, slug)];
            if ((await Promise.all(candidates.map(path => access(path).then(() => true).catch(() => false)))).some(Boolean)) {
              pluginType = prefix === 'memory' ? 'memory-provider' : prefix === 'context' ? 'context-engine'
                : prefix === 'platforms' ? 'transport' : 'provider'; break;
            }
          }
          inventory.push({ profileId: profile.id, kind: 'plugin', slug, pluginType, sourceKind: source === 'bundled' ? 'bundled' : commit && sourceUrl ? 'git' : source === 'user' ? 'local' : 'unknown',
            sourceUrl, commit, version: typeof row['version'] === 'string' ? row['version'].slice(0, 100) : null,
            status: typeof row['status'] === 'string' ? row['status'].slice(0, 100) : 'unknown' });
        }
      } catch (error) { process.stderr.write(`Plugin inventory failed: ${error instanceof Error ? error.message : String(error)}\n`); }
      try {
        const listed = await runHermes(result.hermesBin, home, ['mcp', 'list']);
        for (const line of listed.split('\n')) {
          const match = line.match(/^\s{2}([a-zA-Z0-9][a-zA-Z0-9._+-]*)\s{2,}.+?\s{2,}(?:all|\d+)\s{2,}(.+)$/);
          if (!match || !safeSlug(match[1]!)) continue;
          const slug = match[1]!;
          let status = match[2]!.trim().slice(0, 100);
          if (/enabled/i.test(status)) {
            try { await runHermes(result.hermesBin, home, ['mcp', 'test', slug], 20_000); status = 'healthy'; }
            catch { status = 'unhealthy'; }
          }
          inventory.push({ profileId: profile.id, kind: 'mcp', slug, pluginType: null, sourceKind: 'unknown', sourceUrl: null,
            commit: null, version: null, status });
        }
      } catch (error) { process.stderr.write(`MCP inventory failed: ${error instanceof Error ? error.message : String(error)}\n`); }
    }
    const skillPaths: string[] = [];
    async function discover(current: string, relative: string, depth: number): Promise<void> {
      if (depth > 5) return;
      let entries;
      try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
      if (relative && entries.some(entry => entry.name === 'SKILL.md' && entry.isFile())) { skillPaths.push(relative); return; }
      for (const entry of entries) {
        if (!entry.isDirectory() || !safeSlug(entry.name) || entry.name.startsWith('.magnus-sync-')) continue;
        await discover(join(current, entry.name), relative ? `${relative}/${entry.name}` : entry.name, depth + 1);
      }
    }
    await discover(root, '', 0);
    for (const installPath of skillPaths) {
      const skillDir = join(root, installPath);
      const name = installPath.split('/').at(-1)!;
      const slug = installPath.includes('/') ? `${name}-${digest(installPath).slice(0, 12)}` : name;
      try {
        const artifact = await collect(skillDir, installPath);
        let receipt: Receipt | null = null;
        try { receipt = JSON.parse(await readFile(join(skillDir, '.magnus-registry.json'), 'utf8')) as Receipt; } catch { /* unmanaged */ }
        if (receipt?.treeSha256 === digest(JSON.stringify(artifact))) continue;
        const frontmatter = Buffer.from(artifact.files.find(file => file.path === 'SKILL.md')!.contentBase64, 'base64').toString('utf8').split('---', 3)[1] ?? '';
        const tagLine = frontmatter.match(/^tags:\s*\[([^\]]*)\]/m)?.[1] ?? '';
        const tags = tagLine.split(',').map(tag => tag.trim().replace(/^['"]|['"]$/g, '')).filter(safeSlug);
        const response = await request<{ status: string; duplicate: boolean }>('/capture', 'POST', { slug, profileId: profile.id,
          artifact, baseRevision: receipt?.revision ?? 0, tags });
        if (response.status === 'published' && !response.duplicate) captured.add(`${profile.id}:${slug}`);
        else if (response.status !== 'published') process.stderr.write(`Capture held for ${slug}: ${response.status}\n`);
      } catch (error) {
        process.stderr.write(`Capture failed for ${slug}: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }
  if (!submitOnly && inventory.length) await request('/inventory', 'POST', { items: inventory.slice(0, 500) });
  return captured;
}

async function publishLocal(component: Component, skillDir: string): Promise<boolean> {
  let exists = true;
  try { await access(skillDir, constants.F_OK); } catch { exists = false; }
  if (!exists) return false;
  if (!(await lstat(skillDir)).isDirectory()) throw new Error('Local skill is not a directory');
  const artifact = await collect(skillDir, component.installPath ?? component.slug);
  const treeSha256 = digest(JSON.stringify(artifact));
  let receipt: Receipt | null = null;
  try { receipt = JSON.parse(await readFile(join(skillDir, '.magnus-registry.json'), 'utf8')) as Receipt; } catch { /* unmanaged */ }
  if (receipt?.treeSha256 === treeSha256) return false;
  const captured = await request<{ status: string; duplicate: boolean; revision: number; sha256: string }>('/capture', 'POST', { slug: component.slug, profileId: component.profileId,
    artifact, baseRevision: receipt?.revision ?? 0, tags: [] });
  if (captured.status !== 'published') throw new Error(`Local skill capture retained as ${captured.status}`);
  if (captured.duplicate) {
    if (captured.revision !== component.revision || captured.sha256 !== component.sha256)
      throw new Error('Local skill matches a different registry revision; pin preserved');
    await writeFile(join(skillDir, '.magnus-registry.json'), JSON.stringify({ revision: captured.revision,
      sha256: captured.sha256, treeSha256 } satisfies Receipt), { mode: 0o600 });
    return false;
  }
  return true;
}

async function applySkill(component: Component): Promise<void> {
  if (!safeSlug(component.slug)) throw new Error('Invalid skill slug');
  const home = profileHome(component.profileHome);
  const skillRoot = join(home, 'skills');
  const installPath = component.installPath ?? component.slug;
  if (!safeInstallPath(installPath)) throw new Error('Invalid skill install path');
  const destination = join(skillRoot, installPath);
  if (!(await lstat(home)).isDirectory()) throw new Error('Hermes profile home is not a directory');
  try { if (!(await lstat(skillRoot)).isDirectory()) throw new Error('Hermes skills root is not a directory'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Capture local changes before downloading a replacement. The new revision
  // will be selected on the next tick, preventing a same-tick lost edit.
  if (await publishLocal(component, destination)) { await report(component, 'drifted', 'Local edit captured; waiting for new manifest'); return; }
  let current: Receipt | null = null;
  try { current = JSON.parse(await readFile(join(destination, '.magnus-registry.json'), 'utf8')) as Receipt; } catch { /* first install */ }
  if (current?.revision === component.revision && current.sha256 === component.sha256) return;
  const response = await request<{ sha256: string; artifact: unknown }>(`/artifacts/skill/${component.slug}/${component.revision}`);
  if (response.sha256 !== component.sha256) throw new Error('Manifest and artifact hashes differ');
  const artifact = verifyArtifact(response.artifact, component.sha256);
  if (artifact.installPath !== installPath) throw new Error('Manifest and artifact install paths differ');
  await mkdir(skillRoot, { recursive: true });
  const owner = await stat(skillRoot);
  const staging = join(skillRoot, `.magnus-sync-${component.slug}-${randomUUID()}`);
  const backup = join(skillRoot, `.magnus-sync-${component.slug}-${randomUUID()}-backup`);
  await mkdir(staging, { mode: 0o700 });
  let backedUp = false;
  try {
    for (const file of artifact.files) {
      const target = join(staging, file.path);
      await mkdir(dirname(target), { recursive: true });
      if (process.getuid?.() === 0) {
        let parent = dirname(target);
        while (parent !== staging) { await chown(parent, owner.uid, owner.gid); parent = dirname(parent); }
      }
      await writeFile(target, Buffer.from(file.contentBase64, 'base64'), { mode: file.mode });
      await chmod(target, file.mode);
      if (process.getuid?.() === 0) await chown(target, owner.uid, owner.gid);
    }
    await writeFile(join(staging, '.magnus-registry.json'), JSON.stringify({ revision: component.revision, sha256: component.sha256,
      treeSha256: digest(JSON.stringify(artifact)) } satisfies Receipt), { mode: 0o600 });
    if (process.getuid?.() === 0) await chown(join(staging, '.magnus-registry.json'), owner.uid, owner.gid);
    if (process.getuid?.() === 0) await chown(staging, owner.uid, owner.gid);
    await mkdir(dirname(destination), { recursive: true });
    try { await lstat(destination); await rename(destination, backup); backedUp = true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(staging, destination);
    const instructions = Buffer.from(artifact.files.find(file => file.path === 'SKILL.md')!.contentBase64, 'base64').toString('utf8');
    const declaredName = instructions.match(/^name:\s*['"]?([^\n'"#]+)['"]?\s*$/m)?.[1]?.trim();
    if (!declaredName) throw new Error('Deployed skill has no declared name');
    const nativeList = await runHermes(component.hermesBin, home, ['skills', 'list'], 30_000);
    if (!nativeList.includes(declaredName)) throw new Error('Hermes did not load the deployed skill');
    await report(component, 'applied');
    if (backedUp) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (backedUp) {
      await rm(destination, { recursive: true, force: true });
      await rename(backup, destination);
    }
    throw error;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

async function applyPlugin(component: Component): Promise<void> {
  const home = profileHome(component.profileHome);
  const response = await request<{ sha256: string; artifact: unknown }>(`/artifacts/plugin/${component.slug}/${component.revision}`);
  if (digest(JSON.stringify(response.artifact)) !== component.sha256 || response.sha256 !== component.sha256)
    throw new Error('Plugin artifact hash mismatch');
  const artifact = response.artifact as { format?: string; sourceUrl?: string; commit?: string };
  if (artifact.format !== 'magnus-hermes-plugin-v1' || !artifact.sourceUrl?.startsWith('https://')
    || !/^[a-f0-9]{40}$/.test(artifact.commit ?? '')) throw new Error('Invalid plugin release');
  const metadataPath = join(home, 'plugins', '.install-metadata.json');
  const markerPath = join(home, 'plugins', `.magnus-registry-${component.slug}.json`);
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8').catch(() => '{}')) as Record<string, { revision?: string; source?: string; pinned?: boolean }>;
  const installed = metadata[component.slug];
  let marker: Receipt | null = null;
  try { marker = JSON.parse(await readFile(markerPath, 'utf8')) as Receipt; } catch { /* not Magnus-managed */ }
  const listedBefore = JSON.parse(await runHermes(component.hermesBin, home, ['plugins', 'list', '--json'])) as Array<{ name?: string; status?: string }>;
  const previouslyEnabled = listedBefore.some(row => row.name === component.slug && pluginEnabled(row.status));
  if (installed?.pinned && !marker) {
    await report(component, 'drifted', 'Hermes explicit plugin pin is retained until the operator enrolls it in Magnus'); return;
  }
  if (installed?.revision === artifact.commit) {
    await runHermes(component.hermesBin, home, ['plugins', 'doctor', component.slug, '--ci'], 2 * 60_000);
    if (!previouslyEnabled) { await report(component, 'drifted', 'Plugin is installed but not enabled'); return; }
    await writeFile(markerPath, JSON.stringify({ revision: component.revision, sha256: component.sha256, treeSha256: artifact.commit }), { mode: 0o600 });
    await report(component, 'applied'); return;
  }
  if (installed && (!marker || marker.revision !== component.observedRevision)) {
    await report(component, 'drifted', 'Existing plugin pin is not owned by this registry target'); return;
  }
  // Native installer enforces full commit identity, scanning and per-plugin
  // grants. It cannot add new capabilities or dependencies noninteractively.
  try {
    await runHermes(component.hermesBin, home, ['plugins', 'install', artifact.sourceUrl!, '--force', '--ref', artifact.commit!], 10 * 60_000);
    const updated = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, { revision?: string; source?: string }>;
    if (updated[component.slug]?.revision !== artifact.commit) throw new Error('Native plugin install did not record the exact commit');
    await runHermes(component.hermesBin, home, ['plugins', 'doctor', component.slug, '--ci'], 2 * 60_000);
    if (previouslyEnabled) {
      const listedAfter = JSON.parse(await runHermes(component.hermesBin, home, ['plugins', 'list', '--json'])) as Array<{ name?: string; status?: string }>;
      if (!listedAfter.some(row => row.name === component.slug && pluginEnabled(row.status)))
        throw new Error('Previously enabled plugin is no longer enabled');
    }
    await writeFile(markerPath, JSON.stringify({ revision: component.revision, sha256: component.sha256, treeSha256: artifact.commit }), { mode: 0o600 });
    await report(component, 'applied');
  } catch (error) {
    if (installed?.revision && installed.source && /^[a-f0-9]{40}$/.test(installed.revision)) {
      await runHermes(component.hermesBin, home, ['plugins', 'install', installed.source, '--force', '--ref', installed.revision], 10 * 60_000);
    }
    throw error;
  }
}

async function applyMcp(component: Component): Promise<void> {
  const home = profileHome(component.profileHome);
  if (!safeSlug(component.slug)) throw new Error('Invalid MCP backend slug');
  const response = await request<{ sha256: string; artifact: unknown }>(`/artifacts/mcp/${component.slug}/${component.revision}`);
  if (response.sha256 !== component.sha256 || digest(JSON.stringify(response.artifact)) !== component.sha256)
    throw new Error('MCP release artifact hash mismatch');
  const artifact = response.artifact as { format?: string; ownerHost?: string; adapter?: string; rollbackAdapter?: string;
    serviceUnit?: string; healthProbe?: string; files?: FileEntry[] };
  if (artifact.format !== 'magnus-hermes-mcp-v1' || artifact.ownerHost?.toLowerCase() !== hostname
    || artifact.adapter !== 'systemd-user-tree-v1' || artifact.rollbackAdapter !== 'symlink-restore-v1'
    || !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*\.service$/.test(artifact.serviceUnit ?? '')
    || !Array.isArray(artifact.files) || !artifact.files.length) throw new Error('Unsupported MCP release contract');
  const probe = new URL(artifact.healthProbe ?? '');
  if (!['127.0.0.1', 'localhost', ...(hostFqdn.includes('.') ? [hostFqdn] : [])].includes(probe.hostname)
    || !['http:', 'https:'].includes(probe.protocol) || (probe.protocol === 'http:' && probe.hostname !== '127.0.0.1')
    || probe.username || probe.password) throw new Error('MCP health probe is outside owning host');
  const unit = artifact.serviceUnit!;
  const root = join(home, 'magnus-mcp', component.slug);
  const current = join(root, 'current');
  const unitDefinition = await runAsOwner('/usr/bin/systemctl', home, ['--user', 'cat', unit]);
  if (!unitDefinition.split('\n').some(line => /^\s*(?:ExecStart|WorkingDirectory)=/.test(line) && line.includes(current)))
    throw new Error('MCP systemd unit does not execute from the managed release path');
  const service = await runAsOwner('/usr/bin/systemctl', home, ['--user', 'is-active', unit]).catch(() => 'inactive');
  if (service.trim() !== 'active') { await report(component, 'drifted', 'MCP service was inactive; no restart or activation attempted'); return; }
  const releases = join(root, 'revisions');
  let previous: string;
  try {
    if (!(await lstat(current)).isSymbolicLink()) throw new Error('Current MCP release is not a managed symlink');
    previous = await readlink(current);
    if (!/^revisions\/[a-zA-Z0-9._-]+$/.test(previous)) throw new Error('Current MCP release points outside managed revisions');
  } catch (error) { throw new Error(`MCP backend has no safe rollback release: ${error instanceof Error ? error.message : String(error)}`); }
  const owner = await stat(home);
  const name = `${component.revision}-${component.sha256.slice(0, 16)}`;
  const revisionDir = join(releases, name);
  const marker = join(revisionDir, '.magnus-mcp.json');
  let alreadyStaged = false;
  try {
    alreadyStaged = JSON.parse(await readFile(marker, 'utf8')).sha256 === component.sha256;
    if (alreadyStaged) {
      for (const file of artifact.files) {
        if (file.path.split('/').some(segment => !safeSlug(segment))) throw new Error('Unsafe staged MCP path');
        const staged = join(revisionDir, file.path);
        const details = await lstat(staged);
        if (!details.isFile() || digest(await readFile(staged)) !== file.sha256)
          throw new Error('Staged MCP release differs from its immutable artifact');
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!alreadyStaged) {
    try { await lstat(revisionDir); throw new Error('MCP release directory exists with different content'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await mkdir(releases, { recursive: true });
    if (process.getuid?.() === 0) { await chown(join(home, 'magnus-mcp'), owner.uid, owner.gid); await chown(root, owner.uid, owner.gid); await chown(releases, owner.uid, owner.gid); }
    const staging = join(releases, `.staging-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    try {
      let total = 0;
      for (const file of artifact.files) {
        if (file.path.split('/').some(segment => !safeSlug(segment)) || (file.mode !== 420 && file.mode !== 493))
          throw new Error('Unsafe MCP release file path');
        const bytes = Buffer.from(file.contentBase64, 'base64');
        if (bytes.toString('base64') !== file.contentBase64 || digest(bytes) !== file.sha256) throw new Error('MCP release file hash mismatch');
        total += bytes.length;
        if (total > 3 * 1024 * 1024) throw new Error('MCP release exceeds admission size');
        const target = join(staging, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes, { mode: file.mode });
        await chmod(target, file.mode);
        if (process.getuid?.() === 0) await chown(target, owner.uid, owner.gid);
      }
      await writeFile(join(staging, '.magnus-mcp.json'), JSON.stringify({ sha256: component.sha256, revision: component.revision }), { mode: 0o600 });
      if (process.getuid?.() === 0) { await chown(join(staging, '.magnus-mcp.json'), owner.uid, owner.gid); await chown(staging, owner.uid, owner.gid); }
      await rename(staging, revisionDir);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  const next = `revisions/${name}`;
  if (previous === next) {
    const check = await fetch(probe, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
    if (!check?.ok) throw new Error('Installed MCP backend failed its enrolled health probe');
    await report(component, 'applied'); return;
  }
  const candidate = join(root, `.next-${randomUUID()}`);
  await symlink(next, candidate);
  try {
    await rename(candidate, current);
    await runAsOwner('/usr/bin/systemctl', home, ['--user', 'restart', unit], 2 * 60_000);
    let healthy = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const check = await fetch(probe, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
      if (check?.ok) { healthy = true; break; }
      await new Promise(done => setTimeout(done, 2_000));
    }
    if (!healthy) throw new Error('MCP backend failed its enrolled health probe');
    await report(component, 'applied');
  } catch (error) {
    const rollback = join(root, `.rollback-${randomUUID()}`);
    await symlink(previous, rollback);
    await rename(rollback, current);
    await runAsOwner('/usr/bin/systemctl', home, ['--user', 'restart', unit], 2 * 60_000);
    throw error;
  } finally { await rm(candidate, { force: true }); }
}

type CoreSlot = { allowed: boolean; status: string; commit: string; bootstrapScriptSha256: string; hermesHome: string; hermesBin: string };
type CoreEvidence = { beforeVersion?: string; afterVersion?: string; beforeGatewayActive?: boolean; afterGatewayActive?: boolean;
  backupSha256?: string; nativeReceiptSha256?: string; toolCheck?: boolean; pluginCheck?: boolean; error?: string };

async function toolsSummary(bin: string, home: string): Promise<string> {
  // Hermes renders this command through a TTY even when --summary is used.
  if (!(isAbsolute(bin) && /^\/(?:home|usr|opt)\/[a-zA-Z0-9_./-]+$/.test(bin)))
    throw new Error('Unsafe Hermes binary path for tool inventory');
  const output = await runAsOwner('/usr/bin/script', home, ['-q', '-e', '-c', `${bin} tools --summary`, '/dev/null']);
  const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '');
  if (!clean.includes('Tool Summary') || !clean.includes('✓')) throw new Error('Hermes tool inventory was unavailable');
  return clean;
}

export function parseToolSurface(summary: string): Array<{ platform: string; enabled: string[] }> {
  const surfaces: Array<{ platform: string; enabled: string[] }> = [];
  for (const line of summary.split('\n')) {
    const heading = line.match(/^  (.+?)\s+\(\d+\/\d+\)/);
    if (heading) {
      surfaces.push({ platform: heading[1]!.replace(/^[^A-Za-z0-9]+/u, '').trim().toLowerCase(), enabled: [] });
      continue;
    }
    const tool = line.trim().match(/^✓\s+(.+)$/);
    if (tool && surfaces.length) surfaces[surfaces.length - 1]!.enabled.push(tool[1]!.trim());
  }
  if (!surfaces.length || surfaces.every(surface => !surface.enabled.length)) throw new Error('Hermes tool summary has no enabled tools');
  return surfaces;
}

async function coreUpdate(): Promise<void> {
  const slot = await request<CoreSlot>('/core/slot', 'POST', {});
  if (!slot.allowed) return;
  const evidence: CoreEvidence = {};
  try {
    const home = profileHome(slot.hermesHome);
    const bin = slot.hermesBin;
    if (!/^[a-f0-9]{40}$/.test(slot.commit) || !/^[a-f0-9]{64}$/.test(slot.bootstrapScriptSha256))
      throw new Error('Invalid core release identity');
    const checkout = join(home, 'hermes-agent');
    const current = (await runAsOwner('/usr/bin/git', home, ['-C', checkout, 'rev-parse', 'HEAD'])).trim();
    evidence.beforeVersion = (await runHermes(bin, home, ['--version'])).trim().slice(0, 100);
    const gatewayBefore = await runHermes(bin, home, ['gateway', 'status']);
    evidence.beforeGatewayActive = /active|running/i.test(gatewayBefore) && !/inactive|not active|not running|stopped|dead/i.test(gatewayBefore);
    const pluginsBefore = await runHermes(bin, home, ['plugins', 'list', '--json']);
    const toolsBefore = await toolsSummary(bin, home);
    if (current === slot.commit) {
      // A prior tick may have completed the update before its receipt reached Magnus.
      const receiptBytes = await readFile(join(home, 'logs/update_receipts/latest.json'));
      const receipt = JSON.parse(receiptBytes.toString('utf8')) as { outcome?: string; post_update?: { sha?: string } };
      if (receipt.outcome !== 'success' || receipt.post_update?.sha !== slot.commit)
        throw new Error('Installed core has no matching native update receipt');
      evidence.nativeReceiptSha256 = digest(receiptBytes);
    } else {
      const help = await runHermes(bin, home, ['update', '--help']);
      if (!help.includes('--plan')) throw new Error('Hermes updater lacks the read-only fleet plan');
      await runHermes(bin, home, ['update', '--plan'], 2 * 60_000);
      const backupDir = join(home, 'backups');
      await mkdir(backupDir, { recursive: true });
      const backup = join(backupDir, `magnus-pre-core-${slot.commit}.zip`);
      await runHermes(bin, home, ['backup', '-o', backup], 30 * 60_000);
      evidence.backupSha256 = await digestFile(backup);
      if (!help.includes('--channel')) {
        // Older source installs predate stable channels. Bootstrap the exact
        // published commit after the full backup, then use its native updater.
        const scriptUrl = `https://raw.githubusercontent.com/NousResearch/hermes-agent/${slot.commit}/scripts/install.sh`;
        const response = await fetch(scriptUrl, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error('Pinned Hermes bootstrap download failed');
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 200_000 || digest(bytes) !== slot.bootstrapScriptSha256)
          throw new Error('Hermes bootstrap digest mismatch');
        const tempDir = await mkdtemp(join(tmpdir(), 'magnus-hermes-bootstrap-'));
        try {
          const script = join(tempDir, 'install.sh');
          await writeFile(script, bytes, { mode: 0o600 });
          await chmod(script, 0o644);
          const owner = await stat(home);
          await chown(tempDir, owner.uid, owner.gid);
          await chown(script, owner.uid, owner.gid);
          await runAsOwner('/usr/bin/bash', home, [script, '--commit', slot.commit, '--non-interactive', '--skip-setup', '--hermes-home', home,
            '--dir', checkout], 90 * 60_000);
        } finally { await rm(tempDir, { recursive: true, force: true }); }
      }
      const updatedHelp = await runHermes(bin, home, ['update', '--help']);
      if (!updatedHelp.includes('--channel') || !updatedHelp.includes('--backup'))
        throw new Error('Updated Hermes lacks stable-channel backup support');
      await runHermes(bin, home, ['update', '--channel', 'stable', '--plan'], 2 * 60_000);
      await runHermes(bin, home, ['update', '--channel', 'stable', '--backup', '--yes'], 110 * 60_000);
      const head = (await runAsOwner('/usr/bin/git', home, ['-C', checkout, 'rev-parse', 'HEAD'])).trim();
      if (head !== slot.commit) throw new Error('Stable channel moved beyond the admitted rollout commit');
      const receiptBytes = await readFile(join(home, 'logs/update_receipts/latest.json'));
      const receipt = JSON.parse(receiptBytes.toString('utf8')) as { outcome?: string; post_update?: { sha?: string }; fleet?: Array<{ state?: string }> };
      if (receipt.outcome !== 'success' || receipt.post_update?.sha !== slot.commit
        || receipt.fleet?.some(row => row.state !== 'current')) throw new Error('Native update receipt or gateway fleet check failed');
      evidence.nativeReceiptSha256 = digest(receiptBytes);
    }
    evidence.afterVersion = (await runHermes(bin, home, ['--version'])).trim().slice(0, 100);
    const gatewayAfter = await runHermes(bin, home, ['gateway', 'status']);
    evidence.afterGatewayActive = /active|running/i.test(gatewayAfter) && !/inactive|not active|not running|stopped|dead/i.test(gatewayAfter);
    const pluginsAfter = await runHermes(bin, home, ['plugins', 'list', '--json']);
    const before = JSON.parse(pluginsBefore) as Array<{ name?: string; status?: string }>;
    const after = JSON.parse(pluginsAfter) as Array<{ name?: string; status?: string }>;
    const enabled = before.filter(row => pluginEnabled(row.status)).map(row => row.name);
    evidence.pluginCheck = enabled.every(name => after.some(row => row.name === name && pluginEnabled(row.status)));
    const toolsAfter = await toolsSummary(bin, home);
    const enabledTools = toolsBefore.split('\n').map(row => row.trim()).filter(row => row.startsWith('✓'));
    evidence.toolCheck = enabledTools.length > 0 && enabledTools.every(row => toolsAfter.includes(row));
    if (evidence.afterGatewayActive && !evidence.beforeGatewayActive) throw new Error('Updater started an inactive gateway');
    if (!evidence.pluginCheck || !evidence.toolCheck) throw new Error('Previously enabled plugin or tool surface changed');
    await request('/core/receipts', 'POST', { commit: slot.commit, status: 'applied', evidence });
  } catch (error) {
    evidence.error = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    await request('/core/receipts', 'POST', { commit: slot.commit, status: 'failed', evidence });
    throw new Error(`Core update failed: ${evidence.error}`);
  }
}

async function applyToolsetPolicies(): Promise<void> {
  type Policy = { id: string; profileHome: string; hermesBin: string; toolset: string; enabled: boolean; platforms: string[];
    approvalMode: string; perToolHooks: unknown; allowList: unknown; denyList: unknown };
  const { policies } = await request<{ policies: Policy[] }>('/policy');
  for (const policy of policies) {
    let status: 'applied' | 'failed' | 'unsupported' = 'applied';
    let error = '';
    try {
      const home = profileHome(policy.profileHome);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:+-]*$/.test(policy.toolset) || policy.toolset.includes('..'))
        throw new Error('Unsafe toolset name');
      if (policy.approvalMode !== 'auto' || !Array.isArray(policy.perToolHooks) || policy.perToolHooks.length
        || !Array.isArray(policy.allowList) || policy.allowList.length || !Array.isArray(policy.denyList) || policy.denyList.length) {
        status = 'unsupported'; error = 'Native CLI cannot reconcile this approval, hook, or list policy noninteractively';
      } else {
        for (const platform of policy.platforms) {
          if (!safeSlug(platform)) throw new Error('Unsafe tool platform');
          if (policy.toolset.includes(':')) {
            if (!/^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(policy.toolset)) throw new Error('Unsafe MCP tool identity');
            const [server, tool] = policy.toolset.split(':');
            const listed = await runHermes(policy.hermesBin, home, ['tools', 'list', '--platform', platform]);
            if (!listed.includes(`${server}  `)) throw new Error('MCP server is not configured on this profile');
            let included: unknown = null;
            try { included = JSON.parse(await runHermes(policy.hermesBin, home, ['config', 'get', `mcp_servers.${server}.tools.include`, '--json'])); }
            catch { /* absent include filter */ }
            if (Array.isArray(included)) throw new Error('MCP include-only policy needs interactive reconciliation');
            await runHermes(policy.hermesBin, home, ['tools', policy.enabled ? 'enable' : 'disable', policy.toolset, '--platform', platform]);
            let excluded: unknown = null;
            try { excluded = JSON.parse(await runHermes(policy.hermesBin, home, ['config', 'get', `mcp_servers.${server}.tools.exclude`, '--json'])); }
            catch { /* absent exclude filter means all tools are enabled */ }
            if ((Array.isArray(excluded) && excluded.includes(tool)) === policy.enabled)
              throw new Error('Hermes MCP tool policy did not take effect');
            continue;
          }
          const args = ['tools', 'list', '--platform', platform];
          const before = await runHermes(policy.hermesBin, home, args);
          const row = before.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').split('\n')
            .find(line => new RegExp(`^\\s*[✓✗]\\s+(?:enabled|disabled)\\s+${policy.toolset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`).test(line));
          if (!row) throw new Error('Hermes did not list the assigned toolset or MCP tool');
          if (row.includes(policy.enabled ? '✗ disabled' : '✓ enabled'))
            await runHermes(policy.hermesBin, home, ['tools', policy.enabled ? 'enable' : 'disable', policy.toolset, '--platform', platform]);
          const after = await runHermes(policy.hermesBin, home, args);
          const expected = policy.enabled ? '✓ enabled' : '✗ disabled';
          if (!after.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').split('\n').some(line => line.includes(expected) && line.includes(`  ${policy.toolset}  `)))
            throw new Error('Hermes tool policy did not take effect');
        }
      }
    } catch (failure) { status = 'failed'; error = failure instanceof Error ? failure.message : String(failure); }
    await request('/policy/receipts', 'POST', { id: policy.id, status, ...(error ? { error: error.slice(0, 500) } : {}) });
  }
}

async function main(): Promise<void> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new Error('HERMES_REGISTRY_TOKEN is required');
  if (!submitOnly && !pullEnabled) throw new Error('Registry pulls are disabled; set MAGNUS_HERMES_SYNC_PULL=true or use --submit-only');
  const backoffPath = '/run/magnus-hermes-sync-backoff.json';
  let previous: { failures: number; nextAt: number } = { failures: 0, nextAt: 0 };
  try { previous = JSON.parse(await readFile(backoffPath, 'utf8')) as typeof previous; } catch { /* first run */ }
  if (Number.isFinite(previous.nextAt) && previous.nextAt > Date.now()) return;
  try {
    const captured = await captureProfiles();
    if (submitOnly) return; // Submit-only hosts never request desired state or artifacts.
    const manifest = await request<{ components: Component[] }>('/manifest');
    for (const component of manifest.components) {
      try {
        if (captured.has(`${component.profileId}:${component.slug}`)) { await report(component, 'drifted', 'Local edit captured; waiting for new manifest'); continue; }
        if (component.kind === 'skill') await applySkill(component);
        else if (component.kind === 'plugin') await applyPlugin(component);
        else await applyMcp(component);
      } catch (error) {
        await report(component, 'failed', error instanceof Error ? error.message : 'Unknown failure');
      }
    }
    await coreUpdate();
    await applyToolsetPolicies();
    await rm(backoffPath, { force: true });
  } catch (error) {
    const failures = Math.min(6, (Number.isInteger(previous.failures) ? previous.failures : 0) + 1);
    await writeFile(backoffPath, JSON.stringify({ failures, nextAt: Date.now() + 5 * 60_000 * 2 ** (failures - 1) }), { mode: 0o600 });
    throw error;
  }
}

if (invokedAsService)
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
