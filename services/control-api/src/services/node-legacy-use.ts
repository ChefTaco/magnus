/**
 * Accounting of the shared credentials that per-node keys replace (see docs/NODE_CREDENTIALS.md):
 *
 *   request   the shared node secret (`x-node-token`) was accepted for a request that names the node
 *   evidence  evidence about the node was accepted on the shared result key (`RESULT_SIGNING_SECRET`)
 *   outbound  the server still sent the shared node secret to the node's agent
 *
 * Uses are counted in memory and written per node and channel at most every 30 seconds, so a busy
 * fleet costs a handful of upserts. In `warn` mode the first use per node and channel each day is
 * also audited (`node.credential.legacy_use`), and the fleet summary reports the server not ready.
 */
import { logAuditEvent } from './audit-service.js';
import { nodeAuthMode } from './node-auth-config.js';
import { nodeCredentialStore, type LegacyChannel } from './node-credential-store.js';

const FLUSH_INTERVAL_MS = 30_000;
const AUDIT_PERIOD_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING = 10_000;

interface Pending { nodeId: string; channel: LegacyChannel; count: number; first: Date; last: Date; detail: string | null }
const pending = new Map<string, Pending>();
const audited = new Map<string, number>();
let unattributed = { count: 0, lastAt: null as Date | null, lastDetail: null as string | null };
let timer: NodeJS.Timeout | null = null;
let flushing: Promise<void> | null = null;

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => { timer = null; void flushLegacyUse().catch(error => {
    console.warn(`[node-auth] could not record shared-credential use: ${error instanceof Error ? error.message : String(error)}`);
  }); }, FLUSH_INTERVAL_MS);
  timer.unref?.();
}

/** Count one use of a shared credential for a node. Never throws and never waits. */
export function recordLegacyUse(nodeId: string, channel: LegacyChannel, detail: string, now = new Date()): void {
  const id = `${nodeId}\n${channel}`;
  const entry = pending.get(id);
  const safeDetail = detail.slice(0, 200);
  if (entry) { entry.count++; entry.last = now; entry.detail = safeDetail; }
  else if (pending.size < MAX_PENDING) pending.set(id, { nodeId, channel, count: 1, first: now, last: now, detail: safeDetail });
  if (nodeAuthMode() === 'warn' && (audited.get(id) ?? 0) < now.getTime() - AUDIT_PERIOD_MS) {
    if (audited.size > 50_000) audited.clear();
    audited.set(id, now.getTime());
    void logAuditEvent({ action: 'node.credential.legacy_use', actorType: 'agent', actorId: `node:${nodeId}`, targetType: 'node', targetId: nodeId,
      details: { channel, detail: safeDetail, mode: 'warn' } }).catch(() => undefined);
  }
  schedule();
}

/** A shared-secret request that named no node: counted for the fleet only. */
export function recordUnattributedLegacyUse(detail: string, now = new Date()): void {
  unattributed = { count: unattributed.count + 1, lastAt: now, lastDetail: detail.slice(0, 200) };
}

export function unattributedLegacyUse(): { count: number; lastAt: string | null; lastDetail: string | null } {
  return { count: unattributed.count, lastAt: unattributed.lastAt?.toISOString() ?? null, lastDetail: unattributed.lastDetail };
}

/** Write the counted uses now. Safe to call concurrently. */
export async function flushLegacyUse(): Promise<void> {
  if (flushing) return flushing;
  const entries = [...pending.values()];
  pending.clear();
  if (entries.length === 0) return;
  flushing = nodeCredentialStore.addLegacyUse(entries).finally(() => { flushing = null; });
  return flushing;
}

/** For tests. */
export function resetLegacyUseState(): void {
  pending.clear();
  audited.clear();
  unattributed = { count: 0, lastAt: null, lastDetail: null };
  if (timer) { clearTimeout(timer); timer = null; }
}

/** For tests: what is waiting to be written. */
export function pendingLegacyUse(): Pending[] {
  return [...pending.values()];
}
