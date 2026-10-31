import type { Prisma } from '../db/generated/prisma/client.js';
import { HttpError } from '../middleware/error-handler.js';
type Tx = Prisma.TransactionClient;
function fail(code: string, message: string): never { throw new HttpError(409, code, message); }
export async function lockResourceNode(tx: Tx, nodeId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`command-resource-node:${nodeId}`}, 0))`;
}
export async function resourceNodeIdentity(tx: Tx, nodeId: string) {
  const node = await tx.node.findUnique({ where: { id: nodeId } });
  if (!node) throw new HttpError(404, 'NODE_NOT_FOUND', 'Inventory node not found');
  const duplicate = await tx.node.count({ where: { hostname: node.hostname } });
  if (duplicate !== 1) fail('RESOURCE_TARGET_INVALID', 'Canonical inventory identity is ambiguous');
  const row = await tx.resourceEnrollment.findUnique({ where: { nodeId } });
  if (row && row.nodeFqdn !== node.hostname) fail('RESOURCE_TARGET_INVALID', 'Enrollment inventory identity changed');
  return { node, row };
}
