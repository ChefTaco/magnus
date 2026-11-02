/**
 * Server-driven agent upgrades (MAGNUS_AGENT_UPGRADES). The server pins one
 * exact version and its npm integrity, asks one canary agent to stage it,
 * waits until that agent reports the version on trial as confirmed, then
 * upgrades the rest a few at a time. A revert, a release problem or a node
 * that goes silent after the request stops the run; a node that refuses
 * before anything changed (busy, enrollment, unreachable) is recorded as
 * `refused` and the wave goes on. Agents decide for themselves whether they
 * can upgrade (MAGNUS_AGENT_SELF_UPGRADE, launcher layout) and report it with
 * every heartbeat, so the console can grey out the ones that cannot.
 *
 * Eligibility uses the same read-only predicates as resource admission
 * (admission fence, enrollment, held work and leases, fresh health), so a node
 * the console offers is one that dispatch will not refuse for those reasons.
 */
import { randomUUID } from 'node:crypto';
import {
  AGENT_SELF_UPGRADE_PROTOCOL,
  agentSelfUpgradeStatusSchema,
  checkUpgradeAllowed,
  compareVersions,
  isVersion,
  parseVersion,
  type AgentSelfUpgradeStatus,
} from '@hivemagnus/magnus-contracts';
import { upgradeSettings } from '../config/features.js';
import { AGENT_VERSION } from '../config/version.js';
import { getDb } from '../db/client.js';
import { HttpError } from '../middleware/error-handler.js';
import { AgentResponseError, DispatchOutcomeUnknownError, NodeApiClient, NotDispatchedError } from '../sdk/node-api-client.js';
import { getNodeManagerSecret } from '../utils/env.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { SENTINEL_NODE_IDS } from '../utils/sentinel-nodes.js';
import type { AuditAction } from '../types/auth.js';
import { logAuditEvent } from './audit-service.js';
import { HELD_RESOURCE_STATES, hasFreshOnlineHealth, legacyAdmissionPossible, resourceLeasesRequested } from './command-resource-leases.js';
import { enrollmentIsComplete } from './resource-enrollment.js';
import { stickyEnrollmentCause } from './resource-ownership.js';

export const AGENT_PACKAGE = '@hivemagnus/magnus-agent';
const HEARTBEAT_MS = 30_000;
/** MAGNUS_AGENT_UPGRADE_CONFIRM_SECONDS default, for agents that do not report theirs. */
const DEFAULT_CONFIRM_SECONDS = 180;
/** Restart and first heartbeat of the new version, on top of the trial window. */
const CONFIRM_MARGIN_MS = 2 * 60_000;
/** A request whose reply was lost may still be installing. */
const UNKNOWN_DISPATCH_MARGIN_MS = 10 * 60_000;
const POLL_MS = 5_000;
const RUN_TTL_SECONDS = 7 * 24 * 60 * 60;
/** The owner renews its lease every LEASE_MS / 3; a lease this old means the owner is gone. */
const LEASE_MS = 90_000;
/** Runs written by servers without leases count as abandoned after this long. */
const UNLEASED_RUN_MS = 2 * 60 * 60_000;
const MAX_LOCAL_RUNS = 20;
/** This process, as the owner of the runs it executes. */
export const INSTANCE_ID = randomUUID();

/** Agent error codes that mean the node was not touched. */
export const UNTOUCHED_CODES = new Set(['SELF_UPGRADE_BUSY', 'SELF_UPGRADE_CURRENT', 'SELF_UPGRADE_UNAVAILABLE', 'SELF_UPGRADE_PACKAGE',
  'SELF_UPGRADE_REFUSED', 'SELF_UPGRADE_LAUNCHER', 'SELF_UPGRADE_ENGINE', 'SELF_UPGRADE_TIMEOUT',
  'RESOURCE_BUSY', 'UNMANAGED_MUTATION', 'ENROLLMENT_AUTHORITY_UNAVAILABLE', 'RESOURCE_CLAIM_INVALID']);
/** Agent error codes that point at the release itself: the wave stops. */
export const RELEASE_PROBLEM_CODES = new Set(['SELF_UPGRADE_INTEGRITY', 'SELF_UPGRADE_FAILED', 'SELF_UPGRADE_SOURCE']);

// ── Heartbeat side: what each agent reports ──

export type StoredSelfUpgrade = AgentSelfUpgradeStatus & {
  nodeVersion: string | null;
  observedAt: string;
};

function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const parseWarnings = new Map<string, number>();
/**
 * Parse a self-upgrade report leniently: a malformed `upgrade` entry is
 * dropped instead of the whole report. Failures are logged (once an hour per source).
 */
export function parseSelfUpgradeStatus(value: unknown, source?: string): AgentSelfUpgradeStatus | null {
  if (value === undefined || value === null) return null;
  const parsed = agentSelfUpgradeStatusSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const partial = typeof value === 'object' && !Array.isArray(value)
    ? agentSelfUpgradeStatusSchema.safeParse({ ...value as Record<string, unknown>, upgrade: null }) : null;
  if (source && Date.now() - (parseWarnings.get(source) ?? 0) > 60 * 60_000) {
    parseWarnings.set(source, Date.now());
    console.warn(`[agent-upgrade] ${source} sent a self-upgrade report that does not parse (${parsed.error.issues.slice(0, 3)
      .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')})${partial?.success ? '; kept it without its upgrade entry' : '; ignored it'}`);
  }
  return partial?.success ? partial.data : null;
}

export function storedSelfUpgrade(metadataRaw: string | null | undefined): StoredSelfUpgrade | null {
  const value = parseMetadata(metadataRaw)['agentSelfUpgrade'];
  const parsed = parseSelfUpgradeStatus(value);
  if (!parsed) return null;
  const extra = value as { nodeVersion?: unknown; observedAt?: unknown };
  return { ...parsed, nodeVersion: typeof extra.nodeVersion === 'string' ? extra.nodeVersion : null,
    observedAt: typeof extra.observedAt === 'string' ? extra.observedAt : new Date(0).toISOString() };
}

const AGENT_STATUSES = new Set(['RUNNING', 'STOPPED', 'ERROR']);
type AgentStatusValue = 'RUNNING' | 'STOPPED' | 'ERROR' | 'UPDATING';
const priorStatus = (metadata: Record<string, unknown>): AgentStatusValue => {
  const value = metadata['agentStatusBeforeUpgrade'];
  return typeof value === 'string' && AGENT_STATUSES.has(value) ? value as AgentStatusValue : 'RUNNING';
};

/** End UPDATING (node went offline, or the agent stopped reporting an upgrade) and restore the status it had before. */
export async function clearAgentUpdating(nodeId: string): Promise<void> {
  const db = getDb();
  const agent = await db.agent.findUnique({ where: { nodeId }, select: { status: true } });
  if (agent?.status !== 'UPDATING') return;
  const row = await db.node.findUnique({ where: { id: nodeId }, select: { metadata: true } });
  const metadata = parseMetadata(row?.metadata);
  await db.agent.updateMany({ where: { nodeId, status: 'UPDATING' }, data: { status: priorStatus(metadata) } });
  if ('agentStatusBeforeUpgrade' in metadata) {
    delete metadata['agentStatusBeforeUpgrade'];
    await db.node.update({ where: { id: nodeId }, data: { metadata: JSON.stringify(metadata) } });
  }
}

/**
 * Store the self-upgrade report from a heartbeat, keep Agent.status in step
 * (UPDATING while a version is staged or on trial, then the status it had
 * before), audit each confirmation and revert once, and record outcomes that
 * arrive after their run stopped watching.
 */
export async function recordSelfUpgradeReport(node: { id: string; name: string }, body: { selfUpgrade?: unknown; nodeVersion?: unknown },
  store: RunStore = defaultRunStore()): Promise<void> {
  const parsed = parseSelfUpgradeStatus(body.selfUpgrade, node.name);
  if (!parsed) {
    await clearAgentUpdating(node.id);
    return;
  }
  const db = getDb();
  const row = await db.node.findUnique({ where: { id: node.id }, select: { metadata: true } });
  const metadata = parseMetadata(row?.metadata);
  const previous = storedSelfUpgrade(row?.metadata);
  const nodeVersion = typeof body.nodeVersion === 'string' ? body.nodeVersion.slice(0, 32) : null;
  const next = { ...parsed, nodeVersion, observedAt: new Date().toISOString() };
  const nextMetadata: Record<string, unknown> = { ...metadata, agentSelfUpgrade: next, nodeVersion };
  let changed = !(previous && JSON.stringify({ ...previous, observedAt: '' }) === JSON.stringify({ ...next, observedAt: '' })
    && Date.now() - Date.parse(previous.observedAt) < 10 * 60_000);
  const state = parsed.upgrade?.state;
  const updating = state === 'staged' || state === 'trial';
  const agent = await db.agent.findUnique({ where: { nodeId: node.id }, select: { status: true } });
  if (agent && updating && agent.status !== 'UPDATING') {
    nextMetadata['agentStatusBeforeUpgrade'] = agent.status;
    changed = true;
    await db.agent.updateMany({ where: { nodeId: node.id, status: { not: 'UPDATING' } }, data: { status: 'UPDATING' } });
  } else if (agent && !updating && agent.status === 'UPDATING') {
    delete nextMetadata['agentStatusBeforeUpgrade'];
    changed = true;
    await db.agent.updateMany({ where: { nodeId: node.id, status: 'UPDATING' }, data: { status: priorStatus(metadata) } });
  }
  if (changed) await db.node.update({ where: { id: node.id }, data: { metadata: JSON.stringify(nextMetadata) } });
  const upgrade = parsed.upgrade;
  if (upgrade && (upgrade.state === 'reverted' || upgrade.state === 'confirmed' || upgrade.state === 'failed') && upgrade.requestId
    && !(previous?.upgrade?.requestId === upgrade.requestId && previous.upgrade.state === upgrade.state)) {
    const runId = await store.runForRequest(upgrade.requestId).catch(() => null);
    if (upgrade.state !== 'failed') {
      await logAuditEvent({
        action: upgrade.state === 'reverted' ? 'agent.upgrade.node_reverted' : 'agent.upgrade.node_confirmed',
        actorId: 'system:agent-upgrade', actorType: 'system', targetType: 'node', targetId: node.id,
        details: { node: node.name, from: upgrade.from, to: upgrade.to, requestId: upgrade.requestId, runId, result: upgrade.state, reason: upgrade.reason ?? null },
      }).catch(() => undefined);
    }
    if (runId) await recordLateOutcome(store, runId, upgrade.requestId, upgrade.state, upgrade.reason ?? null).catch(() => undefined);
  }
}

/** A report for a node whose run already ended without knowing its outcome. */
async function recordLateOutcome(store: RunStore, runId: string, requestId: string, state: 'confirmed' | 'reverted' | 'failed', reason: string | null): Promise<void> {
  const run = await store.get(runId);
  if (!run || run.status === 'running') return; // the owner is watching and records it itself
  const entry = run.nodes.find(node => node.requestId === requestId);
  if (!entry || !(entry.awaitingReport || entry.state === 'requested')) return;
  entry.state = state;
  entry.code = state === 'confirmed' ? null : entry.code;
  entry.detail = `${state === 'confirmed' ? 'confirmed' : state === 'reverted' ? `reverted: ${reason ?? 'the agent switched back'}` : `failed: ${reason ?? 'the agent reported a failure'}`} (reported after the run ended)`;
  entry.awaitingReport = false;
  run.summary = summarizeRun(run);
  await store.save(run);
}

// ── Release resolution ──

export interface AgentRelease {
  version: string;
  integrity: string;
}

export const isPrerelease = (version: string) => (parseVersion(version)?.prerelease.length ?? 0) > 0;

/** The exact version (default: the one this server ships) and its npm integrity. */
export async function resolveAgentRelease(options: { version?: string; integrity?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<AgentRelease> {
  const version = options.version ?? AGENT_VERSION;
  if (!isVersion(version)) throw new HttpError(400, 'INVALID_VERSION', `${version} is not an X.Y.Z version`);
  if (options.integrity) {
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(options.integrity)) throw new HttpError(400, 'INVALID_INTEGRITY', 'integrity must be sha512-<base64>');
    return { version, integrity: options.integrity };
  }
  const registry = upgradeSettings().updateRegistry;
  const url = `${registry}/${AGENT_PACKAGE.replace('/', '%2f')}/${version}`;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(options.timeoutMs ?? 15_000) });
  } catch (error) {
    throw new HttpError(502, 'REGISTRY_UNREACHABLE', `Cannot read ${AGENT_PACKAGE}@${version} from ${registry}: ${error instanceof Error ? error.message : String(error)}. Pass the integrity explicitly for offline installs.`);
  }
  if (response.status === 404) throw new HttpError(404, 'AGENT_VERSION_NOT_PUBLISHED', `${AGENT_PACKAGE}@${version} is not published on ${registry}`);
  if (!response.ok) throw new HttpError(502, 'REGISTRY_ERROR', `${registry} answered ${response.status} for ${AGENT_PACKAGE}@${version}`);
  const document = await response.json() as { dist?: { integrity?: string } };
  const integrity = document.dist?.integrity;
  if (!integrity?.startsWith('sha512-')) throw new HttpError(502, 'REGISTRY_ERROR', `${AGENT_PACKAGE}@${version} has no sha512 integrity`);
  return { version, integrity };
}

export interface ReleaseVerification { verified: boolean; integrity: string | null; reason: string | null }
const verifications = new Map<string, { at: number; value: ReleaseVerification }>();
/** Whether the registry has `version` (cached ten minutes); eligibility shows unpublished targets as unverified. */
export async function verifyAgentRelease(version: string, fetchImpl?: typeof fetch): Promise<ReleaseVerification> {
  const cached = verifications.get(version);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.value;
  let value: ReleaseVerification;
  try {
    const release = await resolveAgentRelease({ version, fetchImpl, timeoutMs: 5_000 });
    value = { verified: true, integrity: release.integrity, reason: null };
  } catch (error) {
    value = { verified: false, integrity: null, reason: error instanceof Error ? error.message : String(error) };
  }
  verifications.set(version, { at: Date.now(), value });
  return value;
}

// ── Eligibility ──

export interface UpgradeCandidate {
  nodeId: string;
  name: string;
  version: string;
  eligible: boolean;
  reason: string | null;
  upgrade: StoredSelfUpgrade['upgrade'] | null;
  layout: StoredSelfUpgrade['layout'] | null;
}

export interface CandidateRow {
  id: string;
  name: string;
  hostname?: string;
  status: string;
  lastHeartbeatAt: Date | null;
  metadata: string;
  agent: { version: string } | null;
  resourceEnrollment?: { state: string; nodeFqdn: string; startedAt: Date | null; updatedAt: Date } | null;
  admissionFence?: { releaseId: string; closedAt: Date } | null;
  /** Participant work in reserved/running/unknown. */
  heldWork?: number;
  /** Command leases in reserved/running/unknown. */
  heldLeases?: number;
  /** Any command lease ever, which takes the node off the legacy path for good. */
  leaseHistory?: boolean;
  managedCronHistory?: boolean;
  /** Participant work in any state (legacy-admission counts it: see resource-ownership.ts). */
  participantHistory?: boolean;
}

export interface EligibilityOptions {
  now?: number;
  leasesRequested?: boolean;
  /** Offer nodes that already reverted this exact version. */
  allowRetryReverted?: boolean;
}

const day = (value: Date | string | null | undefined) => value ? new Date(value).toISOString().slice(0, 10) : 'an unknown date';
const ENROLLMENT_DOC = 'docs/COMMAND_RESOURCE_LEASES.md';

/** Pure, for tests: why one node can or cannot take `target` now. Mirrors the dispatch preconditions. */
export function classifyCandidate(row: CandidateRow, target: string, options: EligibilityOptions = {}): UpgradeCandidate {
  const now = options.now ?? Date.now();
  const version = row.agent?.version ?? 'unknown';
  const report = storedSelfUpgrade(row.metadata);
  const base = { nodeId: row.id, name: row.name, version, upgrade: report?.upgrade ?? null, layout: report?.layout ?? null };
  const no = (reason: string) => ({ ...base, eligible: false, reason });
  if (!hasFreshOnlineHealth(row, now)) return no(`offline or no recent heartbeat${row.lastHeartbeatAt ? ` (last ${row.lastHeartbeatAt.toISOString()})` : ''}`);
  if (!isVersion(version)) return no('agent version unknown');
  if (compareVersions(version, target) === 0) return no('already on this version');
  const decision = checkUpgradeAllowed(version, target);
  if (!decision.allowed) return no(decision.kind === 'downgrade' ? `runs ${version}, newer than ${target}` : `${version} -> ${target} crosses a major version; upgrade this node by hand`);
  if (!report) return no(`magnus-agent ${version} cannot upgrade itself (needs 1.1.0 or later and \`sudo magnus-agent install-service\`)`);
  if (report.protocol < AGENT_SELF_UPGRADE_PROTOCOL) return no('agent self-upgrade protocol too old');
  if (!report.enabled) return no(report.reason ?? 'self-upgrade disabled on this node');
  const upgrade = report.upgrade;
  if (upgrade && (upgrade.state === 'staged' || upgrade.state === 'trial')) return no(`an upgrade to ${upgrade.to} is in progress`);
  if (upgrade?.state === 'reverted' && upgrade.to === target && !options.allowRetryReverted)
    return no(`reverted ${target} at ${upgrade.updatedAt ?? report.observedAt}: ${upgrade.reason ?? 'no reason given'}; try again only with allowRetryReverted`);
  if (row.admissionFence) return no(`release ${row.admissionFence.releaseId} closed admission to this node at ${row.admissionFence.closedAt.toISOString()}; release the fence first`);
  const enrollment = row.resourceEnrollment ?? null;
  const hostname = row.hostname ?? '';
  const marker = report.managedEnrollment;
  if (marker && (!enrollmentIsComplete(enrollment, marker.nodeFqdn) || marker.nodeId !== row.id || marker.nodeFqdn !== hostname)) {
    const server = enrollment ? `a ${enrollment.state} enrollment for ${enrollment.nodeFqdn}` : 'no enrollment row';
    const cause = stickyEnrollmentCause(enrollment, { lease: Boolean(row.leaseHistory), managedCron: Boolean(row.managedCronHistory),
      participantWork: Boolean(row.participantHistory) });
    return no(`agent and server disagree about resource enrollment: the agent holds a managed-enrollment marker for ${marker.nodeFqdn} but the server has ${server}`
      + `${cause ? ` (the server answers this agent as enrolled because of ${cause})` : ''}; `
      + `complete the node's resource enrollment on the server (${ENROLLMENT_DOC}), or upgrade this agent by hand on the node`);
  }
  // Same rule as admission: off the legacy path once leases are on, enrollment started, or any lease exists.
  const managed = !legacyAdmissionPossible(enrollment, options.leasesRequested ?? resourceLeasesRequested()) || Boolean(row.leaseHistory);
  if (managed) {
    if (!enrollmentIsComplete(enrollment, hostname)) {
      if (!enrollment) return no(`resource leases apply to this node (${row.leaseHistory ? 'it has lease history' : 'MAGNUS_RESOURCE_LEASES_ENABLED=true'}) but it is not enrolled; enroll it first (${ENROLLMENT_DOC})`);
      if (enrollment.state === 'draining') return no(`resource enrollment stuck in draining since ${day(enrollment.startedAt ?? enrollment.updatedAt)}; finish the drain (POST /api/v1/resource-leases/enrollment/${row.id}/complete) first`);
      if (enrollment.state === 'enrolled') return no(`resource enrollment is for ${enrollment.nodeFqdn} but the inventory host name is ${hostname || 'unknown'}; fix the inventory host name first`);
      return no(`resource enrollment is ${enrollment.state} while resource leases apply to this node; enroll it first (${ENROLLMENT_DOC})`);
    }
    if (row.heldWork) return no(`${row.heldWork} participant work item(s) still held on this node; reconcile them first`);
    if (row.heldLeases) return no(`${row.heldLeases} command lease(s) unsettled on this node (reserved, running or unknown); reconcile them first`);
  }
  return { ...base, eligible: true, reason: null };
}

/** Candidates for `target`; `nodeIds: []` selects nothing (never the whole fleet). */
export async function listUpgradeCandidates(target: string, nodeIds?: readonly string[], options: EligibilityOptions = {}): Promise<UpgradeCandidate[]> {
  if (nodeIds && nodeIds.length === 0) return [];
  const db = getDb();
  const rows = await db.node.findMany({
    where: { id: { notIn: SENTINEL_NODE_IDS, ...(nodeIds ? { in: [...nodeIds] } : {}) }, status: { not: 'DECOMMISSIONED' } },
    select: { id: true, name: true, hostname: true, status: true, lastHeartbeatAt: true, metadata: true, agent: { select: { version: true } },
      resourceEnrollment: { select: { state: true, nodeFqdn: true, startedAt: true, updatedAt: true } },
      admissionFence: { select: { releaseId: true, closedAt: true } } },
    orderBy: { name: 'asc' },
  });
  const ids = rows.map(row => row.id);
  const [leases, work, crons] = ids.length ? await Promise.all([
    db.commandResourceLease.groupBy({ by: ['nodeId', 'state'], where: { nodeId: { in: ids } }, _count: { _all: true } }),
    db.resourceParticipantWork.groupBy({ by: ['nodeId', 'state'], where: { nodeId: { in: ids } }, _count: { _all: true } }),
    db.managedCronDefinition.groupBy({ by: ['nodeId'], where: { nodeId: { in: ids } }, _count: { _all: true } }),
  ]) : [[], [], []];
  const held = (items: Array<{ nodeId: string; state: string; _count: { _all: number } }>, nodeId: string) =>
    items.filter(item => item.nodeId === nodeId && HELD_RESOURCE_STATES.includes(item.state)).reduce((sum, item) => sum + item._count._all, 0);
  return rows.map(row => classifyCandidate({ ...row,
    leaseHistory: leases.some(lease => lease.nodeId === row.id),
    heldLeases: held(leases, row.id),
    heldWork: held(work, row.id),
    participantHistory: work.some(item => item.nodeId === row.id),
    managedCronHistory: crons.some(item => item.nodeId === row.id),
  }, target, options));
}

// ── Runs ──

export type NodeRunState = 'pending' | 'requested' | 'confirmed' | 'reverted' | 'failed' | 'refused' | 'skipped';
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'stopped' | 'interrupted';

export interface RunNode {
  nodeId: string;
  name: string;
  from: string;
  state: NodeRunState;
  requestId: string;
  detail: string | null;
  /** Agent or server error code behind a refusal or failure. */
  code?: string | null;
  dispatchedAt?: string | null;
  finishedAt?: string | null;
  /** Ended without a known outcome; a later heartbeat report for its requestId is recorded into the run. */
  awaitingReport?: boolean;
}

export interface UpgradeRun {
  id: string;
  version: string;
  integrity: string;
  actorId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  concurrency: number;
  message: string | null;
  /** "N confirmed, N refused, N failed, N skipped" plus each refusal reason. */
  summary?: string | null;
  canaryNodeId?: string | null;
  /** Server process that executes the run, and until when that claim holds. */
  owner?: string;
  leaseExpiresAt?: string;
  stopRequestedBy?: string | null;
  retryOf?: string | null;
  allowRetryReverted?: boolean;
  /** Selected nodes that were not eligible when the run started. */
  excluded?: Array<{ nodeId: string; name: string; reason: string }>;
  nodes: RunNode[];
}

/** Persistence and coordination of runs (Redis, with an in-process fallback). */
export interface RunStore {
  save(run: UpgradeRun): Promise<void>;
  get(id: string): Promise<UpgradeRun | null>;
  latest(): Promise<UpgradeRun | null>;
  /** One run at a time, fleet-wide: SET NX with a TTL, renewed by the owner. */
  lock(token: string): Promise<boolean>;
  renew(token: string): Promise<boolean>;
  unlock(token: string): Promise<void>;
  requestStop(id: string, actorId: string): Promise<void>;
  stopRequested(id: string): Promise<string | null>;
  index(run: UpgradeRun): Promise<void>;
  runForRequest(requestId: string): Promise<string | null>;
}

/** In-process store: tests, and the fallback without Redis. Keeps the newest MAX_LOCAL_RUNS runs. */
export function memoryRunStore(): RunStore {
  const runs = new Map<string, UpgradeRun>();
  const stops = new Map<string, string>();
  const requests = new Map<string, string>();
  let held: { token: string; until: number } | null = null;
  let latestId: string | null = null;
  return {
    async save(run) {
      runs.delete(run.id);
      runs.set(run.id, run);
      latestId = run.id;
      for (const [id, stored] of runs) {
        if (runs.size <= MAX_LOCAL_RUNS) break;
        if (stored.status !== 'running') {
          runs.delete(id);
          stops.delete(id);
          for (const node of stored.nodes) requests.delete(node.requestId);
        }
      }
    },
    async get(id) { return runs.get(id) ?? null; },
    async latest() { return latestId ? runs.get(latestId) ?? null : null; },
    async lock(token) {
      if (held && held.until > Date.now() && held.token !== token) return false;
      held = { token, until: Date.now() + LEASE_MS };
      return true;
    },
    async renew(token) {
      if (held?.token !== token) return false;
      held.until = Date.now() + LEASE_MS;
      return true;
    },
    async unlock(token) { if (held?.token === token) held = null; },
    async requestStop(id, actorId) { stops.set(id, actorId); },
    async stopRequested(id) { return stops.get(id) ?? null; },
    async index(run) { for (const node of run.nodes) requests.set(node.requestId, run.id); },
    async runForRequest(requestId) { return requests.get(requestId) ?? null; },
  };
}

const LOCK_KEY = 'agent-upgrade-run:lock';
const RELEASE_IF_OWNED = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const RENEW_IF_OWNED = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";

let sharedStore: RunStore | null = null;
/** Redis-backed store; every call falls back to this process's memory when Redis is unavailable. */
export function defaultRunStore(): RunStore {
  if (sharedStore) return sharedStore;
  const memory = memoryRunStore();
  const redis = async () => (await import('../queue/redis.js')).getRedis();
  const either = async <T>(remote: () => Promise<T>, local: () => Promise<T>): Promise<T> => {
    try { return await remote(); } catch { return local(); }
  };
  sharedStore = {
    async save(run) {
      await memory.save(run);
      await either(async () => {
        const client = await redis();
        await client.set(`agent-upgrade-run:${run.id}`, JSON.stringify(run), 'EX', RUN_TTL_SECONDS);
        await client.set('agent-upgrade-run:latest', run.id, 'EX', RUN_TTL_SECONDS);
      }, async () => undefined);
    },
    get: id => either(async () => {
      const raw = await (await redis()).get(`agent-upgrade-run:${id}`);
      return raw ? JSON.parse(raw) as UpgradeRun : memory.get(id);
    }, () => memory.get(id)),
    latest: () => either(async () => {
      const id = await (await redis()).get('agent-upgrade-run:latest');
      return id ? sharedStore!.get(id) : memory.latest();
    }, () => memory.latest()),
    lock: token => either(async () => await (await redis()).set(LOCK_KEY, token, 'PX', LEASE_MS, 'NX') === 'OK', () => memory.lock(token)),
    renew: token => either(async () => Number(await (await redis()).eval(RENEW_IF_OWNED, 1, LOCK_KEY, token, String(LEASE_MS))) === 1, () => memory.renew(token)),
    unlock: token => either(async () => { await (await redis()).eval(RELEASE_IF_OWNED, 1, LOCK_KEY, token); }, () => memory.unlock(token)),
    async requestStop(id, actorId) {
      await memory.requestStop(id, actorId);
      await either(async () => { await (await redis()).set(`agent-upgrade-run:${id}:stop`, actorId, 'EX', RUN_TTL_SECONDS); }, async () => undefined);
    },
    stopRequested: id => either(async () => await (await redis()).get(`agent-upgrade-run:${id}:stop`) ?? memory.stopRequested(id), () => memory.stopRequested(id)),
    async index(run) {
      await memory.index(run);
      await either(async () => {
        const pipeline = (await redis()).pipeline();
        for (const node of run.nodes) pipeline.set(`agent-upgrade-request:${node.requestId}`, run.id, 'EX', RUN_TTL_SECONDS);
        await pipeline.exec();
      }, async () => undefined);
    },
    runForRequest: requestId => either(async () => await (await redis()).get(`agent-upgrade-request:${requestId}`) ?? memory.runForRequest(requestId),
      () => memory.runForRequest(requestId)),
  };
  return sharedStore;
}

/** Runs this process is executing right now. */
const executing = new Map<string, { run: UpgradeRun; timer: ReturnType<typeof setInterval> }>();

export interface Observation {
  version: string | null;
  report: StoredSelfUpgrade | null;
  lastHeartbeatAt?: Date | null;
}

export interface UpgradeDeps {
  /** Throws NotDispatchedError, AgentResponseError or DispatchOutcomeUnknownError (anything else counts as unknown). */
  request: (nodeId: string, body: { version: string; integrity: string; requestId: string; packageName: string }) => Promise<void>;
  /** Current report, agent version and last heartbeat of one node. */
  observe: (nodeId: string) => Promise<Observation>;
  /** Eligibility right before dispatch: null, or why the node is skipped now. */
  check: (nodeId: string, run: UpgradeRun) => Promise<string | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  save: (run: UpgradeRun) => Promise<void>;
  /** Who asked to stop this run, if anyone; honoured between batches. */
  stopRequested: (runId: string) => Promise<string | null>;
  /** Fallback confirmation window when the agent does not report confirmSeconds. */
  confirmTimeoutMs: number;
  pollMs: number;
}

function clientFor(node: { id: string; ipAddress: string; port: number }): NodeApiClient {
  return new NodeApiClient({ baseUrl: getNodeBaseUrl(node.ipAddress, node.port), resourceNodeId: node.id, nodeToken: getNodeManagerSecret(),
    resourceActorId: 'system:agent-upgrade', timeout: 15 * 60_000 });
}

/** Trial window the agent reported (or the default), two heartbeats, and the restart margin. */
export function confirmWindowMs(report: Pick<StoredSelfUpgrade, 'confirmSeconds'> | null | undefined, fallbackMs = DEFAULT_CONFIRM_SECONDS * 1000 + 2 * HEARTBEAT_MS + CONFIRM_MARGIN_MS): number {
  return report?.confirmSeconds ? report.confirmSeconds * 1000 + 2 * HEARTBEAT_MS + CONFIRM_MARGIN_MS : fallbackMs;
}

export function defaultDeps(store: RunStore = defaultRunStore()): UpgradeDeps {
  return {
    request: async (nodeId, body) => {
      const node = await getDb().node.findUnique({ where: { id: nodeId }, select: { id: true, ipAddress: true, port: true } });
      if (!node) throw new NotDispatchedError('NODE_NOT_FOUND', 'node is no longer in the inventory');
      await clientFor(node).upgradeAgent(body);
    },
    observe: async nodeId => {
      const row = await getDb().node.findUnique({ where: { id: nodeId }, select: { metadata: true, lastHeartbeatAt: true, agent: { select: { version: true } } } });
      return { version: row?.agent?.version ?? null, report: storedSelfUpgrade(row?.metadata), lastHeartbeatAt: row?.lastHeartbeatAt ?? null };
    },
    check: async (nodeId, run) => {
      const [candidate] = await listUpgradeCandidates(run.version, [nodeId], { allowRetryReverted: run.allowRetryReverted });
      return candidate ? candidate.eligible ? null : candidate.reason : 'node is no longer in the inventory';
    },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
    save: run => store.save(run),
    stopRequested: async runId => await store.stopRequested(runId).catch(() => null),
    confirmTimeoutMs: confirmWindowMs(null),
    pollMs: POLL_MS,
  };
}

export interface DispatchFailure { kind: 'refused' | 'failed' | 'unknown'; code: string; message: string }

/** Whether a failed request left the node untouched (refused), hit a release problem (failed), or may have run (unknown). */
export function classifyDispatchFailure(error: unknown): DispatchFailure {
  const message = (error instanceof AgentResponseError ? error.agentMessage ?? error.message : error instanceof Error ? error.message : String(error)).slice(0, 1000);
  const code = (error as { code?: unknown } | null)?.code;
  if (error instanceof NotDispatchedError || (error as { dispatched?: unknown } | null)?.dispatched === false)
    return { kind: 'refused', code: typeof code === 'string' ? code : 'NOT_DISPATCHED', message };
  if (error instanceof AgentResponseError) {
    const agentCode = error.code ?? `HTTP_${error.agentStatus}`;
    if (agentCode === 'MUTATION_OUTCOME_UNKNOWN') return { kind: 'unknown', code: agentCode, message };
    if (UNTOUCHED_CODES.has(agentCode)) return { kind: 'refused', code: agentCode, message };
    return { kind: 'failed', code: agentCode, message: RELEASE_PROBLEM_CODES.has(agentCode) ? message : `agent answered HTTP ${error.agentStatus}: ${message}` };
  }
  if (error instanceof DispatchOutcomeUnknownError) return { kind: 'unknown', code: error.code, message };
  return { kind: 'unknown', code: typeof code === 'string' ? code : 'MUTATION_OUTCOME_UNKNOWN', message };
}

const audit = (action: AuditAction, run: UpgradeRun, details: Record<string, unknown>, targetType = 'fleet', targetId = run.id) =>
  logAuditEvent({ action, actorId: run.actorId, targetType, targetId, details: { runId: run.id, version: run.version, ...details } }).catch(() => undefined);

/** Ask one node to upgrade and wait for its confirmed (or reverted) report. */
async function upgradeOne(run: UpgradeRun, entry: RunNode, deps: UpgradeDeps): Promise<void> {
  const iso = () => new Date(deps.now()).toISOString();
  const end = (state: NodeRunState, detail: string | null, code: string | null = null, awaitingReport = false) => {
    Object.assign(entry, { state, detail: detail?.slice(0, 1000) ?? null, code, finishedAt: iso(), awaitingReport });
    if (state === 'refused' || state === 'failed' || (state === 'confirmed' && detail?.startsWith('confirmed by version')))
      void audit(`agent.upgrade.node_${state}` as AuditAction, run, { node: entry.name, requestId: entry.requestId, code, detail }, 'node', entry.nodeId);
  };
  let reason: string | null;
  try {
    reason = await deps.check(entry.nodeId, run);
  } catch (error) {
    reason = `eligibility check failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (reason) return void Object.assign(entry, { state: 'skipped', detail: reason, finishedAt: iso() });
  entry.state = 'requested';
  await deps.save(run);
  const startedAt = deps.now();
  let unknown: DispatchFailure | null = null;
  try {
    await deps.request(entry.nodeId, { version: run.version, integrity: run.integrity, requestId: entry.requestId, packageName: AGENT_PACKAGE });
  } catch (error) {
    const failure = classifyDispatchFailure(error);
    if (failure.kind === 'refused') return end('refused', failure.message, failure.code);
    if (failure.kind === 'failed') return end('failed', failure.message, failure.code);
    unknown = failure;
  }
  entry.dispatchedAt = iso();
  let windowMs = deps.confirmTimeoutMs;
  let versionSince: number | null = null;
  let lastHeartbeat: Date | null = null;
  const deadline = () => Math.max(startedAt + windowMs + (unknown ? UNKNOWN_DISPATCH_MARGIN_MS : 0),
    versionSince === null ? 0 : versionSince + windowMs + deps.pollMs);
  while (deps.now() < deadline()) {
    await deps.sleep(deps.pollMs);
    let observation: Observation;
    try {
      observation = await deps.observe(entry.nodeId);
    } catch (error) {
      console.warn(`[agent-upgrade] could not read the state of ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const { version, report } = observation;
    lastHeartbeat = observation.lastHeartbeatAt ?? lastHeartbeat;
    if (report?.confirmSeconds) windowMs = confirmWindowMs(report);
    const upgrade = report?.upgrade;
    if (upgrade?.requestId === entry.requestId) {
      if (upgrade.state === 'confirmed') return end('confirmed', unknown ? 'confirmed (the reply to the request was lost)' : null);
      if (upgrade.state === 'reverted') return end('reverted', upgrade.reason ?? 'the agent switched back to its previous version', 'SELF_UPGRADE_REVERTED');
      if (upgrade.state === 'failed') return end('failed', upgrade.reason ?? 'the agent reported the upgrade as failed', 'SELF_UPGRADE_FAILED');
    } else if (!upgrade?.requestId && version === run.version) {
      // Agents that do not report request ids: the version has to hold for one full trial window.
      versionSince ??= deps.now();
      if (deps.now() - versionSince >= windowMs) return end('confirmed', 'confirmed by version (the agent does not report upgrade requests)');
    } else {
      versionSince = null;
    }
    // Silent for longer than the agent's own trial window: it will not confirm, even if the extended deadline is not up.
    if (lastHeartbeat && deps.now() - lastHeartbeat.getTime() > windowMs)
      return end('failed', `no heartbeat since ${lastHeartbeat.toISOString()}`, 'AGENT_SILENT', true);
  }
  const minutes = Math.round((deadline() - startedAt) / 60_000);
  if (unknown) return end('failed', `outcome unknown (${unknown.message}); no report for this request within ${minutes} min`, unknown.code, true);
  end('failed', `no confirmation within ${minutes} min`, 'CONFIRM_TIMEOUT', true);
}

/** "N confirmed, N refused, N failed, N skipped" and each refusal reason. */
export function summarizeRun(run: UpgradeRun): string {
  const count = (state: NodeRunState) => run.nodes.filter(node => node.state === state).length;
  const reverted = count('reverted');
  const refused = run.nodes.filter(node => node.state === 'refused');
  return `${count('confirmed')} confirmed, ${refused.length} refused, ${count('failed')} failed, ${reverted ? `${reverted} reverted, ` : ''}${count('skipped')} skipped`
    + (refused.length ? `; refused: ${refused.map(node => `${node.name} (${node.code ? `${node.code}: ` : ''}${node.detail ?? 'no reason given'})`).join('; ')}` : '');
}

const halts = (node: RunNode) => node.state === 'failed' || node.state === 'reverted';

/**
 * Canary first, then batches of `concurrency`. A refused canary hands the
 * role to the next node. Stops at the first revert or failure, or between
 * batches when someone asked to stop.
 */
export async function executeUpgradeRun(run: UpgradeRun, deps: UpgradeDeps): Promise<UpgradeRun> {
  const finish = async (status: RunStatus, message: string) => {
    for (const node of run.nodes) if (node.state === 'pending') Object.assign(node, { state: 'skipped', detail: status === 'stopped' ? 'run stopped' : 'not reached' });
    run.status = status;
    run.summary = summarizeRun(run);
    run.message = `${message} (${run.summary})`;
    run.finishedAt = new Date(deps.now()).toISOString();
    await deps.save(run);
    await audit(status === 'stopped' ? 'agent.upgrade_run.stopped' : 'agent.upgrade_run.finished', run, { status, summary: run.summary,
      stoppedBy: run.stopRequestedBy ?? null });
    return run;
  };
  const pending = () => run.nodes.filter(node => node.state === 'pending');
  const stopped = async () => {
    const actor = await deps.stopRequested(run.id).catch(() => null);
    if (actor) run.stopRequestedBy = actor;
    return actor;
  };
  try {
    let canary: RunNode | undefined;
    while ((canary = pending()[0])) {
      if (await stopped()) return finish('stopped', `stopped by ${run.stopRequestedBy}`);
      run.canaryNodeId = canary.nodeId;
      await upgradeOne(run, canary, deps);
      await deps.save(run);
      if (canary.state === 'confirmed') break;
      if (halts(canary)) return finish('failed', `canary ${canary.name} did not confirm (${canary.state}: ${canary.detail ?? ''}); the other nodes were not touched`);
    }
    for (let batch = pending().slice(0, run.concurrency); batch.length; batch = pending().slice(0, run.concurrency)) {
      if (await stopped()) return finish('stopped', `stopped by ${run.stopRequestedBy}`);
      await Promise.all(batch.map(node => upgradeOne(run, node, deps)));
      await deps.save(run);
      const bad = batch.find(halts);
      if (bad) return finish('failed', `${bad.name} did not confirm (${bad.state}: ${bad.detail ?? ''}); remaining nodes were skipped`);
    }
    const confirmed = run.nodes.filter(node => node.state === 'confirmed').length;
    if (!run.nodes.length) return finish('succeeded', 'no eligible nodes');
    return confirmed ? finish('succeeded', `${confirmed} agent(s) upgraded to ${run.version}`) : finish('failed', 'no agent was upgraded');
  } catch (error) {
    return finish('failed', `run aborted: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── Interrupted runs ──

const leaseExpired = (run: UpgradeRun, now = Date.now()) => run.status === 'running' && !executing.has(run.id)
  && (run.leaseExpiresAt ? Date.parse(run.leaseExpiresAt) : Date.parse(run.startedAt) + UNLEASED_RUN_MS) < now;

/**
 * The owner stopped renewing (server restart, CLI interrupted): settle the
 * requested nodes from their stored heartbeat reports, skip the pending ones
 * and mark the run `interrupted`. Unresolved nodes keep `awaitingReport`.
 */
export async function reconcileInterruptedRun(run: UpgradeRun, observe: UpgradeDeps['observe'], save: (run: UpgradeRun) => Promise<void>, now = Date.now()): Promise<UpgradeRun> {
  if (!leaseExpired(run, now)) return run;
  const at = new Date(now).toISOString();
  for (const node of run.nodes) {
    if (node.state === 'pending') Object.assign(node, { state: 'skipped', detail: 'run interrupted before this node', finishedAt: at });
    if (node.state !== 'requested') continue;
    const upgrade = await observe(node.nodeId).then(observation => observation.report?.upgrade, () => null);
    const mine = upgrade?.requestId === node.requestId ? upgrade : null;
    if (mine?.state === 'confirmed') Object.assign(node, { state: 'confirmed', detail: 'confirmed (recorded after the run was interrupted)', code: null });
    else if (mine?.state === 'reverted') Object.assign(node, { state: 'reverted', detail: mine.reason ?? 'the agent switched back', code: 'SELF_UPGRADE_REVERTED' });
    else if (mine?.state === 'failed') Object.assign(node, { state: 'failed', detail: mine.reason ?? 'the agent reported a failure', code: 'SELF_UPGRADE_FAILED' });
    else Object.assign(node, { state: 'failed', code: 'RUN_INTERRUPTED', awaitingReport: true,
      detail: `the server stopped watching${mine ? ` while the agent reported ${mine.state}` : ''}; a later report for this request is recorded here` });
    node.finishedAt = at;
  }
  run.status = 'interrupted';
  run.summary = summarizeRun(run);
  run.message = `interrupted: the server that ran it stopped renewing its lease (restart or interrupted CLI) (${run.summary})`;
  run.finishedAt = at;
  await save(run);
  await audit('agent.upgrade_run.finished', run, { status: 'interrupted', summary: run.summary });
  return run;
}

export async function getUpgradeRun(id: string, store: RunStore = defaultRunStore()): Promise<UpgradeRun | null> {
  const run = executing.get(id)?.run ?? await store.get(id).catch(() => null);
  return run ? reconcileInterruptedRun(run, defaultDeps(store).observe, saved => store.save(saved)) : null;
}

export async function latestUpgradeRun(store: RunStore = defaultRunStore()): Promise<UpgradeRun | null> {
  const run = await store.latest().catch(() => null);
  return run ? getUpgradeRun(run.id, store) : null;
}

// ── Start, stop, retry ──

export interface StartRunOptions {
  version?: string;
  integrity?: string;
  nodeIds?: string[];
  canaryNodeId?: string;
  allowPrerelease?: boolean;
  allowRetryReverted?: boolean;
  retryOf?: string;
  actorId: string;
  deps?: UpgradeDeps;
  store?: RunStore;
}

/** Validate, take the fleet-wide run lock, create the run and start it in the background. */
export async function startUpgradeRun(options: StartRunOptions): Promise<{ run: UpgradeRun; candidates: UpgradeCandidate[]; done: Promise<UpgradeRun> }> {
  const settings = upgradeSettings();
  if (!settings.agentUpgrades) throw new HttpError(403, 'AGENT_UPGRADES_DISABLED', 'Server-driven agent upgrades are off (MAGNUS_AGENT_UPGRADES=false)');
  const version = options.version ?? AGENT_VERSION;
  if (isVersion(version) && isPrerelease(version) && !options.allowPrerelease)
    throw new HttpError(400, 'PRERELEASE_NOT_ALLOWED', `${version} is a prerelease; pass allowPrerelease to install it`);
  if (options.nodeIds && options.nodeIds.length === 0) throw new HttpError(400, 'NO_NODES_SELECTED', 'nodeIds is empty; leave it out to upgrade every eligible agent');
  const store = options.store ?? defaultRunStore();
  const id = randomUUID();
  const token = `${INSTANCE_ID}:${id}`;
  if (!await store.lock(token)) throw new HttpError(409, 'AGENT_UPGRADE_RUNNING', 'Another agent upgrade run is starting or in progress');
  try {
    const running = await latestUpgradeRun(store);
    if (running?.status === 'running') throw new HttpError(409, 'AGENT_UPGRADE_RUNNING', `Upgrade run ${running.id} is still in progress`);
    const release = await resolveAgentRelease({ version, integrity: options.integrity });
    const candidates = await listUpgradeCandidates(release.version, options.nodeIds, { allowRetryReverted: options.allowRetryReverted });
    const unknown = (options.nodeIds ?? []).filter(nodeId => !candidates.some(candidate => candidate.nodeId === nodeId));
    if (unknown.length) throw new HttpError(400, 'UNKNOWN_NODES', `Unknown or decommissioned node(s): ${unknown.slice(0, 20).join(', ')}`);
    const eligible = candidates.filter(candidate => candidate.eligible);
    if (options.canaryNodeId && !eligible.some(candidate => candidate.nodeId === options.canaryNodeId)) {
      const canary = candidates.find(candidate => candidate.nodeId === options.canaryNodeId);
      throw new HttpError(400, 'INVALID_CANARY', canary ? `Canary ${canary.name} cannot be upgraded now: ${canary.reason}` : 'canaryNodeId is not among the selected nodes');
    }
    if (eligible.length === 0) {
      const reasons = candidates.slice(0, 5).map(candidate => `${candidate.name}: ${candidate.reason}`).join('; ');
      throw new HttpError(409, 'NO_ELIGIBLE_AGENTS', `No selected agent can be upgraded now${reasons ? ` (${reasons})` : ''}`);
    }
    if (options.canaryNodeId) eligible.unshift(...eligible.splice(eligible.findIndex(candidate => candidate.nodeId === options.canaryNodeId), 1));
    const deps = options.deps ?? defaultDeps(store);
    const run: UpgradeRun = {
      id, version: release.version, integrity: release.integrity, actorId: options.actorId, status: 'running',
      startedAt: new Date(deps.now()).toISOString(), finishedAt: null, concurrency: settings.agentUpgradeConcurrency, message: null, summary: null,
      canaryNodeId: eligible[0]!.nodeId, owner: INSTANCE_ID, leaseExpiresAt: new Date(deps.now() + LEASE_MS).toISOString(), stopRequestedBy: null,
      retryOf: options.retryOf ?? null, allowRetryReverted: options.allowRetryReverted ?? false,
      excluded: candidates.filter(candidate => !candidate.eligible).map(candidate => ({ nodeId: candidate.nodeId, name: candidate.name, reason: candidate.reason ?? 'not eligible' })),
      nodes: eligible.map(candidate => ({ nodeId: candidate.nodeId, name: candidate.name, from: candidate.version, state: 'pending', requestId: randomUUID(), detail: null })),
    };
    await store.index(run);
    await deps.save(run);
    await audit('agent.upgrade_run.started', run, { nodes: run.nodes.map(node => node.name), canary: run.nodes[0]!.name, retryOf: run.retryOf,
      excluded: run.excluded!.map(node => `${node.name}: ${node.reason}`).slice(0, 50) });
    // Renew the lease while this process runs it; a reader that finds it expired marks the run interrupted.
    const renew = async () => {
      run.leaseExpiresAt = new Date(Date.now() + LEASE_MS).toISOString();
      if (!await store.renew(token).catch(() => false)) console.warn(`[agent-upgrade] run ${run.id}: could not renew the run lock`);
      await deps.save(run).catch(() => undefined);
    };
    const timer = setInterval(() => void renew(), LEASE_MS / 3);
    timer.unref?.();
    executing.set(run.id, { run, timer });
    const done = executeUpgradeRun(run, deps).finally(async () => {
      clearInterval(timer);
      executing.delete(run.id);
      await store.unlock(token).catch(() => undefined);
    });
    return { run, candidates, done };
  } catch (error) {
    await store.unlock(token).catch(() => undefined);
    throw error;
  }
}

/** Ask a run to stop; the owner honours it before the next batch. A run nobody owns any more is closed as interrupted. */
export async function stopUpgradeRun(id: string, actorId: string, store: RunStore = defaultRunStore()): Promise<UpgradeRun> {
  const run = await getUpgradeRun(id, store);
  if (!run) throw new HttpError(404, 'NOT_FOUND', 'Upgrade run not found');
  if (run.status !== 'running') throw new HttpError(409, 'RUN_NOT_RUNNING', `Upgrade run ${id} already ended (${run.status})`);
  await store.requestStop(id, actorId);
  run.stopRequestedBy = actorId;
  await logAuditEvent({ action: 'agent.upgrade_run.stop_requested', actorId, targetType: 'fleet', targetId: id, details: { runId: id } }).catch(() => undefined);
  return run;
}

/** Retry the nodes a finished run did not upgrade, with the same version and integrity. */
export async function retryUpgradeRun(id: string, options: Omit<StartRunOptions, 'version' | 'integrity' | 'nodeIds' | 'retryOf'>): Promise<ReturnType<typeof startUpgradeRun>> {
  const store = options.store ?? defaultRunStore();
  const previous = await getUpgradeRun(id, store);
  if (!previous) throw new HttpError(404, 'NOT_FOUND', 'Upgrade run not found');
  if (previous.status === 'running') throw new HttpError(409, 'AGENT_UPGRADE_RUNNING', `Upgrade run ${id} is still in progress`);
  const retry = new Set<NodeRunState>(['failed', 'refused', 'skipped', 'requested', ...options.allowRetryReverted ? ['reverted' as const] : []]);
  const nodeIds = previous.nodes.filter(node => retry.has(node.state)).map(node => node.nodeId);
  if (!nodeIds.length) throw new HttpError(409, 'NOTHING_TO_RETRY', `Run ${id} has no failed, refused, skipped or interrupted nodes${options.allowRetryReverted ? '' : ' (reverted nodes need allowRetryReverted)'}`);
  return startUpgradeRun({ ...options, store, version: previous.version, integrity: previous.integrity, nodeIds, retryOf: previous.id,
    allowPrerelease: options.allowPrerelease ?? isPrerelease(previous.version) });
}
