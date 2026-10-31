/** One-way Ardent-only authority, independent of the node enrollment state. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '../db/generated/prisma/client.js';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';
import { apiDrainAttestationSchema, apiDrainAttestationSigningPayload, canonical,
  dashboardEnrollmentSecret, drainReceiptSchema, enrollmentSigningPayload } from './resource-enrollment.js';
import { lockResourceNode, resourceNodeIdentity } from './resource-node-lock.js';
import { reconciliationSecret } from './resource-participant-work.js';
import { RESULT_SIGNING_SECRET } from '../utils/env.js';

type Tx = Prisma.TransactionClient;
const PARTICIPANTS = ['agent', 'api', 'dashboard'] as const;
const HELD = ['reserved', 'running', 'unknown'];
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const hex = z.string().regex(/^[a-f0-9]{64}$/);
export const ardentScopeActivationSchema = z.object({
  version: z.literal(1), scope: z.literal('managed-ardent-actions-only'),
  excludedParticipant: z.literal('scheduler'),
  nodeId: z.string().min(1).max(128), nodeFqdn: z.string().min(1).max(253),
  epoch: z.number().int().positive(), barrierId: z.string().guid(),
  decisionId: z.string().guid(), approvalRef: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,199}$/),
  reviewSha256: hex, schedulerSnapshotSha256: hex,
  receiptSha256: z.object({ agent: hex, api: hex, dashboard: hex }).strict(),
  expiresAt: z.number().int().positive(), signature: hex,
}).strict();
export type ArdentScopeActivation = z.infer<typeof ardentScopeActivationSchema>;
export function ardentScopeSigningPayload(value: Omit<ArdentScopeActivation, 'signature'>): string {
  return 'magnus.ardent-scope-activation.v1\n' + canonical(value);
}
function fail(): never {
  throw new HttpError(409, 'ARDENT_SCOPE_EVIDENCE_INVALID', 'Current reviewed Ardent scope evidence is required');
}
export async function assertArdentScope(tx: Tx, nodeId: string, nodeFqdn: string): Promise<void> {
  const [scope, whole] = await Promise.all([
    tx.ardentScopeEnrollment.findUnique({ where: { nodeId } }),
    tx.resourceEnrollment.findUnique({ where: { nodeId } }),
  ]);
  if (!scope || !whole || scope.nodeFqdn !== nodeFqdn || whole.nodeFqdn !== nodeFqdn
    || whole.epoch !== scope.epoch || whole.barrierId !== scope.barrierId || !['draining', 'enrolled'].includes(whole.state))
    throw new HttpError(409, 'ARDENT_SCOPE_REQUIRED', 'Reviewed Ardent-only claim is required');
}

async function receiptHashes(tx: Tx, nodeId: string, nodeFqdn: string, epoch: number, barrierId: string) {
  const hashes: Record<(typeof PARTICIPANTS)[number], string> = { agent: '', api: '', dashboard: '' };
  for (const participant of PARTICIPANTS) {
    const ack = await tx.resourceDrainParticipant.findUnique({ where: { nodeId_participant: { nodeId, participant } } });
    if (!ack || ack.status !== 'verified' || ack.epoch !== epoch || ack.barrierId !== barrierId
      || ack.challengeExpiresAt.getTime() <= Date.now() || !ack.receiptJson) fail();
    let receipt: z.infer<typeof drainReceiptSchema> | z.infer<typeof apiDrainAttestationSchema>;
    try { receipt = participant === 'api' ? apiDrainAttestationSchema.parse(JSON.parse(ack.receiptJson))
      : drainReceiptSchema.parse(JSON.parse(ack.receiptJson)); } catch { fail(); }
    const { signature, ...unsigned } = receipt;
    const key = participant === 'api' ? reconciliationSecret()
      : participant === 'dashboard' ? dashboardEnrollmentSecret() : RESULT_SIGNING_SECRET;
    const payload = participant === 'api'
      ? apiDrainAttestationSigningPayload(unsigned as Omit<z.infer<typeof apiDrainAttestationSchema>, 'signature'>)
      : enrollmentSigningPayload(unsigned);
    const expected = createHmac('sha256', key).update(payload).digest();
    if (receipt.participant !== participant || receipt.nodeId !== nodeId || receipt.nodeFqdn !== nodeFqdn
      || receipt.epoch !== epoch || receipt.barrierId !== barrierId
      || receipt.challengeId !== ack.challengeId || receipt.expiresAt !== ack.challengeExpiresAt.getTime()
      || receipt.status !== 'drained' || receipt.activeCount !== 0 || receipt.unknownCount !== 0
      || receipt.evidenceSha256 !== ack.evidenceSha256 || !timingSafeEqual(expected, Buffer.from(signature, 'hex'))) fail();
    hashes[participant] = sha256(ack.receiptJson);
  }
  return hashes;
}

async function schedulerSnapshot(tx: Tx, nodeId: string): Promise<string> {
  const [ack, definitions, unsettled] = await Promise.all([
    tx.resourceDrainParticipant.findUnique({ where: { nodeId_participant: { nodeId, participant: 'scheduler' } },
      select: { status: true, epoch: true, barrierId: true, evidenceSha256: true } }),
    tx.managedCronDefinition.count({ where: { nodeId, enabled: true } }),
    tx.managedCronOccurrence.count({ where: { nodeId, state: { not: 'completed' } } }),
  ]);
  return sha256(canonical({ ack, definitions, unsettled }));
}

export async function inspectArdentScope(nodeId: string) {
  return getDb().$transaction(async tx => {
    await lockResourceNode(tx, nodeId);
    const { node, row } = await resourceNodeIdentity(tx, nodeId);
    const scope = await tx.ardentScopeEnrollment.findUnique({ where: { nodeId } });
    return { nodeId, nodeFqdn: node.hostname, wholeNodeState: row?.state ?? 'legacy',
      epoch: row?.epoch ?? 0, barrierId: row?.barrierId ?? null, schedulerSnapshotSha256: await schedulerSnapshot(tx, nodeId),
      scope: scope ? { state: 'active' as const, decisionId: scope.decisionId, evidenceSha256: scope.evidenceSha256,
        activatedAt: scope.activatedAt } : { state: 'pending' as const } };
  });
}

export async function activateArdentScope(nodeId: string, raw: unknown) {
  const assertion = ardentScopeActivationSchema.parse(raw);
  const { signature, ...unsigned } = assertion;
  const key = reconciliationSecret();
  const expected = createHmac('sha256', key).update(ardentScopeSigningPayload(unsigned)).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))
    || assertion.expiresAt <= Date.now() || assertion.expiresAt > Date.now() + 300_000) fail();
  return getDb().$transaction(async tx => {
    await lockResourceNode(tx, nodeId);
    const { node, row } = await resourceNodeIdentity(tx, nodeId);
    const existing = await tx.ardentScopeEnrollment.findUnique({ where: { nodeId } });
    if (existing) {
      if (existing.assertionJson !== JSON.stringify(assertion)) fail();
      return { nodeId, nodeFqdn: node.hostname, state: 'active' as const, decisionId: existing.decisionId };
    }
    if (row?.state !== 'draining' || !row.barrierId || assertion.nodeId !== nodeId || assertion.nodeFqdn !== node.hostname
      || assertion.epoch !== row.epoch || assertion.barrierId !== row.barrierId) fail();
    const hashes = await receiptHashes(tx, nodeId, node.hostname, row.epoch, row.barrierId);
    if (canonical(hashes) !== canonical(assertion.receiptSha256)
      || assertion.schedulerSnapshotSha256 !== await schedulerSnapshot(tx, nodeId)
      || await tx.commandResourceLease.count({ where: { nodeId, state: { in: HELD } } })
      || await tx.resourceParticipantWork.count({ where: { nodeId, participant: { in: [...PARTICIPANTS] }, state: { in: HELD } } })) fail();
    await tx.ardentScopeEnrollment.create({ data: { nodeId, nodeFqdn: node.hostname,
      epoch: row.epoch, barrierId: row.barrierId, decisionId: assertion.decisionId,
      assertionJson: JSON.stringify(assertion), evidenceSha256: sha256(ardentScopeSigningPayload(unsigned)) } });
    return { nodeId, nodeFqdn: node.hostname, state: 'active' as const, decisionId: assertion.decisionId };
  });
}
