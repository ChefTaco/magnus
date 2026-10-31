/** Durable node-scoped API reservation barrier. This is not a global writer fence. */
import { z } from 'zod';
import type { Prisma } from '../db/generated/prisma/client.js';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';
import { lockResourceNode } from './resource-node-lock.js';

type Tx = Prisma.TransactionClient;
export const admissionFenceRequest = z.object({ nodeFqdn: z.string().min(1).max(253), releaseId: z.string().guid() }).strict();

/** Serialize all Control API shared-resource admissions with admission fence close.
 * Shared leases have no node owner, so any closed admission fence pauses this
 * API's new shared work globally. Independent writers remain outside coverage.
 */
export async function lockSharedAdmission(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('shared-resource-admission:v1', 0))`;
}

export async function assertSharedAdmissionOpen(tx: Tx): Promise<void> {
  if (await tx.admissionFence.findFirst({ select: { nodeId: true } }))
    throw new HttpError(409, 'ADMISSION_FENCED', 'release has closed Control API shared-resource admission');
}

export async function assertNodeAdmissionOpen(tx: Tx, nodeId: string): Promise<void> {
  if (await tx.admissionFence.findUnique({ where: { nodeId }, select: { nodeId: true } }))
    throw new HttpError(409, 'ADMISSION_FENCED', 'release has closed Control API node admission');
}

export async function closeNodeAdmission(nodeId: string, nodeFqdn: string, releaseId: string) {
  admissionFenceRequest.parse({ nodeFqdn, releaseId });
  return getDb().$transaction(async tx => {
    await lockSharedAdmission(tx);
    await lockResourceNode(tx, nodeId);
    const node = await tx.node.findUnique({ where: { id: nodeId }, select: { hostname: true } });
    if (!node || node.hostname !== nodeFqdn)
      throw new HttpError(409, 'RESOURCE_TARGET_INVALID', 'admission fence target differs from canonical inventory');
    const prior = await tx.admissionFence.findUnique({ where: { nodeId } });
    if (prior && (prior.releaseId !== releaseId || prior.nodeFqdn !== nodeFqdn))
      throw new HttpError(409, 'RELEASE_FENCE_CONFLICT', 'A different release already owns the node fence');
    const row = prior ?? await tx.admissionFence.create({ data: { nodeId, nodeFqdn, releaseId } });
    return { nodeId, nodeFqdn, releaseId, closedAt: row.closedAt, coverage: 'control-api-node-reservations' as const };
  });
}

export async function inspectNodeAdmission(nodeId: string) {
  return getDb().$transaction(async tx => {
    await lockResourceNode(tx, nodeId);
    const node = await tx.node.findUnique({ where: { id: nodeId }, select: { hostname: true } });
    if (!node) throw new HttpError(404, 'RESOURCE_TARGET_INVALID', 'managed node is absent');
    const row = await tx.admissionFence.findUnique({ where: { nodeId } });
    return { nodeId, nodeFqdn: node.hostname, closed: Boolean(row), releaseId: row?.releaseId ?? null,
      closedAt: row?.closedAt ?? null, coverage: 'control-api-node-reservations' as const,
      independentWritersCovered: false as const };
  });
}

/** Reopen only this API's future reservations. Enrollment history remains intact. */
export async function releaseNodeAdmission(nodeId: string, nodeFqdn: string, releaseId: string) {
  admissionFenceRequest.parse({ nodeFqdn, releaseId });
  return getDb().$transaction(async tx => {
    await lockSharedAdmission(tx);
    await lockResourceNode(tx, nodeId);
    const node = await tx.node.findUnique({ where: { id: nodeId }, select: { hostname: true } });
    const row = await tx.admissionFence.findUnique({ where: { nodeId } });
    if (!node || node.hostname !== nodeFqdn || !row || row.nodeFqdn !== nodeFqdn || row.releaseId !== releaseId)
      throw new HttpError(409, 'RELEASE_FENCE_CONFLICT', 'Exact managed node fence and release are required');
    const [commands, participants, cron, shared] = await Promise.all([
      tx.commandResourceLease.count({ where: { nodeId, state: { in: ['reserved', 'running', 'unknown'] } } }),
      tx.resourceParticipantWork.count({ where: { nodeId, state: { in: ['reserved', 'running', 'unknown'] } } }),
      tx.managedCronOccurrence.count({ where: { nodeId, state: { not: 'completed' } } }),
      tx.sharedResourceLease.count({ where: { state: { in: ['reserved', 'running', 'unknown'] } } }),
    ]);
    if (commands || participants || cron || shared)
      throw new HttpError(409, 'ADMISSION_WORK_UNSETTLED', 'Control API node or shared work is active or unknown; retain the admission fence');
    await tx.admissionFence.delete({ where: { nodeId } });
    return { nodeId, nodeFqdn, releaseId, closed: false as const, coverage: 'control-api-node-reservations' as const };
  });
}
