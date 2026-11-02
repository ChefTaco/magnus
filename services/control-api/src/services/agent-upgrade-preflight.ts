/**
 * Exercising the real upgrade path before the first node is touched. The
 * agent's read-only preflight report is held against what an upgrade needs,
 * and against the server's own fences. Pure where it can be, for tests; an
 * agent without the route is `unavailable`, which is not a failure.
 */
import type { AgentSelfUpgradeStatus, AgentUpgradePreflight } from '@hivemagnus/magnus-contracts';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/client.js';
import { fenceProofSigningPayload, verifyCommandEvidence } from '../security/command-result-signature.js';
import { NodeApiClient } from '../sdk/node-api-client.js';
import { getNodeManagerSecret, RESULT_SIGNING_PREVIOUS_SECRET, RESULT_SIGNING_SECRET } from '../utils/env.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { advanceCommandFence, checkReportedFence, fenceIsAhead, isOwnFenceKey } from './command-fence-repair.js';
import { recoverAbsentLeases, type LeaseRecovery } from './command-resource-leases.js';

export interface PreflightProblem {
  code: string;
  detail: string;
  /** Excludes the node from a run. Otherwise it is shown and the node proceeds. */
  blocking: boolean;
}

export type PreflightStatus = 'ok' | 'warning' | 'blocked' | 'unavailable' | 'unreachable';

export interface NodePreflight {
  status: PreflightStatus;
  checkedAt: string;
  problems: PreflightProblem[];
  /** Why there is no report. */
  detail?: string;
  report?: AgentUpgradePreflight;
  /** The agent signed `report.fenceHighWater` for this check's nonce and this node. Without this, nothing moves a fence. */
  fencesVerified?: boolean;
  /** What this check repaired on the server. */
  healed?: string[];
}

export interface PreflightContext {
  nodeId: string;
  hostname: string;
  /** Requests to this node pass through the ledger, so its health decides whether they can run. */
  managed: boolean;
  /** Current server generations by resource key. */
  generations: Readonly<Record<string, bigint>>;
}

/**
 * Why self-upgrade is off, from what the agent says. Only an operator's choice
 * and a layout that cannot do it are expected; anything else is a problem someone
 * has to fix, so it must not read as expected and let a run look finished.
 */
export function selfUpgradeOffCode(report: Pick<AgentSelfUpgradeStatus, 'reasonCode' | 'reason' | 'layout'>): string {
  switch (report.reasonCode) {
    case 'SWITCHED_OFF': case 'CONTAINER': case 'LEGACY_LAYOUT': return 'SELF_UPGRADE_DISABLED';
    case 'NOT_WRITABLE': return 'PREFLIGHT_NOT_WRITABLE';
    case 'NPM': return 'PREFLIGHT_NPM';
    case undefined: case null:
      // An agent older than 1.1.8 sends text only. Its layouts and this one exact string are all it can say safely.
      return report.layout !== 'versioned' || report.reason === 'MAGNUS_AGENT_SELF_UPGRADE=false on this node' ? 'SELF_UPGRADE_DISABLED' : 'SELF_UPGRADE_UNAVAILABLE';
    default: return 'SELF_UPGRADE_UNAVAILABLE';
  }
}

/** Hold a report against what an upgrade needs. A field the agent left out proves nothing either way. */
export function evaluatePreflight(report: AgentUpgradePreflight, context: PreflightContext): PreflightProblem[] {
  const problems: PreflightProblem[] = [];
  const add = (code: string, detail: string, blocking = true) => problems.push({ code, detail, blocking });
  const versioned = report.layout === 'versioned';
  if (report.enabled === false && !versioned) add(selfUpgradeOffCode({ reasonCode: report.reasonCode, reason: report.reason ?? null, layout: report.layout ?? 'legacy' }), report.reason ?? 'self-upgrade is unavailable on this node');
  if (versioned) {
    if (report.writable && !report.writable.ok) add('PREFLIGHT_NOT_WRITABLE', `the agent cannot write ${report.writable.blocked?.join(', ') || 'its install directory'}`);
    if (report.npm && (!report.npm.present || report.npm.problem)) add('PREFLIGHT_NPM', report.npm.problem ?? 'npm is missing');
    if (report.fromVersionComplete === false) add('PREFLIGHT_FROM_INCOMPLETE', `versions/${report.version} is incomplete or ./current does not run it, so a failed upgrade could not switch back`);
    if (report.enabled === false && !report.writable?.blocked?.length && !report.npm?.problem) add(selfUpgradeOffCode({ reasonCode: report.reasonCode, reason: report.reason ?? null, layout: 'versioned' }), report.reason ?? 'self-upgrade is unavailable on this node');
  }
  if (report.disk?.low) add('PREFLIGHT_DISK_LOW', `${mib(report.disk.freeBytes)} MiB free in the install directory; an upgrade needs ${mib(report.disk.requiredBytes)} MiB`);
  if (report.engines?.compatible === false) add('PREFLIGHT_ENGINE', report.engines.problem ?? `the target does not support Node.js ${report.engines.node}`);
  const ledger = report.ledger;
  if (ledger && !ledger.readable) add('LEDGER_UNAVAILABLE', ledger.error ?? 'the command ledger cannot be read', context.managed);
  // A command running right now finishes by itself: it is a busy slot, which dispatch refuses and the end of the wave retries.
  else if (ledger?.activeLock?.receipt === 'running') add('RESOURCE_BUSY', `${ledger.activeLock.commandId} is running on this node right now`, false);
  else if (ledger?.activeLock && !['none', 'completed', 'reconciled'].includes(ledger.activeLock.receipt)) {
    add('LEDGER_UNRESOLVED', `active.lock is held by ${ledger.activeLock.commandId}, whose receipt is ${ledger.activeLock.receipt}`, context.managed);
  } else if (ledger?.unresolvedReceipts) add('LEDGER_UNRESOLVED', `${ledger.unresolvedReceipts} receipt(s) have no terminal outcome`, false);
  const marker = report.managedEnrollment;
  if (report.managedEnrollmentState === 'unknown') add('ENROLLMENT_MARKER_UNKNOWN', 'the agent could not read its managed-enrollment marker');
  if (marker && (marker.nodeId !== context.nodeId || marker.nodeFqdn !== context.hostname))
    add('ENROLLMENT_MARKER_MISMATCH', `the agent's managed-enrollment marker is for ${marker.nodeFqdn} (${marker.nodeId}), not this node`);
  for (const [key, value] of Object.entries(report.fenceHighWater ?? {})) {
    // Keys of other domains are not this node's to report, and nothing here adopts them.
    if (!isOwnFenceKey(context.nodeId, key)) continue;
    const check = checkReportedFence(context.nodeId, key, value);
    if (!check.ok) add(check.code, `the agent ${check.detail}`);
    else if (fenceIsAhead(check.value, context.generations[key] ?? 0n))
      add('FENCE_AHEAD', `the agent holds fence ${value} for ${key}; the server's generation is ${(context.generations[key] ?? 0n).toString()}`, false);
  }
  return problems;
}

const mib = (bytes: number) => Math.floor(bytes / (1024 * 1024));

export function preflightStatus(problems: readonly PreflightProblem[]): PreflightStatus {
  return problems.some(problem => problem.blocking) ? 'blocked' : problems.length ? 'warning' : 'ok';
}

/** Bounded concurrency: one slow agent never delays the others by more than its timeout. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  }));
  return results;
}

export const PREFLIGHT_CONCURRENCY = 16;
export const PREFLIGHT_TIMEOUT_MS = 4_000;

export interface PreflightTarget { nodeId: string; managed: boolean; hostname: string }
export interface PreflightQuery { target: string; engines?: string | null }

function clientFor(node: { id: string; ipAddress: string; port: number }): NodeApiClient {
  return new NodeApiClient({ baseUrl: getNodeBaseUrl(node.ipAddress, node.port), resourceNodeId: node.id, nodeToken: getNodeManagerSecret(),
    resourceActorId: 'system:agent-upgrade', timeout: PREFLIGHT_TIMEOUT_MS });
}

const generationsOf = async (nodeId: string): Promise<Record<string, bigint>> => {
  const rows = await getDb().commandResourceFence.findMany({ where: { OR: [{ resourceKey: `node:${nodeId}` }, { resourceKey: { startsWith: `node:${nodeId}:` } }] } });
  return Object.fromEntries(rows.map(row => [row.resourceKey, row.generation]));
};

/** Ask one agent. Never throws: a node's problem must not stop the check of the others. */
export async function preflightNode(target: PreflightTarget, query: PreflightQuery, options: { timeoutMs?: number; now?: number } = {}): Promise<NodePreflight> {
  const checkedAt = new Date(options.now ?? Date.now()).toISOString();
  try {
    const node = await getDb().node.findUnique({ where: { id: target.nodeId }, select: { id: true, ipAddress: true, port: true } });
    if (!node) return { status: 'unavailable', checkedAt, problems: [], detail: 'node is no longer in the inventory' };
    const nonce = randomUUID();
    const answer = await clientFor(node).getUpgradePreflight({ ...query, nonce }, options.timeoutMs ?? PREFLIGHT_TIMEOUT_MS);
    if (answer.status !== 'ok') return { status: answer.status, checkedAt, problems: [], detail: answer.detail };
    const problems = evaluatePreflight(answer.report, { nodeId: target.nodeId, hostname: target.hostname, managed: target.managed, generations: await generationsOf(target.nodeId) });
    const proof = answer.report.fenceProof;
    const fencesVerified = Boolean(proof && proof.nonce === nonce && proof.nodeFqdn === target.hostname && verifyCommandEvidence(
      fenceProofSigningPayload({ nonce, nodeFqdn: proof.nodeFqdn, fenceHighWater: answer.report.fenceHighWater ?? {} }), proof.signature, RESULT_SIGNING_SECRET, RESULT_SIGNING_PREVIOUS_SECRET));
    return { status: preflightStatus(problems), checkedAt, problems, report: answer.report, fencesVerified };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[agent-upgrade] preflight of ${target.nodeId} failed: ${detail}`);
    return { status: 'unreachable', checkedAt, problems: [], detail };
  }
}

/** Ask one node about its leases stuck `unknown`, and settle what its signed account proves. Safe to repeat. */
export async function recoverNodeLeases(nodeId: string, actorId: string, now = Date.now()): Promise<LeaseRecovery[]> {
  const node = await getDb().node.findUnique({ where: { id: nodeId }, select: { id: true, ipAddress: true, port: true, hostname: true } });
  if (!node) return [];
  const client = clientFor(node);
  return recoverAbsentLeases(node.id, node.hostname, (commandId, nonce, resourceKey) => client.getCommandTrace(commandId, nonce, resourceKey, PREFLIGHT_TIMEOUT_MS), actorId, now,
    (commandId, expected) => client.getCommandReceipt(commandId, expected));
}

/** What a check repaired, in words. Fence and lease repairs are safe to repeat; each change is audited. */
export async function healNode(target: PreflightTarget, preflight: NodePreflight, actorId = 'system:agent-upgrade'): Promise<{ healed: string[]; leases: LeaseRecovery[]; problems: PreflightProblem[] }> {
  const healed: string[] = [];
  const problems = [...preflight.problems];
  const fences = Object.entries(preflight.report?.fenceHighWater ?? {});
  if (fences.length && !preflight.fencesVerified) console.warn(`[agent-upgrade] the fences reported by ${target.nodeId} carry no valid proof; generations unchanged`);
  for (const [resourceKey, highWater] of preflight.fencesVerified ? fences : []) {
    if (!isOwnFenceKey(target.nodeId, resourceKey)) continue;
    const advanced = await advanceCommandFence({ nodeId: target.nodeId, resourceKey, highWater, source: 'preflight', actorId });
    if (advanced.status !== 'advanced') continue;
    healed.push(`moved the fence of ${resourceKey} from ${advanced.from} to ${advanced.to}`);
    const index = problems.findIndex(problem => problem.code === 'FENCE_AHEAD' && problem.detail.includes(` for ${resourceKey};`));
    if (index >= 0) problems.splice(index, 1);
  }
  const leases = await recoverNodeLeases(target.nodeId, actorId);
  for (const lease of leases) {
    if (lease.outcome === 'settled') healed.push(`settled lease ${lease.commandId} as not dispatched: the agent holds no receipt for it`);
    if (lease.outcome === 'unverified' && lease.code) problems.push({ code: lease.code, detail: `lease ${lease.commandId}: ${lease.detail ?? 'unverified'}`, blocking: false });
  }
  return { healed, leases, problems };
}
