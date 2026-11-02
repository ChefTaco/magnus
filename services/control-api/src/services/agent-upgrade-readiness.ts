/**
 * Whether a node could take an agent upgrade, all the time and not just when
 * one starts. Pure evaluation of what the agent's heartbeat reports against the
 * server's own state, so an operator sees drift weeks before an upgrade, and a
 * monitor that notifies when a node has been not ready for a day.
 */
import { compareVersions, isVersion, upgradeRemedy } from '@hivemagnus/magnus-contracts';
import { getDb } from '../db/index.js';
import { SENTINEL_NODE_IDS } from '../utils/sentinel-nodes.js';
import { recoverNodeLeases } from './agent-upgrade-preflight.js';
import { storedSelfUpgrade } from './agent-upgrade-service.js';
import { checkReportedFence, fenceIsAhead, isOwnFenceKey } from './command-fence-repair.js';
import { ABSENT_RECEIPT_MARGIN_MS, HELD_RESOURCE_STATES } from './command-resource-leases.js';
import { enrollmentIsComplete } from './resource-enrollment.js';
import { createNotificationInTransaction } from './notification-service.js';
import { matchingMaintenance } from './maintenance-service.js';

export interface ReadinessProblem { code: string; detail: string; cause: string; remedy: string }

export interface UpgradeReadiness {
  /** `unknown`: the agent does not report what this needs (older than 1.1.8, or no report yet). */
  status: 'ok' | 'not-ready' | 'unknown';
  problems: ReadinessProblem[];
  /** When the node's report was taken. */
  observedAt: string | null;
}

export interface ReadinessInput {
  id: string;
  hostname: string;
  metadata: string | null | undefined;
  enrollment?: { state: string; nodeFqdn: string; startedAt: Date | null; updatedAt: Date } | null;
  generations?: Readonly<Record<string, bigint>>;
  heldLeases?: number;
  now?: number;
}

const DAY_MS = 24 * 60 * 60_000;

const problem = (code: string, detail: string): ReadinessProblem => {
  const { cause, remedy } = upgradeRemedy(code);
  return { code, detail, cause, remedy };
};

export function computeUpgradeReadiness(input: ReadinessInput): UpgradeReadiness {
  const now = input.now ?? Date.now();
  const report = storedSelfUpgrade(input.metadata);
  const problems: ReadinessProblem[] = [];
  const enrollment = input.enrollment ?? null;
  if (enrollment?.state === 'draining') {
    const since = enrollment.startedAt ?? enrollment.updatedAt;
    problems.push(problem('ENROLLMENT_DRAINING', `resource enrollment has been draining for ${Math.floor((now - since.getTime()) / DAY_MS)} day(s), since ${since.toISOString().slice(0, 10)}`));
  }
  if (report?.managedEnrollmentState === 'unknown') problems.push(problem('ENROLLMENT_MARKER_UNKNOWN', 'the agent could not read its managed-enrollment marker'));
  const marker = report?.managedEnrollment;
  if (marker && (!enrollmentIsComplete(enrollment, marker.nodeFqdn) || marker.nodeId !== input.id || marker.nodeFqdn !== input.hostname))
    problems.push(problem('ENROLLMENT_MARKER_MISMATCH', `the agent holds a managed-enrollment marker for ${marker.nodeFqdn}, but the server has ${enrollment ? `a ${enrollment.state} enrollment for ${enrollment.nodeFqdn}` : 'no enrollment row'}`));
  for (const [key, value] of Object.entries(report?.fenceHighWater ?? {})) {
    if (!isOwnFenceKey(input.id, key)) continue;
    const check = checkReportedFence(input.id, key, value);
    if (!check.ok) problems.push(problem(check.code, `the agent ${check.detail}`));
    else if (fenceIsAhead(check.value, input.generations?.[key] ?? 0n))
      problems.push(problem('FENCE_AHEAD', `the agent holds fence ${value} for ${key}; the server's generation is ${(input.generations?.[key] ?? 0n).toString()}`));
  }
  const ledger = report?.ledger;
  if (ledger && !ledger.readable) problems.push(problem('LEDGER_UNAVAILABLE', ledger.error ?? 'the agent cannot read its command ledger'));
  else if (ledger?.unresolvedReceipts) problems.push(problem('LEDGER_UNRESOLVED', `${ledger.unresolvedReceipts} receipt(s) in the agent ledger have no terminal outcome${ledger.activeLock ? `; active.lock is held by ${ledger.activeLock.commandId}` : ''}`));
  if (input.heldLeases) problems.push(problem('LEASE_HELD', `${input.heldLeases} command lease(s) are reserved, running or unknown`));
  if (report?.disk?.low) problems.push(problem('PREFLIGHT_DISK_LOW', `${Math.floor(report.disk.freeBytes / (1024 * 1024))} MiB free in the install directory; an upgrade needs ${Math.floor(report.disk.requiredBytes / (1024 * 1024))} MiB`));
  if (report?.npm && (!report.npm.present || report.npm.problem)) problems.push(problem('PREFLIGHT_NPM', report.npm.problem ?? 'npm is missing on this node'));
  const reportsDrift = Boolean(report && (report.ledger || report.disk || report.npm));
  return { status: problems.length ? 'not-ready' : reportsDrift ? 'ok' : 'unknown', problems, observedAt: report?.observedAt ?? null };
}

/** Readiness of many nodes at once, for list pages: one query per kind of server state. Never fails a page. */
export async function readinessOfNodes(nodes: ReadonlyArray<{ id: string; hostname: string; metadata: string | null | undefined }>, now = Date.now()): Promise<Map<string, UpgradeReadiness>> {
  if (!nodes.length) return new Map();
  try {
    const db = getDb();
    const ids = nodes.map(node => node.id);
    const [enrollments, fences, leases] = await Promise.all([
      db.resourceEnrollment.findMany({ where: { nodeId: { in: ids } }, select: { nodeId: true, state: true, nodeFqdn: true, startedAt: true, updatedAt: true } }),
      db.commandResourceFence.findMany({ where: { OR: ids.flatMap(id => [{ resourceKey: `node:${id}` }, { resourceKey: `node:${id}:ardent` }]) } }),
      db.commandResourceLease.groupBy({ by: ['nodeId'], where: { nodeId: { in: ids }, state: { in: [...HELD_RESOURCE_STATES] } }, _count: { _all: true } }),
    ]);
    const generations = Object.fromEntries(fences.map(row => [row.resourceKey, row.generation]));
    return new Map(nodes.map(node => [node.id, computeUpgradeReadiness({ id: node.id, hostname: node.hostname, metadata: node.metadata, now,
      enrollment: enrollments.find(row => row.nodeId === node.id) ?? null, generations,
      heldLeases: leases.find(row => row.nodeId === node.id)?._count._all ?? 0 })]));
  } catch (error) {
    console.warn(`[upgrade-readiness] could not be computed: ${error instanceof Error ? error.message : String(error)}`);
    return new Map();
  }
}

// ── Monitor: notify when a node has been not ready for a day ──

/** A node not ready for this long gets a notification, once per episode. */
export const NOT_READY_NOTIFY_MS = DAY_MS;
const CHECK_INTERVAL_MS = 10 * 60_000;
let timer: ReturnType<typeof setInterval> | null = null;

/** How often one node is asked about its stuck leases. */
export const LEASE_RECOVERY_INTERVAL_MS = 60 * 60_000;
/** The first version whose agents answer the signed trace. Older ones keep their leases until reconciled. */
const TRACE_ROUTE_SINCE = '1.1.8';
const lastLeaseRecovery = new Map<string, number>();
export function resetLeaseRecoveryLimits(): void { lastLeaseRecovery.clear(); }

/**
 * Settle leases nobody will come back for: no run may ever start for a node that
 * already runs the target. Past the deadline plus a margin, on agents that answer
 * the trace, at most once an hour per node; only signed ledger evidence settles
 * one, and each settlement is audited by recoverAbsentLeases.
 */
async function recoverStuckLeases(now: number): Promise<void> {
  const db = getDb();
  const stuck = await db.commandResourceLease.findMany({ where: { state: 'unknown', deadline: { lt: new Date(now - ABSENT_RECEIPT_MARGIN_MS) } }, select: { nodeId: true }, distinct: ['nodeId'] });
  if (!stuck.length) return;
  const nodes = await db.node.findMany({ where: { id: { in: stuck.map(row => row.nodeId) }, status: { in: ['ONLINE', 'DEGRADED'] } }, select: { id: true, name: true, agent: { select: { version: true } } } });
  for (const node of nodes) {
    const version = node.agent?.version ?? '';
    if (!isVersion(version) || compareVersions(version, TRACE_ROUTE_SINCE) < 0) continue;
    if (now - (lastLeaseRecovery.get(node.id) ?? -Infinity) < LEASE_RECOVERY_INTERVAL_MS) continue;
    lastLeaseRecovery.set(node.id, now);
    const results = await recoverNodeLeases(node.id, 'system:upgrade-readiness', now).catch((error: unknown) => {
      console.warn(`[upgrade-readiness] lease recovery on ${node.name} failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    });
    for (const lease of results) if (lease.outcome === 'unverified') console.warn(`[upgrade-readiness] lease ${lease.commandId} on ${node.name} stays held: ${lease.code}: ${lease.detail}`);
  }
}

export async function checkUpgradeReadiness(now = Date.now()): Promise<void> {
  const db = getDb();
  await recoverStuckLeases(now).catch((error: unknown) => console.warn(`[upgrade-readiness] lease recovery failed: ${error instanceof Error ? error.message : String(error)}`));
  const nodes = await db.node.findMany({ where: { id: { notIn: SENTINEL_NODE_IDS }, status: { in: ['ONLINE', 'DEGRADED'] } }, select: { id: true, name: true, hostname: true, metadata: true } });
  const readiness = await readinessOfNodes(nodes, now);
  for (const node of nodes) {
    const state = readiness.get(node.id);
    if (!state) continue;
    const metadata = parseMetadata(node.metadata);
    const since = typeof metadata['upgradeNotReadySince'] === 'string' ? metadata['upgradeNotReadySince'] : null;
    // Read again right before writing: heartbeats keep their report in the same column.
    const patch = async (change: (current: Record<string, unknown>) => Record<string, unknown>) => {
      const row = await db.node.findUnique({ where: { id: node.id }, select: { metadata: true } });
      await db.node.update({ where: { id: node.id }, data: { metadata: JSON.stringify(change(parseMetadata(row?.metadata))) } });
    };
    if (state.status !== 'not-ready') {
      if (since) await patch(withoutEpisode);
      continue;
    }
    if (!since) {
      await patch(current => ({ ...current, upgradeNotReadySince: new Date(now).toISOString() }));
      continue;
    }
    if (metadata['upgradeNotReadyNotifiedAt'] || now - Date.parse(since) < NOT_READY_NOTIFY_MS) continue;
    const maintenance = await matchingMaintenance(node.id);
    await db.$transaction(async tx => {
      await createNotificationInTransaction(tx, {
        type: 'node.upgrade_not_ready', severity: 'warning', title: `${node.name} could not take an agent upgrade`,
        message: `Not ready since ${since}: ${state.problems.map(item => `${item.code}: ${item.detail}. ${item.remedy}`).join(' ')}`.slice(0, 2000),
        nodeId: node.id, nodeName: node.name, metadata: { since, codes: state.problems.map(item => item.code) },
      }, maintenance?.id ?? null);
    });
    await patch(current => ({ ...current, upgradeNotReadyNotifiedAt: new Date(now).toISOString() }));
  }
}

function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch (error) {
    console.warn(`[upgrade-readiness] node metadata is not JSON: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

function withoutEpisode(metadata: Record<string, unknown>): Record<string, unknown> {
  const { upgradeNotReadySince: _since, upgradeNotReadyNotifiedAt: _notified, ...rest } = metadata;
  return rest;
}

export function startUpgradeReadinessMonitor(): void {
  if (timer) return;
  const run = () => void checkUpgradeReadiness().catch((error: unknown) => console.error(`[upgrade-readiness] check failed: ${error instanceof Error ? error.message : String(error)}`));
  run();
  timer = setInterval(run, CHECK_INTERVAL_MS);
  timer.unref?.();
}

export function stopUpgradeReadinessMonitor(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
