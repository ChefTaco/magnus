/** Software metadata only: never execute discovered binaries, a shell, or package update hooks. */
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AGENT_VERSION } from '../version.js';

const PACKAGES = ['python3', 'redis-tools', 'redis-server', 'docker-ce', 'docker.io', 'tailscale'] as const;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+:~_-]{0,127}$/;
const version = (value: unknown): string | null => typeof value === 'string' && VERSION.test(value) ? value : null;

export function parseSoftwarePackages(output: string): Map<string, string> {
  const installed = new Map<string, string>();
  for (const line of output.split('\n')) {
    const [name, raw, status] = line.split('\t');
    const value = version(raw);
    if (name && PACKAGES.some(candidate => candidate === name) && status === 'installed' && value) installed.set(name, value);
  }
  return installed;
}

async function installedPackages(): Promise<Map<string, string>> {
  return new Promise(resolveResult => {
    execFile('/usr/bin/dpkg-query', ['-W', '-f=${Package}\t${Version}\t${db:Status-Status}\n', ...PACKAGES],
      { encoding: 'utf8', timeout: 3000, maxBuffer: 16 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C' } },
      (error, stdout) => {
        // dpkg returns 1 when only some requested packages exist; their metadata is still usable.
        resolveResult(parseSoftwarePackages(!error || error.code === 1 ? stdout : ''));
      });
  });
}

async function npmVersion(): Promise<string | null> {
  const candidates = [...new Set([resolve(dirname(process.execPath), '../lib/node_modules/npm/package.json'),
    '/usr/lib/node_modules/npm/package.json', '/usr/share/nodejs/npm/package.json'])];
  for (const path of candidates) {
    try {
      const metadata = JSON.parse(await readFile(path, 'utf8')) as { version?: unknown };
      const found = version(metadata.version);
      if (found) return found;
    } catch { /* Missing or unreadable metadata is reported as unavailable, never executed. */ }
  }
  return null;
}

async function packageUpdates() {
  const cacheRefreshedAt = await stat('/var/lib/apt/periodic/update-success-stamp')
    .then(value => value.mtime.toISOString(), () => null);
  return new Promise<{ supported: boolean; pending: number | null; source: 'local-package-cache'; cacheRefreshedAt: string | null }>(resolveResult => {
    execFile('/usr/bin/apt', ['list', '--upgradable', '-o', 'Dir::Cache::pkgcache=', '-o', 'Dir::Cache::srcpkgcache='],
      { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C' } },
      (error, stdout) => resolveResult({ supported: error?.code !== 'ENOENT',
        pending: error ? null : stdout.split('\n').filter(line => /^\S+\/\S+\s+\S+\s+\S+/.test(line)).length,
        source: 'local-package-cache', cacheRefreshedAt }));
  });
}

export async function collectSoftwareStatus() {
  const [packages, npm, updates] = await Promise.all([installedPackages(), npmVersion(), packageUpdates()]);
  return { checkedAt: new Date().toISOString(), versions: {
    node: process.version, npm, python3: packages.get('python3') ?? null,
    redis: packages.get('redis-tools') ?? packages.get('redis-server') ?? null,
    docker: packages.get('docker-ce') ?? packages.get('docker.io') ?? null,
    tailscale: packages.get('tailscale') ?? null, 'magnus-agent': AGENT_VERSION,
  }, packageUpdates: updates };
}
