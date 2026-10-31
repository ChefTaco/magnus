import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { getDb } from '../db/index.js';
import { publishRevision } from './hermes-registry-service.js';

const exec = promisify(execFile);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const gitBlob = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

function githubSource(url: string): { owner: string; repo: string; canonical: string } {
  const match = url.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!match || match[1]!.includes('..') || match[2]!.includes('..')) throw new Error('Plugin source requires an exact GitHub repository URL');
  return { owner: match[1]!, repo: match[2]!, canonical: `https://github.com/${match[1]}/${match[2]}` };
}

async function sourceHead(url: string): Promise<string> {
  const { stdout } = await exec('git', ['ls-remote', url, 'HEAD'], { timeout: 20_000, maxBuffer: 4096,
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' } });
  const commit = stdout.split(/\s+/)[0];
  if (!commit || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Plugin Git HEAD is unavailable');
  return commit;
}

async function sourceFiles(owner: string, repo: string, commit: string, requirePluginManifest: boolean) {
  const tree = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${commit}?recursive=1`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'magnus-hermes-registry' }, signal: AbortSignal.timeout(20_000) });
  if (!tree.ok) throw new Error(`Plugin source tree failed (${tree.status})`);
  if (Number(tree.headers.get('content-length') ?? 0) > 4 * 1024 * 1024) throw new Error('Plugin source tree response exceeds admission bounds');
  const document = await tree.json() as { truncated?: boolean; tree?: Array<{ path?: string; type?: string; mode?: string; sha?: string; size?: number }> };
  const blobs = (document.tree ?? []).filter(item => item.type === 'blob');
  if (document.truncated || blobs.length > 256 || !blobs.length || requirePluginManifest && !blobs.some(item => item.path === 'plugin.yaml'))
    throw new Error('Extension source exceeds admission bounds or lacks its required manifest');
  let total = 0;
  const files: Array<{ path: string; contentBase64: string; sha256: string; mode: 420 | 493 }> = [];
  for (const item of blobs) {
    const path = item.path ?? '';
    if (!path || path.length > 240 || path.split('/').some(part => !/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(part) || part.includes('..'))
      || item.mode !== '100644' && item.mode !== '100755' || !/^[a-f0-9]{40}$/.test(item.sha ?? '')
      || !Number.isInteger(item.size) || item.size! > 2 * 1024 * 1024) throw new Error('Unsafe plugin source tree entry');
    total += item.size!;
    if (total > 3 * 1024 * 1024) throw new Error('Plugin source tree exceeds admission size');
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Plugin source file failed (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== item.size || gitBlob(bytes) !== item.sha) throw new Error('Plugin source file differs from Git tree');
    files.push({ path, contentBase64: bytes.toString('base64'), sha256: digest(bytes), mode: item.mode === '100755' ? 493 : 420 });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function surface(files: Array<{ path: string; contentBase64: string }>) {
  const manifest = files.find(file => file.path === 'plugin.yaml');
  const parsed = YAML.parse(Buffer.from(manifest!.contentBase64, 'base64').toString('utf8'), { uniqueKeys: true }) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Plugin manifest is not a mapping');
  const capabilities = Array.isArray(parsed['capabilities']) ? parsed['capabilities'].filter((value): value is string => typeof value === 'string') : [];
  const dependencyKeys = Object.keys(parsed).filter(key => /depend|require|sidecar/i.test(key)).sort();
  const dependencies = dependencyKeys.map(key => `manifest-${digest(Buffer.from(JSON.stringify([key, parsed[key]]))).slice(0, 40)}`);
  const contract = Object.fromEntries(Object.entries(parsed).filter(([key]) => !['version', 'description', 'author', 'homepage'].includes(key)));
  dependencies.push(`manifest-contract-${digest(Buffer.from(JSON.stringify(contract))).slice(0, 40)}`);
  for (const file of files.filter(file => /(^|\/)(?:requirements[^/]*\.txt|pyproject\.toml|package\.json)$/.test(file.path)))
    dependencies.push(`file-${digest(Buffer.from(`${file.path}:${file.contentBase64}`)).slice(0, 40)}`);
  const declaredTools = new Set<string>();
  const declaredHooks = new Set<string>();
  for (const file of files.filter(file => file.path.endsWith('.py'))) {
    const source = Buffer.from(file.contentBase64, 'base64').toString('utf8');
    for (const match of source.matchAll(/register_tool\s*\(\s*(?:name\s*=\s*)?['"]([A-Za-z0-9._+-]+)['"]/g)) declaredTools.add(match[1]!);
    for (const match of source.matchAll(/register_hook\s*\(\s*['"]([A-Za-z0-9._+-]+)['"]/g)) declaredHooks.add(match[1]!);
    const toolCalls = [...source.matchAll(/register_tool\s*\(/g)].length;
    const hookCalls = [...source.matchAll(/register_hook\s*\(/g)].length;
    if (toolCalls > [...source.matchAll(/register_tool\s*\(\s*(?:name\s*=\s*)?['"]([A-Za-z0-9._+-]+)['"]/g)].length)
      declaredTools.add(`dynamic-${digest(Buffer.from(source)).slice(0, 40)}`);
    if (hookCalls > [...source.matchAll(/register_hook\s*\(\s*['"]([A-Za-z0-9._+-]+)['"]/g)].length)
      declaredHooks.add(`dynamic-${digest(Buffer.from(source)).slice(0, 40)}`);
    if (/register_(?:platform|image_gen_provider|video_gen_provider|context_engine|terminal_environment_provider|memory_provider)\s*\(/.test(source))
      declaredHooks.add(`provider-${digest(Buffer.from(source)).slice(0, 40)}`);
  }
  return { capabilities, dependencies, declaredTools: [...declaredTools].sort(), declaredHooks: [...declaredHooks].sort(),
    desktopComponent: files.some(file => /^(?:apps\/desktop|desktop)\//.test(file.path)) };
}

export async function refreshTrackedSources(): Promise<Array<{ kind: string; slug: string; status: string; commit?: string; error?: string }>> {
  if (running) return [{ kind: '*', slug: '*', status: 'busy' }];
  running = true;
  try {
    const db = getDb();
    const releases = await db.hermesRegistryRevision.findMany({ where: { kind: { in: ['plugin', 'mcp'] }, status: 'published' }, orderBy: { revision: 'desc' } });
    const latest = new Map<string, typeof releases[number]>();
    for (const release of releases) if (!latest.has(`${release.kind}:${release.slug}`)) latest.set(`${release.kind}:${release.slug}`, release);
    const results = [];
    for (const release of latest.values()) {
      try {
        const previous = JSON.parse(release.artifactJson) as { sourceUrl: string; commit: string; pluginType: string };
        const source = githubSource(previous.sourceUrl);
        const commit = await sourceHead(source.canonical);
        if (commit === previous.commit) { results.push({ kind: release.kind, slug: release.slug, status: 'current', commit }); continue; }
        const files = await sourceFiles(source.owner, source.repo, commit, release.kind === 'plugin');
        const artifact = release.kind === 'plugin'
          ? { format: 'magnus-hermes-plugin-v1', sourceUrl: source.canonical, commit, pluginType: previous.pluginType,
            ...surface(files), files }
          : { ...previous, sourceUrl: source.canonical, commit, files };
        const published = await publishRevision({ kind: release.kind as 'plugin' | 'mcp', slug: release.slug, artifact,
          publishedBy: 'system:extension-source',
          baseRevision: release.revision, metadata: { upstreamRepository: source.canonical } });
        results.push({ kind: release.kind, slug: release.slug, status: published.revision.status, commit });
      } catch (error) {
        results.push({ kind: release.kind, slug: release.slug, status: 'source-error', error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
      }
    }
    return results;
  } finally { running = false; }
}

export function startExtensionSourceMonitor(): void {
  if (timer) return;
  timer = setInterval(() => { void refreshTrackedSources().then(results => {
    for (const row of results.filter(item => item.status !== 'current'))
      console.warn(`[hermes-registry] ${row.kind} source ${row.slug}: ${row.status}${row.error ? ` (${row.error})` : ''}`);
  }).catch(error => console.error('[hermes-registry] extension source monitor failed', error)); }, 30 * 60_000);
  timer.unref();
}

export function stopExtensionSourceMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
