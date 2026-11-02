import { z } from 'zod';

// Release metadata shared by the upgrade tooling (`@hivemagnus/magnus`), the
// server's update check and the node agent's self-upgrade. Only plain
// `X.Y.Z[-pre]` versions and `^`/exact/`||` ranges are supported, which is all
// Magnus itself publishes or declares.

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export function parseVersion(version: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(version.trim().replace(/^v/, ''));
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

export function isVersion(version: string): boolean {
  return parseVersion(version) !== null;
}

function requireVersion(version: string): ParsedVersion {
  const parsed = parseVersion(version);
  if (!parsed) throw new Error(`Not a release version: ${version}`);
  return parsed;
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : a.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]) ? Number(a[i]) : null;
    const bn = /^\d+$/.test(b[i]) ? Number(b[i]) : null;
    if (an !== null && bn !== null) {
      if (an !== bn) return an < bn ? -1 : 1;
    } else if (an !== null || bn !== null) {
      return an !== null ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

/** Returns -1, 0 or 1. Throws on anything that is not `X.Y.Z[-pre]`. */
export function compareVersions(a: string, b: string): number {
  const left = requireVersion(a);
  const right = requireVersion(b);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** Supports `^X.Y.Z`, `X.Y.Z` and `||` unions, the forms Magnus declares in `engines`. */
export function satisfiesRange(version: string, range: string): boolean {
  const candidate = parseVersion(version);
  if (!candidate) return false;
  return range.split('||').map((part) => part.trim()).some((part) => {
    if (part === '*' || part === '') return true;
    const caret = part.startsWith('^');
    const floor = parseVersion(caret ? part.slice(1) : part);
    if (!floor) return false;
    if (!caret) return compareVersions(version, part) === 0;
    if (compareVersions(version, part.slice(1)) < 0) return false;
    if (candidate.prerelease.length > 0) return false;
    if (floor.major > 0) return candidate.major === floor.major;
    if (floor.minor > 0) return candidate.major === 0 && candidate.minor === floor.minor;
    return candidate.major === 0 && candidate.minor === 0 && candidate.patch === floor.patch;
  });
}

export type UpgradeKind = 'same' | 'patch' | 'minor' | 'major' | 'downgrade';

export function classifyUpgrade(from: string, to: string): UpgradeKind {
  const order = compareVersions(from, to);
  if (order === 0) return 'same';
  if (order > 0) return 'downgrade';
  const a = requireVersion(from);
  const b = requireVersion(to);
  if (a.major !== b.major) return 'major';
  if (a.minor !== b.minor) return 'minor';
  return 'patch';
}

export interface UpgradeDecision {
  allowed: boolean;
  kind: UpgradeKind;
  reason?: string;
}

/**
 * The one rule every automatic path shares: never downgrade (that is a
 * rollback) and never cross a major version unless an operator asked for it.
 */
export function checkUpgradeAllowed(from: string, to: string, options: { allowMajor?: boolean } = {}): UpgradeDecision {
  const kind = classifyUpgrade(from, to);
  if (kind === 'downgrade') return { allowed: false, kind, reason: `${to} is older than ${from}; use rollback instead` };
  if (kind === 'major' && !options.allowMajor) {
    return { allowed: false, kind, reason: `${from} -> ${to} crosses a major version; pass --allow-major after reading UPGRADING.md` };
  }
  return { allowed: true, kind };
}

/** Highest version in `versions` that is newer than `current`, optionally limited to its major. */
export function latestVersion(versions: Iterable<string>, options: { sameMajorAs?: string; includePrerelease?: boolean } = {}): string | null {
  const major = options.sameMajorAs ? requireVersion(options.sameMajorAs).major : null;
  let best: string | null = null;
  for (const version of versions) {
    const parsed = parseVersion(version);
    if (!parsed) continue;
    if (!options.includePrerelease && parsed.prerelease.length > 0) continue;
    if (major !== null && parsed.major !== major) continue;
    if (best === null || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

const versionString = z.string().refine(isVersion, 'must be an X.Y.Z version');

export const releaseEnvChangeSchema = z.object({
  name: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  component: z.enum(['server', 'ui', 'agent', 'ardent']),
  secret: z.boolean().default(false),
  description: z.string().min(1),
});

export const migrationImpactSchema = z.enum(['fast', 'slow', 'one-way']);

export const releaseMigrationSchema = z.object({
  name: z.string().min(1),
  // An impact a newer release introduces is treated as the most cautious one.
  impact: migrationImpactSchema.catch('one-way'),
  note: z.string().default(''),
});

export const releaseManifestSchema = z.object({
  schema: z.literal(1),
  version: versionString,
  releasedAt: z.string().optional(),
  engines: z.object({ node: z.string().min(1) }),
  components: z.record(z.string(), versionString),
  breaking: z.boolean().default(false),
  minUpgradeFrom: versionString.optional(),
  engineProtocol: z.number().int().positive(),
  newRequiredEnv: z.array(releaseEnvChangeSchema).default([]),
  newOptionalEnv: z.array(releaseEnvChangeSchema).default([]),
  removedEnv: z.array(z.object({ name: z.string(), component: z.string(), note: z.string().default('') })).default([]),
  migrations: z.array(releaseMigrationSchema).default([]),
  agent: z.object({ selfUpgradeProtocol: z.number().int().nonnegative(), minLauncher: z.number().int().nonnegative() }),
  summary: z.string().default(''),
  notesUrl: z.string().url().optional(),
  /** npm install scripts the release's dependency tree needs (`allowScripts` of the version install). */
  allowScripts: z.record(z.string(), z.boolean()).optional(),
});
// Unknown extra fields are stripped, not rejected, so older engines keep
// reading manifests that newer releases extend.

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;
export type ReleaseEnvChange = z.infer<typeof releaseEnvChangeSchema>;
export type ReleaseMigration = z.infer<typeof releaseMigrationSchema>;
export type MigrationImpact = z.infer<typeof migrationImpactSchema>;

export interface UpgradePath {
  from: string;
  to: string;
  releases: ReleaseManifest[];
  breaking: boolean;
  newRequiredEnv: ReleaseEnvChange[];
  newOptionalEnv: ReleaseEnvChange[];
  removedEnv: ReleaseManifest['removedEnv'];
  migrations: Array<ReleaseMigration & { version: string }>;
  /** Migrations an operator must confirm: slow or impossible to undo without a restore. */
  attention: Array<ReleaseMigration & { version: string }>;
  blockedBy?: string;
}

/**
 * Merges the manifests of every release in (from, to]. Env names added and
 * later removed inside the range are dropped. A release whose
 * `minUpgradeFrom` is newer than `from` blocks the path.
 */
export function summarizeUpgradePath(manifests: Iterable<ReleaseManifest>, from: string, to: string): UpgradePath {
  const releases = [...manifests]
    .filter((m) => compareVersions(m.version, from) > 0 && compareVersions(m.version, to) <= 0)
    .sort((a, b) => compareVersions(a.version, b.version));
  const required = new Map<string, ReleaseEnvChange>();
  const optional = new Map<string, ReleaseEnvChange>();
  const removed: ReleaseManifest['removedEnv'] = [];
  const migrations: UpgradePath['migrations'] = [];
  let blockedBy: string | undefined;
  for (const release of releases) {
    if (release.minUpgradeFrom && compareVersions(from, release.minUpgradeFrom) < 0 && !blockedBy) {
      blockedBy = `${release.version} requires upgrading from ${release.minUpgradeFrom} or later first`;
    }
    for (const env of release.newRequiredEnv) required.set(env.name, env);
    for (const env of release.newOptionalEnv) optional.set(env.name, env);
    for (const env of release.removedEnv) {
      required.delete(env.name);
      optional.delete(env.name);
      removed.push(env);
    }
    for (const migration of release.migrations) migrations.push({ ...migration, version: release.version });
  }
  return {
    from,
    to,
    releases,
    breaking: releases.some((r) => r.breaking),
    newRequiredEnv: [...required.values()],
    newOptionalEnv: [...optional.values()],
    removedEnv: removed,
    migrations,
    attention: migrations.filter((m) => m.impact !== 'fast'),
    ...(blockedBy ? { blockedBy } : {}),
  };
}

export interface PackumentReleases {
  manifests: ReleaseManifest[];
  /** Versions that carry a `magnusRelease` this code cannot parse (a newer schema). */
  unparsable: string[];
  /** Versions npm marks deprecated. */
  deprecated: string[];
  /** `dist-tags.latest`, when present. */
  latest: string | null;
}

/** Reads the manifests embedded as `magnusRelease` in a full npm packument. */
export function readPackument(packument: unknown): PackumentReleases {
  const doc = packument as { versions?: Record<string, { magnusRelease?: unknown; deprecated?: unknown }>; 'dist-tags'?: Record<string, unknown> } | null;
  const result: PackumentReleases = { manifests: [], unparsable: [], deprecated: [], latest: null };
  for (const [version, entry] of Object.entries(doc?.versions ?? {})) {
    if (typeof entry?.deprecated === 'string' && entry.deprecated) result.deprecated.push(version);
    if (entry?.magnusRelease === undefined) continue;
    const parsed = releaseManifestSchema.safeParse(entry.magnusRelease);
    if (parsed.success) result.manifests.push(parsed.data);
    else result.unparsable.push(version);
  }
  const latest = doc?.['dist-tags']?.['latest'];
  if (typeof latest === 'string' && isVersion(latest)) result.latest = latest;
  return result;
}

export function manifestsFromPackument(packument: unknown): ReleaseManifest[] {
  return readPackument(packument).manifests;
}

// Agent self-upgrade wire contract.

export const AGENT_SELF_UPGRADE_PROTOCOL = 1;

export const agentUpgradeStateSchema = z.enum(['idle', 'staged', 'trial', 'confirmed', 'reverted', 'failed']);

export const agentUpgradeReportSchema = z.object({
  state: agentUpgradeStateSchema,
  from: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
  requestId: z.string().max(128).nullable().optional(),
  reason: z.string().max(500).nullable().optional(),
  attempt: z.number().int().nonnegative().optional(),
  updatedAt: z.string().optional(),
});

export const agentSelfUpgradeStatusSchema = z.object({
  protocol: z.number().int().nonnegative(),
  launcherProtocol: z.number().int().nonnegative().nullable(),
  layout: z.enum(['versioned', 'legacy', 'container']),
  enabled: z.boolean(),
  reason: z.string().max(300).nullable().optional(),
  upgrade: agentUpgradeReportSchema.nullable().optional(),
});

export const agentUpgradeRequestSchema = z.object({
  version: versionString,
  integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/),
  requestId: z.string().min(1).max(128),
  packageName: z.string().default('@hivemagnus/magnus-agent'),
});

export type AgentUpgradeState = z.infer<typeof agentUpgradeStateSchema>;
export type AgentUpgradeReport = z.infer<typeof agentUpgradeReportSchema>;
export type AgentSelfUpgradeStatus = z.infer<typeof agentSelfUpgradeStatusSchema>;
export type AgentUpgradeRequest = z.infer<typeof agentUpgradeRequestSchema>;

// Database restore. A dump is restored into an empty `public` schema so that
// tables a newer release created do not survive next to the restored ones:
// the live schema is renamed aside, a new one with the same owner and grants
// takes its place, `pg_restore --single-transaction` fills it, and the old
// schema is dropped only after the restore committed (or renamed back if it
// failed). Each step is one transaction.

/** Name for the schema kept aside during a restore. */
export function restoreAsideSchema(now: Date): string {
  return `magnus_pre_restore_${now.toISOString().replace(/\D/g, '').slice(0, 14)}`;
}

/** Moves `public` aside and recreates it with the same owner and privileges. */
export function restoreSwapSql(aside: string): string {
  return `DO $magnus$ DECLARE owner_name text; grant_row record; BEGIN
  SELECT pg_get_userbyid(nspowner) INTO owner_name FROM pg_namespace WHERE nspname = 'public';
  IF owner_name IS NULL THEN RAISE EXCEPTION 'schema public does not exist'; END IF;
  EXECUTE format('ALTER SCHEMA public RENAME TO %I', '${aside}');
  EXECUTE format('CREATE SCHEMA public AUTHORIZATION %I', owner_name);
  FOR grant_row IN SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END AS grantee, a.privilege_type
    FROM pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspname = '${aside}' LOOP
    EXECUTE format('GRANT %s ON SCHEMA public TO %s', grant_row.privilege_type, grant_row.grantee);
  END LOOP;
END $magnus$;`;
}

/** After a failed restore: drop the partial schema and put the original back. */
export function restoreRevertSql(aside: string): string {
  return `BEGIN; DROP SCHEMA public CASCADE; ALTER SCHEMA "${aside}" RENAME TO public; COMMIT;`;
}

/** After a successful restore: drop the schema kept aside. */
export function restoreFinishSql(aside: string): string {
  return `DROP SCHEMA "${aside}" CASCADE;`;
}
