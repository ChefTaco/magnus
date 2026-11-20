// What this server install actually resolved, compared with the lock it shipped with.
//
// The published package carries npm-shrinkwrap.json: the exact dependency graph its image and its
// npm install use. A consumer install can still end up elsewhere (a consumer override, a manual
// `npm install`, an older tarball without a shrinkwrap), so the server checks where Node would load
// each locked package from and reads the version it finds there. Read-only: it never runs npm.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTROL_API_VERSION } from '../config/version.js';

export const SHRINKWRAP = 'npm-shrinkwrap.json';
/** At most this many differences are reported; `truncated` says when more were found. */
export const MAX_DIFFERENCES = 200;
const RECHECK_MS = 60_000;

export interface ResolutionDifference {
  name: string;
  /** The package's path in the shrinkwrap, such as node_modules/@prisma/config/node_modules/effect. */
  path: string;
  expected: string;
  /** The version Node would load, or null when the package is not installed where Node looks. */
  actual: string | null;
}

export interface ResolutionReport {
  reference: 'npm-shrinkwrap' | 'none';
  referenceSha256: string | null;
  checkedAt: string;
  checked: number;
  differences: ResolutionDifference[];
  truncated: boolean;
}

export interface InstallationReport {
  schema: 1;
  magnus: { version: string; node: string; layout: 'package' | 'workspace' };
  resolution: ResolutionReport;
}

interface LockEntry {
  version?: unknown;
  name?: unknown;
  dev?: unknown;
  optional?: unknown;
  devOptional?: unknown;
  peer?: unknown;
  link?: unknown;
}

/** `node_modules/a/node_modules/@s/b` → `@s/b`. */
export function lockEntryName(path: string): string {
  const index = path.lastIndexOf('node_modules/');
  return path.slice(index + 'node_modules/'.length);
}

/** `node_modules/a/node_modules/@s/b` → `node_modules/a`; a top-level entry has the package root ('') as parent. */
export function lockEntryParent(path: string): string {
  return path.replace(/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+$/u, '');
}

function readVersion(directory: string): string | null {
  try {
    const version = (JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/** Where Node finds `name` when a module in `from` requires it: each ancestor's node_modules, nearest first. */
export function findPackage(from: string, name: string): string | null {
  let directory = from;
  for (;;) {
    if (basename(directory) !== 'node_modules') {
      const candidate = join(directory, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json'))) {
        try { return realpathSync(candidate); } catch { return candidate; }
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/**
 * Compares every runtime entry of `lock` with what is installed around `packageRoot`. Development
 * entries are skipped (a production install omits them), and so are absent optional ones (another
 * platform's binaries, an optional peer).
 */
export function compareResolution(packageRoot: string, lock: { packages?: Record<string, LockEntry> }):
  { checked: number; differences: ResolutionDifference[]; truncated: boolean } {
  const packages = lock.packages ?? {};
  const located = new Map<string, string | null>([['', packageRoot]]);
  const locate = (path: string): string | null => {
    if (located.has(path)) return located.get(path)!;
    const parent = locate(lockEntryParent(path));
    const found = parent === null ? null : findPackage(parent, lockEntryName(path));
    located.set(path, found);
    return found;
  };
  const differences: ResolutionDifference[] = [];
  let checked = 0, found = 0;
  for (const path of Object.keys(packages).sort()) {
    const entry = packages[path]!;
    if (!path || entry.dev === true || entry.link === true || typeof entry.version !== 'string') continue;
    const directory = locate(path);
    const actual = directory === null ? null : readVersion(directory);
    if (actual === null && (entry.optional === true || entry.devOptional === true || entry.peer === true)) continue;
    checked += 1;
    if (actual === entry.version) continue;
    found += 1;
    if (differences.length < MAX_DIFFERENCES)
      differences.push({ name: typeof entry.name === 'string' ? entry.name : lockEntryName(path), path, expected: entry.version, actual });
  }
  return { checked, differences, truncated: found > differences.length };
}

/** `package` when the server package sits in a node_modules directory (an npm install), else a workspace or image build. */
export function installLayout(packageRoot: string): 'package' | 'workspace' {
  return resolve(packageRoot).split(sep).includes('node_modules') ? 'package' : 'workspace';
}

export function buildInstallationReport(packageRoot: string, now = new Date()): InstallationReport {
  const layout = installLayout(packageRoot);
  const magnus = { version: CONTROL_API_VERSION, node: process.version, layout };
  const base = { checkedAt: now.toISOString(), checked: 0, differences: [], truncated: false };
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(packageRoot, SHRINKWRAP));
  } catch {
    return { schema: 1, magnus, resolution: { reference: 'none', referenceSha256: null, ...base } };
  }
  const referenceSha256 = createHash('sha256').update(bytes).digest('hex');
  let lock: { packages?: Record<string, LockEntry> };
  try {
    lock = JSON.parse(bytes.toString('utf8')) as typeof lock;
  } catch {
    // A shrinkwrap that cannot be read pins nothing: report it as present but unchecked.
    return { schema: 1, magnus, resolution: { reference: 'npm-shrinkwrap', referenceSha256, ...base } };
  }
  return { schema: 1, magnus, resolution: { reference: 'npm-shrinkwrap', referenceSha256, checkedAt: base.checkedAt, ...compareResolution(packageRoot, lock) } };
}

/** This server's package root: services/control-api in a checkout, node_modules/@hivemagnus/magnus-server once installed. */
export const SERVER_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

let cached: { at: number; report: InstallationReport } | undefined;

/** The report for this process, recomputed at most once a minute. */
export function installationReport(now = Date.now()): InstallationReport {
  if (!cached || now - cached.at >= RECHECK_MS) cached = { at: now, report: buildInstallationReport(SERVER_PACKAGE_ROOT, new Date(now)) };
  return cached.report;
}

export function resetInstallationReportCache(): void {
  cached = undefined;
}
