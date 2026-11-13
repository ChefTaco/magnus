/**
 * The fleet's progress towards `NODE_AUTH_MODE=enforce` (see docs/NODE_CREDENTIALS.md): which nodes
 * still lack a key, still sign evidence with the shared result key, or were still spoken for with the
 * shared node secret recently. `GET /api/v1/node-credentials/summary` serves it; in `warn` mode the
 * readiness probe reports the same blockers as a non-critical failing check.
 */
import { keyFingerprint } from '../security/node-request-auth.js';
import { legacyUpgradeWindow } from './node-credential-service.js';
import { nodeAuthMode, type NodeAuthMode } from './node-auth-config.js';
import { nodeCredentialStore, type CredentialRow } from './node-credential-store.js';
import { flushLegacyUse, unattributedLegacyUse } from './node-legacy-use.js';
import { serverSigningKey } from './node-server-key.js';

/** Shared-credential use younger than this keeps a node from being ready for enforce mode. */
export const LEGACY_USE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type EnforceBlockerCode = 'SERVER_KEY_UNAVAILABLE' | 'NODES_WITHOUT_KEY' | 'NODES_REVOKED' | 'NODES_NOT_SIGNING_EVIDENCE'
  | 'RECENT_SHARED_SECRET_USE' | 'PENDING_BINDINGS';

export interface EnforceBlocker {
  code: EnforceBlockerCode;
  count: number;
  /** Up to 50 affected nodes. */
  nodes: Array<{ id: string; name: string }>;
}

export interface NodeCredentialFleetSummary {
  mode: NodeAuthMode;
  serverKey: { keyId: string; keyFingerprint: string } | null;
  legacyUpgrade: { open: boolean; until: string };
  nodes: { total: number; active: number; none: number; revoked: number; evidenceSigning: number };
  pendingBindings: number;
  legacyUse: { windowHours: number; nodes: number; request: number; evidence: number; outbound: number; lastUsedAt: string | null;
    unattributedSinceStart: number };
  /** True when switching the server to enforce would refuse no node that works today. */
  enforceReady: boolean;
  blockers: EnforceBlocker[];
  generatedAt: string;
}

function activeRow(rows: readonly CredentialRow[]): CredentialRow | undefined {
  return rows.find(row => row.status === 'ACTIVE');
}

export async function nodeCredentialFleetSummary(now = Date.now()): Promise<NodeCredentialFleetSummary> {
  await flushLegacyUse().catch(() => undefined);
  const [fleet, legacyRows, pending, window] = await Promise.all([nodeCredentialStore.fleet(), nodeCredentialStore.legacyUse(),
    nodeCredentialStore.pendingBindings({ status: 'PENDING' }), legacyUpgradeWindow(new Date(now))]);
  let serverKey: NodeCredentialFleetSummary['serverKey'] = null;
  try { const key = serverSigningKey(); serverKey = { keyId: key.keyId, keyFingerprint: keyFingerprint(key.keyId) }; } catch { serverKey = null; }

  const ids = new Set(fleet.map(node => node.id));
  const names = new Map(fleet.map(node => [node.id, node.name]));
  const without = fleet.filter(node => node.credentials.length === 0);
  const revoked = fleet.filter(node => node.credentials.length > 0 && !activeRow(node.credentials));
  const active = fleet.filter(node => activeRow(node.credentials));
  const notSigning = active.filter(node => !activeRow(node.credentials)!.evidenceSigning);
  const recent = legacyRows.filter(row => ids.has(row.nodeId) && now - row.lastUsedAt.getTime() <= LEGACY_USE_WINDOW_MS);
  const recentNodes = [...new Set(recent.map(row => row.nodeId))];
  const sum = (channel: string) => recent.filter(row => row.channel === channel).reduce((total, row) => total + row.count, 0);
  const lastUsed = recent.reduce<Date | null>((latest, row) => !latest || row.lastUsedAt > latest ? row.lastUsedAt : latest, null);
  const openPending = pending.filter(row => ids.has(row.nodeId) && now - row.lastSeenAt.getTime() <= 7 * 24 * 60 * 60 * 1000);

  const list = (nodeIds: string[]) => nodeIds.slice(0, 50).map(id => ({ id, name: names.get(id) ?? id }));
  const blockers: EnforceBlocker[] = [];
  const add = (code: EnforceBlockerCode, nodeIds: string[]) => { if (nodeIds.length > 0) blockers.push({ code, count: nodeIds.length, nodes: list(nodeIds) }); };
  if (!serverKey) blockers.push({ code: 'SERVER_KEY_UNAVAILABLE', count: 1, nodes: [] });
  add('NODES_WITHOUT_KEY', without.map(node => node.id));
  add('NODES_REVOKED', revoked.map(node => node.id));
  add('NODES_NOT_SIGNING_EVIDENCE', notSigning.map(node => node.id));
  add('RECENT_SHARED_SECRET_USE', recentNodes);
  add('PENDING_BINDINGS', [...new Set(openPending.map(row => row.nodeId))]);

  return {
    mode: nodeAuthMode(),
    serverKey,
    legacyUpgrade: window,
    nodes: { total: fleet.length, active: active.length, none: without.length, revoked: revoked.length, evidenceSigning: active.length - notSigning.length },
    pendingBindings: openPending.length,
    legacyUse: { windowHours: LEGACY_USE_WINDOW_MS / 3_600_000, nodes: recentNodes.length, request: sum('request'), evidence: sum('evidence'),
      outbound: sum('outbound'), lastUsedAt: lastUsed?.toISOString() ?? null, unattributedSinceStart: unattributedLegacyUse().count },
    enforceReady: blockers.length === 0,
    blockers,
    generatedAt: new Date(now).toISOString(),
  };
}

let cachedCheck: { at: number; blockers: EnforceBlockerCode[] } | null = null;
/**
 * Readiness check `node-credentials`: in `warn` mode it fails (non-critical: the probe answers
 * `degraded`, still 200) while anything blocks enforce mode. Cached for a minute.
 */
export async function nodeCredentialReadinessCheck(now = Date.now()): Promise<boolean> {
  if (nodeAuthMode() !== 'warn') return true;
  if (!cachedCheck || now - cachedCheck.at > 60_000) {
    const summary = await nodeCredentialFleetSummary(now);
    cachedCheck = { at: now, blockers: summary.blockers.map(blocker => blocker.code) };
  }
  return cachedCheck.blockers.length === 0;
}

/** For tests. */
export function resetNodeCredentialSummaryState(): void {
  cachedCheck = null;
}
