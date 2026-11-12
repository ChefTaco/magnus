/** Explicitly reviewed ownership settlement. Historical outcome stays unknown. */
import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import { embermendCanonical, embermendOperationSchema, embermendSettlementSchema, type EmbermendOperation } from '@hivemagnus/magnus-contracts/embermend';
import { getDb } from '../db/index.js';
import { NodeApiClient, commandReconciliationSigningPayload, commandReconciliationSchema } from '../sdk/node-api-client.js';
import { RESULT_SIGNING_SECRET, getNodeManagerSecret } from '../utils/env.js';
import { assertLiveExecution } from '../config/rehearsal.js';
import { logAuditEvent } from './audit-service.js';
const hash = (value: unknown): string => createHash('sha256').update(embermendCanonical(value)).digest('hex');
export function ownerSettlementEnabled(): boolean {
  const secret = process.env['COMMAND_RECONCILIATION_SECRET'] ?? '';
  return secret.length >= 32 && secret !== RESULT_SIGNING_SECRET && secret !== getNodeManagerSecret();
}
export function ownerSettlementParameters(request: EmbermendOperation) {
  if (request.action.version !== 'execution-settle.v1' || request.action.class !== 'recovery' || request.action.targetKind !== 'host' || request.action.disruption !== 'none') throw new Error('Exact ownership recovery action required');
  return embermendSettlementSchema.parse(request.action.parameters);
}
async function originalOwner(integrationId: string, request: EmbermendOperation, node: { id: string; hostname: string }) {
  const parameters = ownerSettlementParameters(request);
  const original = await getDb().embermendOperation.findUnique({ where: { integrationId_operationId: { integrationId, operationId: parameters.originalOperationId } } });
  if (!original) throw new Error('Original operation missing');
  const originalRequest = embermendOperationSchema.parse(original.request);
  const lease = await getDb().commandResourceLease.findUnique({ where: { commandId: original.commandId } });
  if (original.nodeId !== node.id || original.commandId !== parameters.nativeCommandId || original.requestDigest !== parameters.originalRequestDigest || originalRequest.action.targetId !== request.action.targetId || originalRequest.installationId !== request.installationId || !['reboot.v1', 'ubuntu-oval.v1', 'repository-scan.v1'].includes(originalRequest.action.version) || original.state === 'queued' || Date.parse(originalRequest.expiresAt) > Date.now() || !lease || lease.nodeId !== node.id || lease.requestSha256 !== parameters.nativeRequestDigest || lease.deadline.getTime() > Date.now()) throw new Error('Original operation, supported effect, deadline or lease binding differs');
  return { parameters, original, lease };
}
/** A receipt GET may adopt this exact prior decision after a lost reply, but
 * cannot mint another assertion or invoke reconciliation. */
export async function observeOwnerSettlement(integrationId: string, request: EmbermendOperation, node: { id: string; hostname: string }, client: NodeApiClient) {
  const { parameters, original } = await originalOwner(integrationId, request, node);
  const row = await getDb().embermendOperation.findUniqueOrThrow({ where: { integrationId_operationId: { integrationId, operationId: request.operationId } } });
  const retained = z.object({ assertion: commandReconciliationSchema }).passthrough().safeParse(row.result);
  if (!retained.success) return undefined;
  const receipt = await client.getCommandReceipt(original.commandId, { nodeFqdn: node.hostname, requestSha256: parameters.nativeRequestDigest });
  if (receipt.state !== 'reconciled' || receipt.reconciliation.signature !== retained.data.assertion.signature || receipt.reconciliation.evidenceSha256 !== hash(request) || receipt.reconciliation.approvalRef !== request.authorizationRef || receipt.reconciliation.decisionId !== request.operationId) return undefined;
  const result = { originalOperationId: parameters.originalOperationId, originalRequestDigest: parameters.originalRequestDigest, originalOutcome: 'unknown', ownershipSettled: true, reviewEvidenceId: parameters.evidenceId, reviewEvidenceDigest: parameters.evidenceDigest, disposition: receipt.reconciliation.disposition, nativeCommandId: original.commandId, reconciliation: receipt.reconciliation };
  await getDb().embermendOperation.update({ where: { id: row.id }, data: { state: 'completed' } });
  return result;
}
export async function settleEmbermendOwner(integrationId: string, request: EmbermendOperation, node: { id: string; hostname: string }, client: NodeApiClient): Promise<void> {
  assertLiveExecution();
  if (!ownerSettlementEnabled() || Date.parse(request.expiresAt) <= Date.now()) throw new Error('Current recovery authority required');
  const { parameters, original, lease } = await originalOwner(integrationId, request, node);
  if (lease.state !== 'unknown') throw new Error('Only an expired unknown owner can be explicitly settled');
  const before = await client.getCommandReceipt(original.commandId, { nodeFqdn: node.hostname, requestSha256: parameters.nativeRequestDigest });
  if (before.state !== 'unknown') throw new Error('Native execution is active or already settled');
  const coordination = z.object({ version: z.literal(1), resourceKey: z.string(), fence: z.string(), expiresAt: z.number() }).strict().parse(JSON.parse(lease.coordinationJson));
  const unsigned = { nodeFqdn: node.hostname, commandId: original.commandId, requestSha256: parameters.nativeRequestDigest, coordination, disposition: parameters.disposition, evidenceSha256: hash(request), approvalRef: request.authorizationRef, decisionId: request.operationId, expiresAt: Math.min(Date.parse(request.expiresAt), Date.now() + 240000) };
  const assertion = commandReconciliationSchema.parse({ ...unsigned, signature: createHmac('sha256', process.env['COMMAND_RECONCILIATION_SECRET'] ?? '').update(commandReconciliationSigningPayload(unsigned)).digest('hex') });
  // Commit the exact decision before delivery. A restart only reads this decision.
  await getDb().embermendOperation.update({ where: { integrationId_operationId: { integrationId, operationId: request.operationId } }, data: { result: { assertion } } });
  await logAuditEvent({ action: 'embermend.owner_settlement', actorId: 'service:embermend:' + integrationId, targetType: 'command', targetId: original.commandId, details: { recoveryOperationId: request.operationId, originalOperationId: parameters.originalOperationId, authorizationRef: request.authorizationRef, evidenceId: parameters.evidenceId, originalOutcome: 'unknown' } });
  await client.reconcileCommandReceipt(assertion, { nodeFqdn: node.hostname, requestSha256: parameters.nativeRequestDigest });
  if (!await observeOwnerSettlement(integrationId, request, node, client)) throw new Error('Exact native settlement acknowledgement unavailable');
}
