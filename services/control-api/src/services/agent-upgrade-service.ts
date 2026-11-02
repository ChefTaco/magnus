/**
 * Server-driven agent upgrades (MAGNUS_AGENT_UPGRADES). The server pins one
 * exact version and its npm integrity, checks every selected node before
 * touching any of them, asks one canary agent to stage it, waits until that
 * agent reports the version on trial as confirmed, then upgrades the rest a
 * few at a time.
 *
 * Only evidence about the RELEASE stops a wave: an integrity or source failure
 * at once, a revert, failed install or unconfirmed trial on the canary, and
 * after the canary as many of those as MAGNUS_AGENT_UPGRADE_MAX_FAILURES.
 * Whatever is true of one node (refusals, busy, unreachable, enrollment,
 * ambiguous transport) is recorded with a code and a remedy, and the wave goes
 * on. Transient refusals are tried again at the end of the wave. Ambiguous
 * nodes are watched by request id without holding a batch slot past their
 * window, and are never retried automatically.
 *
 * Agents decide for themselves whether they can upgrade
 * (MAGNUS_AGENT_SELF_UPGRADE, launcher layout) and report it with every
 * heartbeat, so the console can grey out the ones that cannot.
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
  upgradeRemedy,
  type AgentSelfUpgradeStatus,
  type UpgradeFailureClass,
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
import { healNode, mapLimit, PREFLIGHT_CONCURRENCY, preflightNode, preflightStatus, type NodePreflight, type PreflightProblem, type PreflightQuery, type PreflightTarget } from './agent-upgrade-preflight.js';
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
/** MAGNUS_AGENT_UPGRADE_MAX_FAILURES default, for runs stored without their own budget. */
const DEFAULT_MAX_FAILURES = 2;
const LEASE_HELD_NOTE = 'not tried again: the lease of this request is still held';
const RUN_TTL_SECONDS = 7 * 24 * 60 * 60;
/** The owner renews its lease every LEASE_MS / 3; a lease this old means the owner is gone. */
const LEASE_MS = 90_000;
/** Runs written by servers without leases count as abandoned after this long. */
const UNLEASED_RUN_MS = 2 * 60 * 60_000;
const MAX_LOCAL_RUNS = 20;
/** Waits before each end-of-wave retry of transient refusals; so at most two more attempts per node. */
const AUTO_RETRY_BACKOFF_MS = [30_000, 120_000] as const;
/** A preflight result this old is not shown as current in the eligibility list. */
const PREFLIGHT_CACHE_MS = 10 * 60_000;
/** This process, as the owner of the runs it executes. */
export const INSTANCE_ID = randomUUID();

// ── Heartbeat side: what each agent reports ──

export type StoredSelfUpgrade = AgentSelfUpgradeStatus & {
  nodeVersion: string | null;
  observedAt: string;
};

function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch (error) {
    console.warn(`[agent-upgrade] node metadata is not JSON: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

const onceWarnings = new Map<string, number>();
/** The same message at most once an hour, so a Redis outage does not flood the log. */
function warnOnce(message: string): void {
  if (Date.now() - (onceWarnings.get(message) ?? 0) < 60 * 60_000) return;
  onceWarnings.set(message, Date.now());
  console.warn(`[agent-upgrade] ${message}`);
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
  // Free disk moves with every report; only crossing the threshold is a change worth a write.
  const comparable = (value: StoredSelfUpgrade) => JSON.stringify({ ...value, observedAt: '', disk: value.disk?.low });
  let changed = !(previous && comparable(previous) === comparable(next)
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

function applyLateOutcome(entry: RunNode, state: 'confirmed' | 'reverted' | 'failed', reason: string | null): void {
  entry.state = state;
  entry.code = state === 'confirmed' ? null : state === 'reverted' ? 'SELF_UPGRADE_REVERTED' : 'SELF_UPGRADE_FAILED';
  entry.failureClass = state === 'confirmed' ? null : 'release';
  entry.detail = `${state === 'confirmed' ? 'confirmed' : state === 'reverted' ? `reverted: ${reason ?? 'the agent switched back'}` : `failed: ${reason ?? 'the agent reported a failure'}`} (reported after the run stopped watching)`;
  entry.awaitingReport = false;
}

/** A report for a node nobody watches any more: its run ended, or its watch timed out while the run goes on. */
async function recordLateOutcome(store: RunStore, runId: string, requestId: string, state: 'confirmed' | 'reverted' | 'failed', reason: string | null): Promise<void> {
  const live = executing.get(runId)?.run;
  const run = live ?? await store.get(runId);
  if (!run) return;
  if (run.status === 'running' && !live) return; // another server owns it and records it itself
  const entry = run.nodes.find(node => node.requestId === requestId);
  if (!entry) return;
  // In a live run a node still being asked is its watcher's to record. Anything that gave up waiting is open,
  // whatever state it ended in: a timed-out trial that confirms later must stop counting against the budget.
  if (!(entry.awaitingReport || (run.status !== 'running' && (entry.state === 'requested' || entry.state === 'watching')))) return;
  applyLateOutcome(entry, state, reason);
  if (run.status === 'running') return; // the owner counts it at its next decision
  run.summary = summarizeRun(run);
  run.attention = attentionList(run);
  if (run.status === 'succeeded' || run.status === 'partial' || run.status === 'failed') {
    run.status = finalStatus(run);
    run.message = `${run.status === 'succeeded' ? 'all nodes upgraded after late reports' : 'updated by a late report'} (${run.summary})`;
  }
  await store.save(run);
}

// ── Release resolution ──

export interface AgentRelease {
  version: string;
  integrity: string;
  /** The version's `engines.node` when the registry was asked. */
  engines?: string | null;
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
  const url = `${registry}/@${encodeURIComponent(AGENT_PACKAGE.slice(1))}/${version}`;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(options.timeoutMs ?? 15_000) });
  } catch (error) {
    throw new HttpError(502, 'REGISTRY_UNREACHABLE', `Cannot read ${AGENT_PACKAGE}@${version} from ${registry}: ${error instanceof Error ? error.message : String(error)}. Pass the integrity explicitly for offline installs.`);
  }
  if (response.status === 404) throw new HttpError(404, 'AGENT_VERSION_NOT_PUBLISHED', `${AGENT_PACKAGE}@${version} is not published on ${registry}`);
  if (!response.ok) throw new HttpError(502, 'REGISTRY_ERROR', `${registry} answered ${response.status} for ${AGENT_PACKAGE}@${version}`);
  const document = await response.json() as { dist?: { integrity?: string }; engines?: { node?: unknown } };
  const integrity = document.dist?.integrity;
  if (!integrity?.startsWith('sha512-')) throw new HttpError(502, 'REGISTRY_ERROR', `${AGENT_PACKAGE}@${version} has no sha512 integrity`);
  return { version, integrity, engines: typeof document.engines?.node === 'string' ? document.engines.node : null };
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
  /** Catalogue code of `reason` (contracts: UPGRADE_REMEDIES). */
  code: string | null;
  upgrade: StoredSelfUpgrade['upgrade'] | null;
  layout: StoredSelfUpgrade['layout'] | null;
  /** Requests to this node go through admission and its ledger. */
  managed?: boolean;
  /** Result of the latest preflight check, when there is one. */
  preflight?: NodePreflight | null;
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
  const enrollmentState = row.resourceEnrollment ?? null;
  // Same rule as admission: off the legacy path once leases are on, enrollment started, or any lease exists.
  const managed = !legacyAdmissionPossible(enrollmentState, options.leasesRequested ?? resourceLeasesRequested()) || Boolean(row.leaseHistory);
  const base = { nodeId: row.id, name: row.name, version, upgrade: report?.upgrade ?? null, layout: report?.layout ?? null, managed };
  const no = (code: string, reason: string): UpgradeCandidate => ({ ...base, eligible: false, reason, code });
  if (!hasFreshOnlineHealth(row, now)) return no('NODE_OFFLINE', `offline or no recent heartbeat${row.lastHeartbeatAt ? ` (last ${row.lastHeartbeatAt.toISOString()})` : ''}`);
  if (!isVersion(version)) return no('VERSION_UNKNOWN', 'agent version unknown');
  if (compareVersions(version, target) === 0) return no('ALREADY_CURRENT', 'already on this version');
  const decision = checkUpgradeAllowed(version, target);
  if (!decision.allowed) return decision.kind === 'downgrade' ? no('DOWNGRADE', `runs ${version}, newer than ${target}`) : no('MAJOR_VERSION', `${version} -> ${target} crosses a major version; upgrade this node by hand`);
  if (!report) return no('NOT_SELF_UPGRADABLE', `magnus-agent ${version} cannot upgrade itself (needs 1.1.0 or later and \`sudo magnus-agent install-service\`)`);
  if (report.protocol < AGENT_SELF_UPGRADE_PROTOCOL) return no('PROTOCOL_TOO_OLD', 'agent self-upgrade protocol too old');
  if (!report.enabled) return no('SELF_UPGRADE_DISABLED', report.reason ?? 'self-upgrade disabled on this node');
  const upgrade = report.upgrade;
  if (upgrade && (upgrade.state === 'staged' || upgrade.state === 'trial')) return no('UPGRADE_IN_PROGRESS', `an upgrade to ${upgrade.to} is in progress`);
  if (upgrade?.state === 'reverted' && upgrade.to === target && !options.allowRetryReverted)
    return no('ALREADY_REVERTED', `reverted ${target} at ${upgrade.updatedAt ?? report.observedAt}: ${upgrade.reason ?? 'no reason given'}; try again only with allowRetryReverted`);
  if (row.admissionFence) return no('ADMISSION_FENCE_CLOSED', `release ${row.admissionFence.releaseId} closed admission to this node at ${row.admissionFence.closedAt.toISOString()}; release the fence first`);
  const enrollment = row.resourceEnrollment ?? null;
  const hostname = row.hostname ?? '';
  const marker = report.managedEnrollment;
  if (marker && (!enrollmentIsComplete(enrollment, marker.nodeFqdn) || marker.nodeId !== row.id || marker.nodeFqdn !== hostname)) {
    const server = enrollment ? `a ${enrollment.state} enrollment for ${enrollment.nodeFqdn}` : 'no enrollment row';
    const cause = stickyEnrollmentCause(enrollment, { lease: Boolean(row.leaseHistory), managedCron: Boolean(row.managedCronHistory),
      participantWork: Boolean(row.participantHistory) });
    return no('ENROLLMENT_MARKER_MISMATCH', `agent and server disagree about resource enrollment: the agent holds a managed-enrollment marker for ${marker.nodeFqdn} but the server has ${server}`
      + `${cause ? ` (the server answers this agent as enrolled because of ${cause})` : ''}; `
      + `complete the node's resource enrollment on the server (${ENROLLMENT_DOC}), or upgrade this agent by hand on the node`);
  }
  if (managed) {
    if (!enrollmentIsComplete(enrollment, hostname)) {
      if (!enrollment) return no('ENROLLMENT_MISSING', `resource leases apply to this node (${row.leaseHistory ? 'it has lease history' : 'MAGNUS_RESOURCE_LEASES_ENABLED=true'}) but it is not enrolled; enroll it first (${ENROLLMENT_DOC})`);
      if (enrollment.state === 'draining') return no('ENROLLMENT_DRAINING', `resource enrollment stuck in draining since ${day(enrollment.startedAt ?? enrollment.updatedAt)}; finish the drain (POST /api/v1/resource-leases/enrollment/${row.id}/complete) first`);
      if (enrollment.state === 'enrolled') return no('ENROLLMENT_HOST_MISMATCH', `resource enrollment is for ${enrollment.nodeFqdn} but the inventory host name is ${hostname || 'unknown'}; fix the inventory host name first`);
      return no('ENROLLMENT_INCOMPLETE', `resource enrollment is ${enrollment.state} while resource leases apply to this node; enroll it first (${ENROLLMENT_DOC})`);
    }
    if (row.heldWork) return no('WORK_HELD', `${row.heldWork} participant work item(s) still held on this node; reconcile them first`);
    if (row.heldLeases) return no('LEASE_HELD', `${row.heldLeases} command lease(s) unsettled on this node (reserved, running or unknown); reconcile them first`);
  }
  return { ...base, eligible: true, reason: null, code: null };
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

/**
 * `watching`: the reply was lost and the node's window passed; its batch slot is
 * free while the run keeps reading its reports. `ambiguous`: the run stopped
 * watching without learning the outcome; a later report is still recorded.
 */
export type NodeRunState = 'pending' | 'requested' | 'watching' | 'ambiguous' | 'confirmed' | 'reverted' | 'failed' | 'refused' | 'skipped';
/** `partial`: no evidence against the release, but some nodes need attention. `failed`: evidence against the release. */
export type RunStatus = 'running' | 'succeeded' | 'partial' | 'failed' | 'stopped' | 'interrupted';

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
  /** Whether a problem here is evidence about the release or about this node. */
  failureClass?: UpgradeFailureClass | null;
  /** Requests sent to this node; above 1 after an end-of-wave retry. */
  attempts?: number;
}

/** A node someone has to look at when the run ends. */
export interface RunAttention {
  nodeId: string;
  name: string;
  state: NodeRunState | 'excluded';
  code: string;
  failureClass: UpgradeFailureClass;
  detail: string | null;
  cause: string;
  remedy: string;
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
  excluded?: Array<{ nodeId: string; name: string; reason: string; code?: string | null }>;
  /** Release failures that stop the run (MAGNUS_AGENT_UPGRADE_MAX_FAILURES, or this run's override). */
  maxFailures?: number;
  /** Every node needing attention, with a code and a remedy. Filled when the run ends. */
  attention?: RunAttention[];
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
    try { return await remote(); } catch (error) {
      warnOnce(`run store: ${error instanceof Error ? error.message : String(error)}`);
      return local();
    }
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
  check: (nodeId: string, run: UpgradeRun) => Promise<string | { reason: string; code: string | null } | null>;
  /** A retry sends a new request id, since a command id can own only one lease; reports for it must find the run. */
  index?: (run: UpgradeRun) => Promise<void>;
  /** The agent's preflight report and what it says about the node; absent in callers with no agents to ask. */
  preflight?: (target: PreflightTarget, query: PreflightQuery) => Promise<NodePreflight>;
  /** Repair what the server owns (fence generations, leases with no trace on the agent). */
  heal?: (target: PreflightTarget, preflight: NodePreflight) => Promise<{ healed: string[]; problems: PreflightProblem[] }>;
  /** A node confirmed after its reply was lost: read its signed receipt, so the lease of that request does not stay held. */
  settleLostReply?: (nodeId: string, requestId: string) => Promise<void>;
  /** Whether this request's lease settled. A held lease makes a retry pointless: admission would refuse it. */
  leaseSettled?: (nodeId: string, requestId: string) => Promise<boolean>;
  /** Waits before each end-of-wave retry. */
  retryBackoffMs?: readonly number[];
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
      if (!candidate) return { reason: 'node is no longer in the inventory', code: 'NODE_NOT_FOUND' };
      return candidate.eligible ? null : { reason: candidate.reason ?? 'not eligible', code: candidate.code };
    },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
    save: run => store.save(run),
    stopRequested: async runId => await store.stopRequested(runId).catch(() => null),
    confirmTimeoutMs: confirmWindowMs(null),
    pollMs: POLL_MS,
    index: run => store.index(run),
    leaseSettled: async (_nodeId, requestId) => {
      const lease = await getDb().commandResourceLease.findUnique({ where: { commandId: `agent-upgrade-${requestId}` }, select: { state: true } });
      return !lease || lease.state === 'released';
    },
    settleLostReply: async (nodeId, requestId) => {
      const node = await getDb().node.findUnique({ where: { id: nodeId }, select: { id: true, ipAddress: true, port: true } });
      // Settles through the signed result of the receipt; a receipt without one changes nothing.
      if (node) await clientFor(node).getCommandReceipt(`agent-upgrade-${requestId}`);
    },
    preflight: (target, query) => preflightNode(target, query),
    heal: (target, preflight) => healNode(target, preflight),
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
    const remedy = upgradeRemedy(agentCode);
    // A 5xx with no code of ours says nothing about how far the request got.
    if (remedy.ambiguous || (!error.code && error.agentStatus >= 500)) return { kind: 'unknown', code: agentCode === `HTTP_${error.agentStatus}` ? 'MUTATION_OUTCOME_UNKNOWN' : agentCode, message };
    if (remedy.class === 'release') return { kind: 'failed', code: agentCode, message };
    return { kind: 'refused', code: agentCode, message };
  }
  if (error instanceof DispatchOutcomeUnknownError) return { kind: 'unknown', code: error.code, message };
  return { kind: 'unknown', code: typeof code === 'string' ? code : 'MUTATION_OUTCOME_UNKNOWN', message };
}

const audit = (action: AuditAction, run: UpgradeRun, details: Record<string, unknown>, targetType = 'fleet', targetId = run.id) =>
  logAuditEvent({ action, actorId: run.actorId, targetType, targetId, details: { runId: run.id, version: run.version, ...details } }).catch(() => undefined);

/** Shared by the batches of one run and the watches they outlive. */
interface RunContext {
  /** Watches of ambiguous nodes that gave up their batch slot. */
  watchers: Set<Promise<void>>;
  /** The run ended: remaining watches stop, and heartbeat reports take over. */
  closed: boolean;
  /** What a node's last attempt ended as, while an automatic retry is under way. */
  retrying: Map<string, { state: NodeRunState; code: string | null; detail: string | null }>;
}

/** Ask one node to upgrade and wait for its confirmed (or reverted) report. An ambiguous node holds its slot only for its window. */
async function upgradeOne(run: UpgradeRun, entry: RunNode, deps: UpgradeDeps, context: RunContext): Promise<void> {
  const iso = () => new Date(deps.now()).toISOString();
  const end = (state: NodeRunState, detail: string | null, code: string | null = null, awaitingReport = false) => {
    Object.assign(entry, { state, detail: detail?.slice(0, 1000) ?? null, code, finishedAt: iso(), awaitingReport, failureClass: code ? upgradeRemedy(code).class : null });
    if (state === 'refused' || state === 'failed' || (state === 'confirmed' && detail?.startsWith('confirmed by version')))
      void audit(`agent.upgrade.node_${state}` as AuditAction, run, { node: entry.name, requestId: entry.requestId, code, detail }, 'node', entry.nodeId);
  };
  let verdict: Awaited<ReturnType<UpgradeDeps['check']>>;
  try {
    verdict = await deps.check(entry.nodeId, run);
  } catch (error) {
    verdict = { reason: `eligibility check failed: ${error instanceof Error ? error.message : String(error)}`, code: 'CHECK_FAILED' };
  }
  if (verdict) {
    const skipped = typeof verdict === 'string' ? { reason: verdict, code: 'NOT_ELIGIBLE' } : { reason: verdict.reason, code: verdict.code ?? 'NOT_ELIGIBLE' };
    // A retry that cannot go ahead says so, and the node keeps what its real attempt ended as.
    const prior = context.retrying.get(entry.nodeId);
    if (prior && prior.state === 'refused') return void Object.assign(entry, { ...prior, detail: `${prior.detail ?? ''}; not tried again: ${skipped.reason}`.slice(0, 1000), failureClass: prior.code ? upgradeRemedy(prior.code).class : null, finishedAt: iso() });
    return void Object.assign(entry, { state: 'skipped', detail: skipped.reason, code: skipped.code, failureClass: upgradeRemedy(skipped.code).class, finishedAt: iso() });
  }
  entry.state = 'requested';
  entry.attempts = (entry.attempts ?? 0) + 1;
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
  let freeSlot: () => void = () => undefined;
  const slot = new Promise<void>(resolve => { freeSlot = resolve; });
  const watch = watchNode(run, entry, deps, context, end, startedAt, unknown, freeSlot).catch((error: unknown) => {
    end(unknown ? 'ambiguous' : 'failed', `watching this node failed: ${error instanceof Error ? error.message : String(error)}`, unknown?.code ?? 'CONFIRM_TIMEOUT', true);
  }).finally(() => { freeSlot(); context.watchers.delete(watch); });
  context.watchers.add(watch);
  await slot;
}

/** Follow one dispatched node until it reports. `freeSlot` runs once an ambiguous node has had its window. */
async function watchNode(run: UpgradeRun, entry: RunNode, deps: UpgradeDeps, context: RunContext,
  end: (state: NodeRunState, detail: string | null, code?: string | null, awaitingReport?: boolean) => void,
  startedAt: number, unknown: DispatchFailure | null, freeSlot: () => void): Promise<void> {
  let windowMs = deps.confirmTimeoutMs;
  let versionSince: number | null = null;
  let lastHeartbeat: Date | null = null;
  const deadline = () => Math.max(startedAt + windowMs + (unknown ? UNKNOWN_DISPATCH_MARGIN_MS : 0),
    versionSince === null ? 0 : versionSince + windowMs + deps.pollMs);
  while (deps.now() < deadline() && !context.closed) {
    await deps.sleep(deps.pollMs);
    if (context.closed) return;
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
      if (upgrade.state === 'confirmed') {
        if (unknown) await deps.settleLostReply?.(entry.nodeId, entry.requestId).catch((error: unknown) => {
          console.warn(`[agent-upgrade] lease of ${entry.name} stays held: ${error instanceof Error ? error.message : String(error)}`);
        });
        return end('confirmed', unknown ? 'confirmed (the reply to the request was lost)' : null);
      }
      if (upgrade.state === 'reverted') return end('reverted', upgrade.reason ?? 'the agent switched back to its previous version', 'SELF_UPGRADE_REVERTED');
      if (upgrade.state === 'failed') return end('failed', upgrade.reason ?? 'the agent reported the upgrade as failed', 'SELF_UPGRADE_FAILED');
    } else if (!upgrade?.requestId && version === run.version) {
      // Agents that do not report request ids: the version has to hold for one full trial window.
      versionSince ??= deps.now();
      if (deps.now() - versionSince >= windowMs) return end('confirmed', 'confirmed by version (the agent does not report upgrade requests)');
    } else {
      versionSince = null;
    }
    if (unknown) {
      // Past the window the wave goes on without this node; its reports are still read here.
      if (deps.now() - startedAt >= windowMs && entry.state === 'requested') {
        Object.assign(entry, { state: 'watching', code: unknown.code, failureClass: 'node', awaitingReport: true,
          detail: `outcome unknown (${unknown.message}); still watching this request's reports` });
        freeSlot();
        await deps.save(run);
      }
      continue;
    }
    // Silent for longer than the agent's own trial window: it will not confirm, even if the extended deadline is not up.
    if (lastHeartbeat && deps.now() - lastHeartbeat.getTime() > windowMs)
      return end('failed', `no heartbeat since ${lastHeartbeat.toISOString()}`, 'AGENT_SILENT', true);
  }
  if (context.closed) return;
  const minutes = Math.round((deadline() - startedAt) / 60_000);
  if (unknown) return end('ambiguous', `outcome unknown (${unknown.message}); no report for this request within ${minutes} min`, unknown.code, true);
  end('failed', `no confirmation within ${minutes} min`, 'CONFIRM_TIMEOUT', true);
}

/** "N confirmed, N refused, N failed, N skipped" and each refusal reason. */
export function summarizeRun(run: UpgradeRun): string {
  const count = (state: NodeRunState) => run.nodes.filter(node => node.state === state).length;
  const reverted = count('reverted');
  const ambiguous = count('ambiguous') + count('watching');
  const refused = run.nodes.filter(node => node.state === 'refused');
  return `${count('confirmed')} confirmed, ${refused.length} refused, ${count('failed')} failed, ${reverted ? `${reverted} reverted, ` : ''}${ambiguous ? `${ambiguous} unknown, ` : ''}${count('skipped')} skipped`
    + (refused.length ? `; refused: ${refused.map(node => `${node.name} (${node.code ? `${node.code}: ` : ''}${node.detail ?? 'no reason given'})`).join('; ')}` : '');
}

const isReleaseFailure = (node: RunNode) => (node.state === 'failed' || node.state === 'reverted') && upgradeRemedy(node.code).class === 'release';

/** An expected state: a refusal or skip whose code says the node needs nobody. */
const isExpected = (node: RunNode) => (node.state === 'refused' || node.state === 'skipped') && Boolean(node.code && upgradeRemedy(node.code).informational);

/** Every selected node someone has to look at: everything not confirmed, unless its code says it is expected. */
export function attentionList(run: UpgradeRun): RunAttention[] {
  const item = (node: { nodeId: string; name: string }, state: RunAttention['state'], code: string, detail: string | null): RunAttention => {
    const remedy = upgradeRemedy(code);
    return { nodeId: node.nodeId, name: node.name, state, code, failureClass: remedy.class, detail, cause: remedy.cause, remedy: remedy.remedy };
  };
  return [
    ...run.nodes.filter(node => node.state !== 'confirmed' && !isExpected(node)).map(node => item(node, node.state, node.code ?? 'NOT_REACHED', node.detail)),
    ...(run.excluded ?? []).filter(node => !(node.code && upgradeRemedy(node.code).informational)).map(node => item(node, 'excluded', node.code ?? 'NOT_ELIGIBLE', node.reason)),
  ];
}

/**
 * Evidence against the release decides first; then whether any node still needs
 * someone. `succeeded` means every selected node is confirmed or has an
 * informational reason; finish and late reports both come through here.
 */
export function finalStatus(run: UpgradeRun): RunStatus {
  if (run.nodes.some(isReleaseFailure)) return 'failed';
  return attentionList(run).length ? 'partial' : 'succeeded';
}

/**
 * Canary first, then batches of `concurrency`. Until a node confirms, nodes go
 * one at a time: any release failure stops the run, and a node-level problem
 * hands the canary role to the next node. After that the run stops only at an
 * integrity or source failure, or when release failures reach the budget.
 * Transient refusals are tried again at the end, and the run ends once the
 * nodes it still watches have reported or run out of time.
 */
export async function executeUpgradeRun(run: UpgradeRun, deps: UpgradeDeps): Promise<UpgradeRun> {
  const context: RunContext = { watchers: new Set(), closed: false, retrying: new Map() };
  const budget = run.maxFailures ?? DEFAULT_MAX_FAILURES;
  const finish = async (status: RunStatus, message: string) => {
    context.closed = true;
    const at = new Date(deps.now()).toISOString();
    for (const node of run.nodes) {
      if (node.state === 'pending') Object.assign(node, { state: 'skipped', detail: status === 'stopped' ? 'run stopped' : 'not reached', code: status === 'stopped' ? 'RUN_STOPPED' : 'NOT_REACHED' });
      if (node.state === 'watching') Object.assign(node, { state: 'ambiguous', finishedAt: at, detail: `${node.detail ?? 'outcome unknown'}; a later report is recorded here` });
    }
    run.status = status;
    run.summary = summarizeRun(run);
    run.attention = attentionList(run);
    run.message = `${message} (${run.summary})`;
    run.finishedAt = at;
    await deps.save(run);
    await audit(status === 'stopped' ? 'agent.upgrade_run.stopped' : 'agent.upgrade_run.finished', run, { status, summary: run.summary,
      stoppedBy: run.stopRequestedBy ?? null, attention: run.attention.map(node => `${node.name}: ${node.code}`).slice(0, 50) });
    return run;
  };
  const pending = () => run.nodes.filter(node => node.state === 'pending');
  const confirmed = () => run.nodes.filter(node => node.state === 'confirmed');
  const stopped = async () => {
    const actor = await deps.stopRequested(run.id).catch(() => null);
    if (actor) run.stopRequestedBy = actor;
    return actor;
  };
  /** A node that gave up waiting may have reported since: the stored report is the same on every server. */
  const readLateReports = async () => {
    for (const node of run.nodes.filter(entry => entry.awaitingReport && entry.state !== 'watching')) {
      const upgrade = await deps.observe(node.nodeId).then(observation => observation.report?.upgrade, () => null);
      if (upgrade?.requestId !== node.requestId) continue;
      if (upgrade.state === 'confirmed' || upgrade.state === 'reverted' || upgrade.state === 'failed') applyLateOutcome(node, upgrade.state, upgrade.reason ?? null);
    }
  };
  const leaseSettled = (node: RunNode) => (deps.leaseSettled?.(node.nodeId, node.requestId) ?? Promise.resolve(true)).catch((error: unknown) => {
    console.warn(`[agent-upgrade] lease of ${node.name} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  });
  const stoppedByOperator = () => finish('stopped', `stopped by ${run.stopRequestedBy}`);
  const describe = (node: RunNode) => `${node.name} (${node.code ?? node.state}: ${node.detail ?? ''})`;
  /** What the evidence so far says: null, or why the run ends now. */
  const evidenceStop = (canaryPhase: boolean) => {
    const failures = run.nodes.filter(isReleaseFailure);
    const fatal = failures.find(node => upgradeRemedy(node.code).stopsRun);
    if (fatal) return finish('failed', `${describe(fatal)}: every node gets the same artifact, so the run stopped`);
    if (canaryPhase && failures[0]) return finish('failed', `canary ${failures[0].name} did not confirm (${failures[0].code}: ${failures[0].detail ?? ''}); the other nodes were not touched`);
    if (failures.length >= budget) return finish('failed', `${failures.length} release failure(s) reached the budget of ${budget}: ${failures.slice(0, 5).map(describe).join('; ')}; remaining nodes were skipped`);
    return null;
  };
  /** Work through the pending nodes; a returned promise means the run ended. */
  const drain = async (): Promise<UpgradeRun | null> => {
    for (let queue = pending(); queue.length; queue = pending()) {
      if (await stopped()) return stoppedByOperator();
      const canaryPhase = confirmed().length === 0;
      const batch = queue.slice(0, canaryPhase ? 1 : run.concurrency);
      if (canaryPhase) run.canaryNodeId = batch[0]!.nodeId;
      await Promise.all(batch.map(node => upgradeOne(run, node, deps, context)));
      await deps.save(run);
      await readLateReports();
      const stop = evidenceStop(canaryPhase && confirmed().length === 0);
      if (stop) return stop;
    }
    return null;
  };
  try {
    if (!run.nodes.length) return await finish(finalStatus(run), 'no eligible nodes');
    let ended = await drain();
    if (ended) return ended;
    // Refusals that clear by themselves, once or twice, with a pause. Never anything ambiguous or release-class.
    for (const wait of deps.retryBackoffMs ?? AUTO_RETRY_BACKOFF_MS) {
      const transient = run.nodes.filter(node => (node.state === 'refused' || node.state === 'skipped') && node.code && upgradeRemedy(node.code).transient);
      // A lease still held makes a retry pointless: admission would refuse it, and hide why with LEASE_HELD.
      const again: RunNode[] = [];
      for (const node of transient) {
        if (await leaseSettled(node)) again.push(node);
        else if (!node.detail?.includes(LEASE_HELD_NOTE)) node.detail = `${node.detail ?? ''}; ${LEASE_HELD_NOTE}`.slice(0, 1000);
      }
      if (!again.length) break;
      await deps.sleep(wait);
      if (await stopped()) return await stoppedByOperator();
      // A command id owns one lease for good, so each attempt is a new request.
      for (const node of again) {
        context.retrying.set(node.nodeId, { state: node.state, code: node.code ?? null, detail: node.detail });
        Object.assign(node, { state: 'pending', requestId: randomUUID(), detail: null, code: null, failureClass: null, finishedAt: null, dispatchedAt: null });
      }
      await deps.index?.(run);
      await deps.save(run);
      ended = await drain();
      if (ended) return ended;
    }
    // Nodes whose reply was lost keep their chance to report; their late outcomes still count.
    while (context.watchers.size) {
      await deps.sleep(deps.pollMs);
      if (await stopped()) return await stoppedByOperator();
      await readLateReports();
      const stop = evidenceStop(confirmed().length === 0);
      if (stop) return await stop;
    }
    await readLateReports();
    const upgraded = confirmed().length;
    const status = finalStatus(run);
    return await finish(status, status === 'succeeded' ? `${upgraded} agent(s) upgraded to ${run.version}`
      : status === 'failed' ? `${run.nodes.filter(isReleaseFailure).length} node(s) failed in a way that points at the release; ${upgraded} agent(s) upgraded`
      : upgraded ? `${upgraded} agent(s) upgraded to ${run.version}; ${run.attention?.length ?? attentionList(run).length} node(s) need attention`
      : `no agent was upgraded; ${attentionList(run).length} node(s) need attention, and nothing points at the release`);
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
    if (node.state === 'pending') Object.assign(node, { state: 'skipped', detail: 'run interrupted before this node', code: 'NOT_REACHED', finishedAt: at });
    if (node.state !== 'requested' && node.state !== 'watching') continue;
    const upgrade = await observe(node.nodeId).then(observation => observation.report?.upgrade, () => null);
    const mine = upgrade?.requestId === node.requestId ? upgrade : null;
    if (mine?.state === 'confirmed') Object.assign(node, { state: 'confirmed', detail: 'confirmed (recorded after the run was interrupted)', code: null, failureClass: null, awaitingReport: false });
    else if (mine?.state === 'reverted') Object.assign(node, { state: 'reverted', detail: mine.reason ?? 'the agent switched back', code: 'SELF_UPGRADE_REVERTED', failureClass: 'release', awaitingReport: false });
    else if (mine?.state === 'failed') Object.assign(node, { state: 'failed', detail: mine.reason ?? 'the agent reported a failure', code: 'SELF_UPGRADE_FAILED', failureClass: 'release', awaitingReport: false });
    else Object.assign(node, { state: 'ambiguous', code: 'RUN_INTERRUPTED', failureClass: 'node', awaitingReport: true,
      detail: `the server stopped watching${mine ? ` while the agent reported ${mine.state}` : ''}; a later report for this request is recorded here` });
    node.finishedAt = at;
  }
  run.status = 'interrupted';
  run.summary = summarizeRun(run);
  run.attention = attentionList(run);
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
  /** This run's budget of release failures (default MAGNUS_AGENT_UPGRADE_MAX_FAILURES). */
  maxFailures?: number;
  actorId: string;
  deps?: UpgradeDeps;
  store?: RunStore;
}

const latestPreflights = new Map<string, { version: string; preflight: NodePreflight }>();

/** The newest result per node for this version, for the eligibility list. Older ones say nothing about now. */
export function withCachedPreflight(candidates: UpgradeCandidate[], version: string, now = Date.now()): UpgradeCandidate[] {
  return candidates.map(candidate => {
    const cached = latestPreflights.get(candidate.nodeId);
    return cached?.version === version && now - Date.parse(cached.preflight.checkedAt) < PREFLIGHT_CACHE_MS ? { ...candidate, preflight: cached.preflight } : candidate;
  });
}

export interface CheckOptions {
  /** Also ask nodes a run would leave alone anyway, such as ones already on the target. */
  everyOnlineNode?: boolean;
  /** Repair what the server owns before judging: fence generations, leases with no trace on the agent. */
  heal?: boolean;
  allowRetryReverted?: boolean | undefined;
}

/**
 * Who can take `release` now: the read-only admission predicates, then each
 * agent's preflight report. A blocked node carries its reason and code, and the
 * others proceed. Nothing here takes a lease; without `heal` it changes nothing.
 */
export async function checkCandidates(release: Pick<AgentRelease, 'version' | 'engines'>, nodeIds: readonly string[] | undefined, deps: Pick<UpgradeDeps, 'preflight' | 'heal'>,
  options: CheckOptions = {}): Promise<UpgradeCandidate[]> {
  const list = () => listUpgradeCandidates(release.version, nodeIds, { allowRetryReverted: options.allowRetryReverted });
  let candidates = await list();
  const ask = deps.preflight;
  if (!ask) return candidates;
  const askable = (candidate: UpgradeCandidate) => candidate.code !== 'NODE_OFFLINE' && candidate.code !== 'VERSION_UNKNOWN'
    && (options.everyOnlineNode || candidate.eligible || candidate.code === 'LEASE_HELD');
  const rows = candidates.filter(askable);
  const hostnames = await hostnamesOf(rows.map(candidate => candidate.nodeId));
  const target = (candidate: UpgradeCandidate): PreflightTarget => ({ nodeId: candidate.nodeId, hostname: hostnames.get(candidate.nodeId) ?? '', managed: candidate.managed ?? false });
  const query: PreflightQuery = { target: release.version, engines: release.engines ?? null };
  const results = new Map(await mapLimit(rows, PREFLIGHT_CONCURRENCY, async candidate => {
    let preflight = await ask(target(candidate), query).catch((error: unknown): NodePreflight => ({ status: 'unreachable', checkedAt: new Date().toISOString(), problems: [],
      detail: error instanceof Error ? error.message : String(error) }));
    if (options.heal && deps.heal && (preflight.report || candidate.code === 'LEASE_HELD')) {
      const repaired = await deps.heal(target(candidate), preflight).catch((error: unknown) => {
        console.warn(`[agent-upgrade] repair of ${candidate.name} failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      if (repaired) preflight = { ...preflight, problems: repaired.problems, status: preflight.report ? preflightStatus(repaired.problems) : preflight.status,
        ...(repaired.healed.length ? { healed: repaired.healed } : {}) };
    }
    latestPreflights.set(candidate.nodeId, { version: release.version, preflight });
    return [candidate.nodeId, preflight] as const;
  }));
  if ([...results.values()].some(preflight => preflight.healed?.length)) candidates = await list();
  return candidates.map(candidate => {
    const preflight = results.get(candidate.nodeId);
    if (!preflight) return candidate;
    const blocker = preflight.problems.find(problem => problem.blocking);
    return { ...candidate, preflight, ...(candidate.eligible && blocker ? { eligible: false, reason: blocker.detail, code: blocker.code } : {}) };
  });
}

async function hostnamesOf(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await getDb().node.findMany({ where: { id: { in: ids } }, select: { id: true, hostname: true } });
  return new Map(rows.map(row => [row.id, row.hostname ?? '']));
}

export interface UpgradeCheckReport {
  version: string;
  release: ReleaseVerification;
  eligible: number;
  blocked: number;
  nodes: Array<UpgradeCandidate & { cause: string | null; remedy: string | null }>;
}

/** The dry run behind `dryRun`, the console's Check and `agents doctor`: the full per-node report, before anything starts. */
export async function checkUpgrade(options: Pick<StartRunOptions, 'version' | 'integrity' | 'nodeIds' | 'allowRetryReverted' | 'deps'> & { heal?: boolean; everyOnlineNode?: boolean }): Promise<UpgradeCheckReport> {
  const version = options.version ?? AGENT_VERSION;
  if (!isVersion(version)) throw new HttpError(400, 'INVALID_VERSION', `${version} is not an X.Y.Z version`);
  let release: ReleaseVerification;
  let engines: string | null = null;
  try {
    const resolved = await resolveAgentRelease({ version, integrity: options.integrity });
    release = { verified: true, integrity: resolved.integrity, reason: null };
    engines = resolved.engines ?? null;
  } catch (error) {
    // The nodes can still be judged without knowing the release's engines.
    release = { verified: false, integrity: null, reason: error instanceof Error ? error.message : String(error) };
  }
  const deps = options.deps ?? defaultDeps();
  const candidates = await checkCandidates({ version, engines }, options.nodeIds, deps, { everyOnlineNode: options.everyOnlineNode ?? true, heal: options.heal ?? false, allowRetryReverted: options.allowRetryReverted });
  const nodes = candidates.map(candidate => {
    const remedy = candidate.code ? upgradeRemedy(candidate.code) : null;
    return { ...candidate, cause: remedy?.cause ?? null, remedy: remedy?.remedy ?? null };
  });
  return { version, release, eligible: nodes.filter(node => node.eligible).length, blocked: nodes.filter(node => !node.eligible && node.code && !upgradeRemedy(node.code).informational).length, nodes };
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
    const baseDeps = options.deps ?? defaultDeps(store);
    const deps: UpgradeDeps = { ...baseDeps, index: baseDeps.index ?? (next => store.index(next)) };
    // Checking a large fleet can outlast the lock's TTL.
    const holdLock = setInterval(() => void store.renew(token).catch(() => false), LEASE_MS / 3);
    holdLock.unref?.();
    let candidates: UpgradeCandidate[];
    try {
      candidates = await checkCandidates(release, options.nodeIds, deps, { heal: true, allowRetryReverted: options.allowRetryReverted });
    } finally {
      clearInterval(holdLock);
    }
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
    const run: UpgradeRun = {
      id, version: release.version, integrity: release.integrity, actorId: options.actorId, status: 'running',
      startedAt: new Date(deps.now()).toISOString(), finishedAt: null, concurrency: settings.agentUpgradeConcurrency, message: null, summary: null,
      canaryNodeId: eligible[0]!.nodeId, owner: INSTANCE_ID, leaseExpiresAt: new Date(deps.now() + LEASE_MS).toISOString(), stopRequestedBy: null,
      retryOf: options.retryOf ?? null, allowRetryReverted: options.allowRetryReverted ?? false,
      maxFailures: options.maxFailures ?? settings.agentUpgradeMaxFailures,
      excluded: candidates.filter(candidate => !candidate.eligible).map(candidate => ({ nodeId: candidate.nodeId, name: candidate.name, reason: candidate.reason ?? 'not eligible', code: candidate.code })),
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
  const retry = new Set<NodeRunState>(['failed', 'refused', 'skipped', 'requested', 'watching', 'ambiguous', ...options.allowRetryReverted ? ['reverted' as const] : []]);
  // Nodes the preflight held back come back too: what blocked them may be repaired now.
  const nodeIds = [...previous.nodes.filter(node => retry.has(node.state)).map(node => node.nodeId),
    ...(previous.excluded ?? []).filter(node => node.code && !upgradeRemedy(node.code).informational).map(node => node.nodeId)];
  if (!nodeIds.length) throw new HttpError(409, 'NOTHING_TO_RETRY', `Run ${id} has no failed, refused, skipped or interrupted nodes${options.allowRetryReverted ? '' : ' (reverted nodes need allowRetryReverted)'}`);
  return startUpgradeRun({ ...options, store, version: previous.version, integrity: previous.integrity, nodeIds, retryOf: previous.id,
    maxFailures: options.maxFailures ?? previous.maxFailures,
    allowPrerelease: options.allowPrerelease ?? isPrerelease(previous.version) });
}
