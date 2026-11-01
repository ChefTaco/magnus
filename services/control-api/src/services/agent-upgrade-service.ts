/**
 * Server-driven agent upgrades (MAGNUS_AGENT_UPGRADES). The server pins one
 * exact version and its npm integrity, asks one canary agent to stage it,
 * waits until that agent reports the version on trial as confirmed, then
 * upgrades the rest a few at a time. The first revert or failure stops the
 * run. Agents decide for themselves whether they can upgrade
 * (MAGNUS_AGENT_SELF_UPGRADE, launcher layout) and report it with every
 * heartbeat, so the console can grey out the ones that cannot.
 */
import { randomUUID } from 'node:crypto';
import {
  AGENT_SELF_UPGRADE_PROTOCOL,
  agentSelfUpgradeStatusSchema,
  checkUpgradeAllowed,
  compareVersions,
  isVersion,
  type AgentSelfUpgradeStatus,
} from '@hivemagnus/magnus-contracts';
import { upgradeSettings } from '../config/features.js';
import { AGENT_VERSION } from '../config/version.js';
import { getDb } from '../db/client.js';
import { HttpError } from '../middleware/error-handler.js';
import { NodeApiClient } from '../sdk/node-api-client.js';
import { getNodeManagerSecret } from '../utils/env.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { SENTINEL_NODE_IDS } from '../utils/sentinel-nodes.js';
import { logAuditEvent } from './audit-service.js';

export const AGENT_PACKAGE = '@hivemagnus/magnus-agent';
/** Heartbeats are 30 s apart; older than this and the node counts as offline for upgrades. */
const FRESH_HEARTBEAT_MS = 2 * 60_000;
/** Install time plus the agent's confirmation window (default 180 s), with margin. */
const CONFIRM_TIMEOUT_MS = 20 * 60_000;
const POLL_MS = 5_000;
const RUN_TTL_SECONDS = 7 * 24 * 60 * 60;

// ── Heartbeat side: what each agent reports ──

export interface StoredSelfUpgrade extends AgentSelfUpgradeStatus {
  nodeVersion: string | null;
  observedAt: string;
}

function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function storedSelfUpgrade(metadataRaw: string | null | undefined): StoredSelfUpgrade | null {
  const value = parseMetadata(metadataRaw)['agentSelfUpgrade'];
  const parsed = agentSelfUpgradeStatusSchema.safeParse(value);
  if (!parsed.success) return null;
  const extra = value as { nodeVersion?: unknown; observedAt?: unknown };
  return { ...parsed.data, nodeVersion: typeof extra.nodeVersion === 'string' ? extra.nodeVersion : null,
    observedAt: typeof extra.observedAt === 'string' ? extra.observedAt : new Date(0).toISOString() };
}

/**
 * Store the self-upgrade report from a heartbeat, keep Agent.status in step
 * (UPDATING while a version is staged or on trial) and audit each revert once.
 */
export async function recordSelfUpgradeReport(node: { id: string; name: string }, body: { selfUpgrade?: unknown; nodeVersion?: unknown }): Promise<void> {
  const parsed = agentSelfUpgradeStatusSchema.safeParse(body.selfUpgrade);
  if (!parsed.success) return;
  const db = getDb();
  const row = await db.node.findUnique({ where: { id: node.id }, select: { metadata: true } });
  const metadata = parseMetadata(row?.metadata);
  const previous = storedSelfUpgrade(row?.metadata);
  const nodeVersion = typeof body.nodeVersion === 'string' ? body.nodeVersion.slice(0, 32) : null;
  const next = { ...parsed.data, nodeVersion, observedAt: new Date().toISOString() };
  const unchanged = previous && JSON.stringify({ ...previous, observedAt: '' }) === JSON.stringify({ ...next, observedAt: '' })
    && Date.now() - Date.parse(previous.observedAt) < 10 * 60_000;
  if (!unchanged) {
    await db.node.update({ where: { id: node.id }, data: { metadata: JSON.stringify({ ...metadata, agentSelfUpgrade: next, nodeVersion }) } });
  }
  const state = parsed.data.upgrade?.state;
  const updating = state === 'staged' || state === 'trial';
  await db.agent.updateMany({
    where: { nodeId: node.id, status: updating ? { not: 'UPDATING' } : 'UPDATING' },
    data: { status: updating ? 'UPDATING' : 'RUNNING' },
  });
  const upgrade = parsed.data.upgrade;
  if (upgrade && (upgrade.state === 'reverted' || upgrade.state === 'confirmed')
    && upgrade.requestId && previous?.upgrade?.requestId === upgrade.requestId && previous.upgrade.state !== upgrade.state) {
    await logAuditEvent({
      action: upgrade.state === 'reverted' ? 'agent.upgrade_reverted' : 'agent.upgrade',
      actorId: 'system:agent-upgrade', actorType: 'system', targetType: 'node', targetId: node.id,
      details: { node: node.name, from: upgrade.from, to: upgrade.to, requestId: upgrade.requestId, result: upgrade.state, reason: upgrade.reason ?? null },
    }).catch(() => undefined);
  }
}

// ── Release resolution ──

export interface AgentRelease {
  version: string;
  integrity: string;
}

/** The exact version (default: the one this server ships) and its npm integrity. */
export async function resolveAgentRelease(options: { version?: string; integrity?: string; fetchImpl?: typeof fetch } = {}): Promise<AgentRelease> {
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
    response = await (options.fetchImpl ?? fetch)(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
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

interface CandidateRow {
  id: string;
  name: string;
  status: string;
  lastHeartbeatAt: Date | null;
  metadata: string;
  agent: { version: string } | null;
}

/** Pure, for tests: why one node can or cannot take `target` now. */
export function classifyCandidate(row: CandidateRow, target: string, now = Date.now()): UpgradeCandidate {
  const version = row.agent?.version ?? 'unknown';
  const report = storedSelfUpgrade(row.metadata);
  const base = { nodeId: row.id, name: row.name, version, upgrade: report?.upgrade ?? null, layout: report?.layout ?? null };
  const no = (reason: string) => ({ ...base, eligible: false, reason });
  if (row.status !== 'ONLINE' || !row.lastHeartbeatAt || now - row.lastHeartbeatAt.getTime() > FRESH_HEARTBEAT_MS) return no('offline or no recent heartbeat');
  if (!isVersion(version)) return no('agent version unknown');
  if (compareVersions(version, target) === 0) return no('already on this version');
  const decision = checkUpgradeAllowed(version, target);
  if (!decision.allowed) return no(decision.kind === 'downgrade' ? `runs ${version}, newer than ${target}` : `${version} -> ${target} crosses a major version; upgrade this node by hand`);
  if (!report) return no(`magnus-agent ${version} cannot upgrade itself (needs 1.1.0 or later and \`sudo magnus-agent install-service\`)`);
  if (report.protocol < AGENT_SELF_UPGRADE_PROTOCOL) return no('agent self-upgrade protocol too old');
  if (!report.enabled) return no(report.reason ?? 'self-upgrade disabled on this node');
  if (report.upgrade && (report.upgrade.state === 'staged' || report.upgrade.state === 'trial')) return no(`an upgrade to ${report.upgrade.to} is in progress`);
  return { ...base, eligible: true, reason: null };
}

export async function listUpgradeCandidates(target: string, nodeIds?: readonly string[]): Promise<UpgradeCandidate[]> {
  const rows = await getDb().node.findMany({
    where: { id: { notIn: SENTINEL_NODE_IDS, ...(nodeIds?.length ? { in: [...nodeIds] } : {}) }, status: { not: 'DECOMMISSIONED' } },
    select: { id: true, name: true, status: true, lastHeartbeatAt: true, metadata: true, agent: { select: { version: true } } },
    orderBy: { name: 'asc' },
  });
  return rows.map(row => classifyCandidate(row, target));
}

// ── Runs ──

export type NodeRunState = 'pending' | 'requested' | 'confirmed' | 'reverted' | 'failed' | 'skipped';

export interface UpgradeRun {
  id: string;
  version: string;
  integrity: string;
  actorId: string;
  status: 'running' | 'succeeded' | 'failed' | 'stopped';
  startedAt: string;
  finishedAt: string | null;
  concurrency: number;
  message: string | null;
  nodes: Array<{ nodeId: string; name: string; from: string; state: NodeRunState; requestId: string; detail: string | null }>;
}

const runs = new Map<string, UpgradeRun>();

async function saveRun(run: UpgradeRun): Promise<void> {
  runs.set(run.id, run);
  try {
    const { getRedis } = await import('../queue/redis.js');
    await getRedis().set(`agent-upgrade-run:${run.id}`, JSON.stringify(run), 'EX', RUN_TTL_SECONDS);
    await getRedis().set('agent-upgrade-run:latest', run.id, 'EX', RUN_TTL_SECONDS);
  } catch {
    // in-memory only
  }
}

export async function getUpgradeRun(id: string): Promise<UpgradeRun | null> {
  const local = runs.get(id);
  if (local) return local;
  try {
    const { getRedis } = await import('../queue/redis.js');
    const raw = await getRedis().get(`agent-upgrade-run:${id}`);
    return raw ? JSON.parse(raw) as UpgradeRun : null;
  } catch {
    return null;
  }
}

export async function latestUpgradeRun(): Promise<UpgradeRun | null> {
  try {
    const { getRedis } = await import('../queue/redis.js');
    const id = await getRedis().get('agent-upgrade-run:latest');
    return id ? getUpgradeRun(id) : null;
  } catch {
    return [...runs.values()].at(-1) ?? null;
  }
}

export interface UpgradeDeps {
  request: (nodeId: string, body: { version: string; integrity: string; requestId: string; packageName: string }) => Promise<void>;
  /** Current report and agent version of one node. */
  observe: (nodeId: string) => Promise<{ version: string | null; report: StoredSelfUpgrade | null }>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  save: (run: UpgradeRun) => Promise<void>;
  confirmTimeoutMs: number;
  pollMs: number;
}

function clientFor(node: { id: string; ipAddress: string; port: number }): NodeApiClient {
  return new NodeApiClient({ baseUrl: getNodeBaseUrl(node.ipAddress, node.port), resourceNodeId: node.id, nodeToken: getNodeManagerSecret(),
    timeout: 15 * 60_000 });
}

export function defaultDeps(): UpgradeDeps {
  return {
    request: async (nodeId, body) => {
      const node = await getDb().node.findUniqueOrThrow({ where: { id: nodeId }, select: { id: true, ipAddress: true, port: true } });
      await clientFor(node).upgradeAgent(body);
    },
    observe: async nodeId => {
      const row = await getDb().node.findUnique({ where: { id: nodeId }, select: { metadata: true, agent: { select: { version: true } } } });
      return { version: row?.agent?.version ?? null, report: storedSelfUpgrade(row?.metadata) };
    },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
    save: saveRun,
    confirmTimeoutMs: CONFIRM_TIMEOUT_MS,
    pollMs: POLL_MS,
  };
}

/** Ask one node to upgrade and wait for its confirmed (or reverted) report. */
async function upgradeOne(run: UpgradeRun, entry: UpgradeRun['nodes'][number], deps: UpgradeDeps): Promise<void> {
  entry.state = 'requested';
  await deps.save(run);
  try {
    await deps.request(entry.nodeId, { version: run.version, integrity: run.integrity, requestId: entry.requestId, packageName: AGENT_PACKAGE });
  } catch (error) {
    entry.state = 'failed';
    entry.detail = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    return;
  }
  const deadline = deps.now() + deps.confirmTimeoutMs;
  while (deps.now() < deadline) {
    await deps.sleep(deps.pollMs);
    const { version, report } = await deps.observe(entry.nodeId);
    const upgrade = report?.upgrade;
    if (upgrade?.requestId === entry.requestId && upgrade.state === 'reverted') {
      entry.state = 'reverted';
      entry.detail = upgrade.reason ?? 'the agent switched back to its previous version';
      return;
    }
    if (version === run.version && (upgrade?.requestId !== entry.requestId || upgrade.state === 'confirmed')) {
      entry.state = 'confirmed';
      entry.detail = null;
      return;
    }
  }
  entry.state = 'failed';
  entry.detail = `no confirmation within ${Math.round(deps.confirmTimeoutMs / 60_000)} min`;
}

/** Canary first, then batches of `concurrency`. Stops at the first node that does not confirm. */
export async function executeUpgradeRun(run: UpgradeRun, deps: UpgradeDeps): Promise<UpgradeRun> {
  const queue = run.nodes.filter(node => node.state === 'pending');
  const [canary, ...rest] = queue;
  const finish = async (status: UpgradeRun['status'], message: string | null) => {
    for (const node of run.nodes) if (node.state === 'pending') node.state = 'skipped';
    run.status = status;
    run.message = message;
    run.finishedAt = new Date(deps.now()).toISOString();
    await deps.save(run);
    return run;
  };
  if (!canary) return finish('succeeded', 'no eligible nodes');
  await upgradeOne(run, canary, deps);
  await deps.save(run);
  if (canary.state !== 'confirmed') return finish('failed', `canary ${canary.name} did not confirm (${canary.state}: ${canary.detail ?? ''}); the other nodes were not touched`);
  for (let index = 0; index < rest.length; index += run.concurrency) {
    const batch = rest.slice(index, index + run.concurrency);
    await Promise.all(batch.map(node => upgradeOne(run, node, deps)));
    await deps.save(run);
    const bad = batch.find(node => node.state !== 'confirmed');
    if (bad) return finish('failed', `${bad.name} did not confirm (${bad.state}: ${bad.detail ?? ''}); remaining nodes were skipped`);
  }
  return finish('succeeded', `${run.nodes.filter(node => node.state === 'confirmed').length} agent(s) upgraded to ${run.version}`);
}

export interface StartRunOptions {
  version?: string;
  integrity?: string;
  nodeIds?: string[];
  actorId: string;
  deps?: UpgradeDeps;
}

/** Validate, create the run and start it in the background. */
export async function startUpgradeRun(options: StartRunOptions): Promise<{ run: UpgradeRun; candidates: UpgradeCandidate[]; done: Promise<UpgradeRun> }> {
  const settings = upgradeSettings();
  if (!settings.agentUpgrades) throw new HttpError(403, 'AGENT_UPGRADES_DISABLED', 'Server-driven agent upgrades are off (MAGNUS_AGENT_UPGRADES=false)');
  const release = await resolveAgentRelease({ version: options.version, integrity: options.integrity });
  const candidates = await listUpgradeCandidates(release.version, options.nodeIds);
  const eligible = candidates.filter(candidate => candidate.eligible);
  if (eligible.length === 0) {
    const reasons = candidates.slice(0, 5).map(candidate => `${candidate.name}: ${candidate.reason}`).join('; ');
    throw new HttpError(409, 'NO_ELIGIBLE_AGENTS', `No selected agent can be upgraded now${reasons ? ` (${reasons})` : ''}`);
  }
  const running = await latestUpgradeRun();
  if (running?.status === 'running') throw new HttpError(409, 'AGENT_UPGRADE_RUNNING', `Upgrade run ${running.id} is still in progress`);
  const run: UpgradeRun = {
    id: randomUUID(), version: release.version, integrity: release.integrity, actorId: options.actorId, status: 'running',
    startedAt: new Date().toISOString(), finishedAt: null, concurrency: settings.agentUpgradeConcurrency, message: null,
    nodes: eligible.map(candidate => ({ nodeId: candidate.nodeId, name: candidate.name, from: candidate.version, state: 'pending', requestId: randomUUID(), detail: null })),
  };
  const deps = options.deps ?? defaultDeps();
  await deps.save(run);
  await logAuditEvent({ action: 'agent.upgrade', actorId: options.actorId, targetType: 'fleet', targetId: run.id,
    details: { version: run.version, nodes: run.nodes.map(node => node.name) } }).catch(() => undefined);
  const done = executeUpgradeRun(run, deps).catch(async error => {
    run.status = 'failed';
    run.message = error instanceof Error ? error.message : String(error);
    run.finishedAt = new Date().toISOString();
    await deps.save(run);
    return run;
  });
  return { run, candidates, done };
}
