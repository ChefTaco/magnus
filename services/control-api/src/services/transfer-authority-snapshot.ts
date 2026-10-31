/** Read-only lease inventory. It is an observation, never a drain receipt.
 * Shared leases are counted globally because their mission issuer is not an
 * exclusive host owner. No zero count here closes admission or covers writers
 * outside the Control API.
 */
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';
import { lockSharedAdmission } from './admission-fence.js';
import { lockResourceNode } from './resource-node-lock.js';
import { fetchHostLocalWriterProof, verifyHostLocalWriterProof } from './host-local-writer.js';
import { fetchOsSchedulerWriterProof, verifyOsSchedulerWriterProof } from './os-scheduler-writer.js';

const HELD = ['reserved', 'running', 'unknown'];
// These are separate owning-service boundaries. A Control API node fence or a
// zero lease count cannot attest to any of them. Keep the names stable so a
// future receipt verifier must cover the complete set before C11 can pass.
export const INDEPENDENT_WRITER_CLASSES = [
  'host-local-mutations', 'os-schedulers', 'native-hermes',
  'external-webhook-writers', 'peer-and-channel-writers',
] as const;

type Counts = { active: number; unknown: number };
type WriterClass = typeof INDEPENDENT_WRITER_CLASSES[number];
type WriterEvidence = { status: 'verified' | 'unverified'; ownerReceiptSha256: string | null;
  admissionFenceSha256: string | null };
type WriterCoverage = { sourceClasses: Record<WriterClass, WriterEvidence>;
  mutationInventorySha256: string | null; scheduleInventorySha256: string | null };

const SHA256 = /^[a-f0-9]{64}$/;
function empty(counts: Counts): boolean {
  return Number.isSafeInteger(counts.active) && counts.active === 0
    && Number.isSafeInteger(counts.unknown) && counts.unknown === 0;
}

/** Shape and identity checks are necessary, but are not an owner signature.
 * Callers may set ownerVerified only after an owning-service verifier has
 * authenticated every receipt. The current snapshot has no such verifier. */
export function evaluateIndependentWriterCoverage(coverage: WriterCoverage, ownerVerified: boolean) {
  const sources = coverage.sourceClasses;
  const required = [...INDEPENDENT_WRITER_CLASSES];
  const missing = required.filter(source => {
    const entry = sources[source];
    return entry?.status !== 'verified' || !entry.ownerReceiptSha256 || !SHA256.test(entry.ownerReceiptSha256)
      || !entry.admissionFenceSha256 || !SHA256.test(entry.admissionFenceSha256);
  });
  const receipts = required.map(source => sources[source]?.ownerReceiptSha256);
  const fences = required.map(source => sources[source]?.admissionFenceSha256);
  const exactClasses = Object.keys(sources).length === required.length
    && Object.keys(sources).every(source => required.includes(source as WriterClass));
  const unique = new Set(receipts).size === required.length && new Set(fences).size === required.length;
  const inventoriesBound = Boolean(coverage.mutationInventorySha256 && SHA256.test(coverage.mutationInventorySha256)
    && coverage.scheduleInventorySha256 && SHA256.test(coverage.scheduleInventorySha256));
  return { complete: ownerVerified && exactClasses && unique && inventoriesBound && missing.length === 0,
    missingClasses: missing, ownerVerified, inventoriesBound };
}

/** A read-only decision summary. Every prerequisite is independently visible;
 * this cannot close admission, settle unknown effects, or transfer a route. */
export function evaluateTransferAuthority(input: {
  enrollment: { state: string; epoch: number; barrierId: string | null; ardentScopeActive: boolean };
  scope: { epoch: number; barrierId: string | null } | null;
  nodeAdmissionClosed: boolean; sharedAdmissionClosed: boolean;
  commandLeases: Counts; participantWriters: Counts; globalSharedLeases: Counts;
  managedCronUnsettled: number; independentWritersCovered: boolean;
}) {
  const gates = {
    exactArdentScope: input.enrollment.state === 'enrolled' && input.enrollment.ardentScopeActive
      && Boolean(input.enrollment.barrierId) && input.scope?.epoch === input.enrollment.epoch
      && input.scope?.barrierId === input.enrollment.barrierId,
    nodeAdmissionClosed: input.nodeAdmissionClosed,
    sharedAdmissionClosed: input.sharedAdmissionClosed,
    commandLeasesSettled: empty(input.commandLeases),
    participantWritersSettled: empty(input.participantWriters),
    sharedLeasesSettled: empty(input.globalSharedLeases),
    managedCronSettled: Number.isSafeInteger(input.managedCronUnsettled) && input.managedCronUnsettled === 0,
    independentWritersCovered: input.independentWritersCovered,
  };
  const blockers = Object.entries(gates).filter(([, passed]) => !passed).map(([name]) => name);
  return { complete: blockers.length === 0, gates, blockers };
}

export async function transferAuthoritySnapshot(nodeFqdn: string, nonce: string) {
  const db = getDb();
  const nodes = await db.node.findMany({ where: { hostname: nodeFqdn },
    select: { id: true, hostname: true, ipAddress: true, port: true }, take: 2 });
  if (nodes.length !== 1) throw new HttpError(409, 'RESOURCE_TARGET_INVALID', 'Canonical managed node identity required');
  const node = nodes[0]!;
  // Network evidence is fetched before the database locks. The node's
  // admission drain is one-way; the signed proof is re-bound to the current
  // enrollment identity while holding the locks below.
  const [rawHostLocalProof, rawSchedulerProof] = await Promise.all([
    fetchHostLocalWriterProof(node, nodeFqdn, nonce), fetchOsSchedulerWriterProof(node, nodeFqdn, nonce),
  ]);
  return db.$transaction(async tx => {
    // Use the same lock order as fence close/release. A shared reserve/start
    // cannot cross this snapshot between its lease count and fence read.
    await lockSharedAdmission(tx);
    await lockResourceNode(tx, node.id);
    const current = await tx.node.findUnique({ where: { id: node.id }, select: { hostname: true } });
    if (current?.hostname !== nodeFqdn) throw new HttpError(409, 'RESOURCE_TARGET_INVALID', 'managed node identity changed');
    const [commands, participants, cron, shared, enrollment, ardentScope, admissionFence, anyAdmissionFence] = await Promise.all([
      tx.commandResourceLease.groupBy({ by: ['state'], where: { nodeId: node.id, state: { in: HELD } }, _count: { _all: true } }),
      tx.resourceParticipantWork.groupBy({ by: ['state'], where: { nodeId: node.id, state: { in: HELD } }, _count: { _all: true } }),
      tx.managedCronOccurrence.count({ where: { nodeId: node.id, state: { not: 'completed' } } }),
      tx.sharedResourceLease.groupBy({ by: ['state'], where: { state: { in: HELD } }, _count: { _all: true } }),
      tx.resourceEnrollment.findUnique({ where: { nodeId: node.id }, select: { state: true, epoch: true, barrierId: true } }),
      tx.ardentScopeEnrollment.findUnique({ where: { nodeId: node.id }, select: { epoch: true, barrierId: true } }),
      tx.admissionFence.findUnique({ where: { nodeId: node.id }, select: { releaseId: true, closedAt: true } }),
      tx.admissionFence.findFirst({ select: { nodeId: true } }),
    ]);
    const counts = (rows: Array<{ state: string; _count: { _all: number } }>) => ({
      active: rows.filter(row => row.state !== 'unknown').reduce((sum, row) => sum + row._count._all, 0),
      unknown: rows.filter(row => row.state === 'unknown').reduce((sum, row) => sum + row._count._all, 0),
    });
    const observedAt = Date.now();
    const sourceClasses = Object.fromEntries(INDEPENDENT_WRITER_CLASSES.map(source =>
      [source, { status: 'unverified' as const, ownerReceiptSha256: null, admissionFenceSha256: null }])) as
      Record<WriterClass, WriterEvidence>;
    const hostLocal = verifyHostLocalWriterProof(rawHostLocalProof, { nodeId: node.id, nodeFqdn,
      nonce, epoch: enrollment?.epoch ?? 0, barrierId: enrollment?.barrierId ?? null }, observedAt);
    if (hostLocal && enrollment?.state === 'enrolled') sourceClasses['host-local-mutations'] = {
      status: 'verified', ownerReceiptSha256: hostLocal.ownerReceiptSha256,
      admissionFenceSha256: hostLocal.admissionFenceSha256,
    };
    const osScheduler = verifyOsSchedulerWriterProof(rawSchedulerProof, { nodeId: node.id, nodeFqdn,
      nonce, epoch: enrollment?.epoch ?? 0, barrierId: enrollment?.barrierId ?? null }, observedAt);
    if (osScheduler && enrollment?.state === 'enrolled') sourceClasses['os-schedulers'] = {
      status: 'verified', ownerReceiptSha256: osScheduler.ownerReceiptSha256,
      admissionFenceSha256: osScheduler.admissionFenceSha256,
    };
    const coverageDecision = evaluateIndependentWriterCoverage({ sourceClasses,
      mutationInventorySha256: hostLocal?.mutationInventorySha256 ?? null,
      scheduleInventorySha256: osScheduler?.scheduleInventorySha256 ?? null }, false);
    const independentWriterCoverage = {
      version: 1 as const, nodeId: node.id, nodeFqdn,
      epoch: enrollment?.epoch ?? 0, barrierId: enrollment?.barrierId ?? null,
      releaseId: admissionFence?.releaseId ?? null, observedAt,
      mutationInventorySha256: hostLocal?.mutationInventorySha256 ?? null,
      scheduleInventorySha256: osScheduler?.scheduleInventorySha256 ?? null,
      sourceClasses, ...coverageDecision,
    };
    const commandLeases = counts(commands);
    const participantWriters = counts(participants);
    const globalSharedLeases = counts(shared);
    const transferAuthority = evaluateTransferAuthority({
      enrollment: { state: enrollment?.state ?? 'legacy', epoch: enrollment?.epoch ?? 0,
        barrierId: enrollment?.barrierId ?? null, ardentScopeActive: Boolean(ardentScope) },
      scope: ardentScope, nodeAdmissionClosed: Boolean(admissionFence),
      sharedAdmissionClosed: Boolean(anyAdmissionFence), commandLeases,
      participantWriters, globalSharedLeases, managedCronUnsettled: cron,
      independentWritersCovered: coverageDecision.complete,
    });
    return { version: 1 as const, nodeId: node.id, nodeFqdn, nonce, observedAt,
      commandLeases, participantWriters,
      managedCronUnsettled: cron, globalSharedLeases,
      enrollment: { state: enrollment?.state ?? 'legacy', epoch: enrollment?.epoch ?? 0,
        barrierId: enrollment?.barrierId ?? null, ardentScopeActive: Boolean(ardentScope) },
      controlApiNodeAdmission: { closed: Boolean(admissionFence), releaseId: admissionFence?.releaseId ?? null,
        closedAt: admissionFence?.closedAt ?? null },
      controlApiSharedAdmission: { closed: Boolean(anyAdmissionFence), coverage: 'control-api-shared-leases' as const },
      admissionFenced: Boolean(admissionFence) && Boolean(anyAdmissionFence) && coverageDecision.complete,
      independentWriterCoverage,
      independentWritersCovered: independentWriterCoverage.complete,
      transferAuthority, transferAuthorityComplete: transferAuthority.complete };
  });
}
