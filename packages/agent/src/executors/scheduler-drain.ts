/** Fixed API challenge -> durable local fence -> independently observed scheduler proof. */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { resultSigningKey } from '../security/local-evidence-keys.js';
import { Hono } from 'hono';
import { z } from 'zod';
import { HOST_FQDN } from '../env.js';
import { freshSchedulerStatus, schedulerStatusSchema } from './scheduler-status.js';
import { nodeAuthMiddleware } from '../middleware.js';
import { ManagedScheduler, type SchedulerDrainIdentity } from './managed-scheduler.js';
import { schedulerInventory, type SchedulerInventoryOptions } from './scheduler-inventory.js';
import { schedulerAuthority } from './scheduler-authority.js';
import { logger } from '../utils/logger.js';
import { canonicalEvidenceJson } from '../security/node-evidence.js';
import { nodeEvidenceFields } from '../security/evidence-signing.js';
import { enrollmentReceiptSigningPayload } from '../security/node-evidence.js';
/** Fixed, non-secret reasons a scheduler drain proof was refused. */
export type SchedulerDrainFailureReason = 'authority-unavailable' | 'authority-binding' | 'fence-failed' | 'inventory-failed'
  | 'inventory-changed' | 'ownership-changed' | 'challenge-expired' | 'receipt-failed';
class SchedulerDrainFailure extends Error {
  constructor(readonly reason: SchedulerDrainFailureReason, message: string, readonly detail: Record<string, unknown> = {}) { super(message); }
}
/** Which parts of two inventories differ: field names, source keys (path hashes or
 * fixed labels) and blocker kinds only, never source content or paths. */
export function schedulerInventoryDifference(first: Record<string, unknown>, second: Record<string, unknown>) {
  const fields = [...new Set([...Object.keys(first), ...Object.keys(second)])].sort()
    .filter(key => canonicalSchedulerEvidence(first[key]) !== canonicalSchedulerEvidence(second[key]));
  const sourcesOf = (value: Record<string, unknown>) => (value['sources'] ?? {}) as Record<string, unknown>;
  const sources = [...new Set([...Object.keys(sourcesOf(first)), ...Object.keys(sourcesOf(second))])].sort()
    .filter(key => sourcesOf(first)[key] !== sourcesOf(second)[key]);
  type Blocker = { kind: string; sourceSha256: string; count: number };
  const blockersOf = (value: Record<string, unknown>) => new Set(((value['blockers'] ?? []) as Blocker[])
    .map(row => row.kind + ':' + row.sourceSha256 + ':' + row.count));
  const left = blockersOf(first); const right = blockersOf(second);
  const blockerKinds = [...new Set([...left].filter(row => !right.has(row)).concat([...right].filter(row => !left.has(row)))
    .map(row => row.split(':')[0]))].sort();
  return { fields, sources: sources.slice(0, 32), blockerKinds };
}
const EXTERNAL_SCHEDULER_KINDS = new Set([
  'LEGACY_OR_UNSUPPORTED_CRONTAB', 'SYSTEM_ANACRON', 'SYSTEM_CRONTAB', 'SYSTEM_CRON_SOURCE',
  'SYSTEM_TIMER_DEFINITION', 'USER_TIMER_DEFINITION', 'USER_TIMER_OFFLINE_ENABLED',
  'NATIVE_HERMES_RUNTIME_UNINSTRUMENTED', 'NATIVE_HERMES_SCHEDULES', 'NATIVE_HERMES_UNSETTLED_CLAIMS', 'NATIVE_AT_QUEUE',
]);
const descriptorSchema = z.object({ version: z.literal(1), participant: z.literal('scheduler'),
  nodeId: z.string().min(1).max(128), nodeFqdn: z.string().min(1).max(253), epoch: z.number().int().positive(),
  barrierId: z.string().guid(), challengeId: z.string().guid(), expiresAt: z.number().int().positive() }).strict();
export function canonicalSchedulerEvidence(value: unknown): string {
  return canonicalEvidenceJson(value);
}
export function schedulerDrainRoutes(options: { scheduler?: ManagedScheduler; inventory?: SchedulerInventoryOptions;
  status?: typeof freshSchedulerStatus; recover?: (id: string) => Promise<unknown> } = {}) {
  const app = new Hono(); const scheduler = options.scheduler ?? new ManagedScheduler();
  app.use('/enrollment-drain', nodeAuthMiddleware);
  app.post('/enrollment-drain', async c => {
    const parsed = descriptorSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ success: false, error: { code: 'INVALID_SCHEDULER_DRAIN' } }, 400);
    const descriptor = parsed.data; const started = Date.now();
    if (descriptor.nodeFqdn !== HOST_FQDN || descriptor.expiresAt <= Date.now() || descriptor.expiresAt > Date.now() + 300_000
      || resultSigningKey().length < 32)
      return c.json({ success: false, error: { code: 'INVALID_SCHEDULER_DRAIN' } }, 409);
    // The step in progress names the refusal when a dependency throws.
    let step: SchedulerDrainFailureReason = 'authority-unavailable';
    try {
      const query = { nodeFqdn: HOST_FQDN, nonce: randomUUID() };
      const status = schedulerStatusSchema.parse(await (options.status ?? freshSchedulerStatus)(query));
      if (status.nonce !== query.nonce || status.nodeFqdn !== descriptor.nodeFqdn || status.nodeId !== descriptor.nodeId
        || status.state !== 'draining' || status.epoch !== descriptor.epoch || status.barrierId !== descriptor.barrierId
        || status.schedulerChallenge?.challengeId !== descriptor.challengeId || status.schedulerChallenge.expiresAt !== descriptor.expiresAt)
        throw new SchedulerDrainFailure('authority-binding', 'Scheduler drain authority binding differs');
      const identity: SchedulerDrainIdentity = { nodeId: descriptor.nodeId, nodeFqdn: descriptor.nodeFqdn, epoch: descriptor.epoch, barrierId: descriptor.barrierId };
      step = 'fence-failed';
      await scheduler.drain(identity);
      step = 'inventory-failed';
      const owned = await scheduler.inventory(identity);
      const recovery = options.recover ?? (id => scheduler.recover(id, schedulerAuthority()));
      // Recover only original receipts. Never call trigger/admit/run from a drain.
      const pending = owned.occurrences.filter(row => row.state !== 'not-started' && (row.state !== 'completed' || row.settlementPending));
      const reconciliationDeadline = Math.min(descriptor.expiresAt, Date.now() + 5000);
      for (const row of pending.slice(0, 8)) {
        if (Date.now() >= reconciliationDeadline) break;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([recovery(row.occurrenceId), new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(1, reconciliationDeadline - Date.now())); })]); }
        catch { /* Retain the exact unresolved occurrence. */ } finally { clearTimeout(timer); }
      }
      const first = await schedulerInventory({ ...options.inventory, scheduler, expectedBarrier: identity });
      let observed = first;
      const firstBoundaryReady = first.issues.length === 0
        && first.blockers.every(source => EXTERNAL_SCHEDULER_KINDS.has(source.kind));
      if (firstBoundaryReady) {
        observed = await schedulerInventory({ ...options.inventory, scheduler, expectedBarrier: identity });
        if (canonicalSchedulerEvidence(first) !== canonicalSchedulerEvidence(observed))
          throw new SchedulerDrainFailure('inventory-changed', 'Scheduler source inventory changed during proof', schedulerInventoryDifference(first, observed));
      }
      // Bind the final managed snapshot under its flock, after all source reads.
      const finalOwned = await scheduler.inventory(identity);
      if (canonicalSchedulerEvidence(finalOwned) !== canonicalSchedulerEvidence(await scheduler.inventory(identity)))
        throw new SchedulerDrainFailure('ownership-changed', 'Scheduler ownership changed during proof');
      const activeCount = finalOwned.occurrences.filter(row => ['admitting', 'running'].includes(row.state)).length;
      const unknownCount = finalOwned.occurrences.filter(row => row.state === 'unknown' || row.settlementPending).length
        + finalOwned.issues.length + observed.issues.length
        + observed.blockers.filter(source => !EXTERNAL_SCHEDULER_KINDS.has(source.kind)).reduce((sum, source) => sum + source.count, 0);
      if (descriptor.expiresAt <= Date.now())
        throw new SchedulerDrainFailure('challenge-expired', 'Scheduler challenge expired', { lateByMs: Date.now() - descriptor.expiresAt });
      step = 'receipt-failed';
      const receipt = { ...descriptor, status: firstBoundaryReady && !activeCount && !unknownCount ? 'managed-drained' : 'pending',
        scope: 'magnus-managed-scheduler-only', activeCount, unknownCount,
        externalBlockers: observed.blockers.filter(source => EXTERNAL_SCHEDULER_KINDS.has(source.kind)),
        evidenceSha256: createHash('sha256').update(canonicalSchedulerEvidence({ inventory: observed, managed: finalOwned })).digest('hex') };
      const payload = enrollmentReceiptSigningPayload(receipt);
      const signature = createHmac('sha256', resultSigningKey()).update(payload).digest('hex');
      c.header('Cache-Control', 'no-store'); return c.json({ ...receipt, signature, ...nodeEvidenceFields('scheduler-drain', payload) });
    } catch (error) {
      const reason = error instanceof SchedulerDrainFailure ? error.reason : step;
      // The local log keeps the real cause; the response carries only the fixed reason.
      logger.warn('Scheduler enrollment drain refused', { reason, error: error instanceof Error ? error.message : String(error),
        ...(error instanceof SchedulerDrainFailure ? error.detail : {}), epoch: descriptor.epoch, barrierId: descriptor.barrierId,
        elapsedMs: Date.now() - started });
      return c.json({ success: false, error: { code: 'SCHEDULER_DRAIN_EVIDENCE_UNAVAILABLE', reason,
        message: 'Scheduler evidence remains incomplete; no drain acknowledgment issued' } }, 409);
    }
  });
  return app;
}
