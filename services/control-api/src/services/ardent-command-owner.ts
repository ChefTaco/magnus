/**
 * The command owners that hold an Ardent node, and an ADMIN's explicit, audited
 * decision about one whose outcome is unknown.
 *
 * A managed Ardent action owns the node's single execution slot through a
 * command resource lease (docs/COMMAND_RESOURCE_LEASES.md). A failure the node
 * agent finished comes back with a signed receipt and settles the lease. Only a
 * request whose outcome nobody knows stays `unknown`, and then nothing else runs
 * on the node until someone establishes what it did. This module lets an ADMIN
 * record that decision. It never releases a lease by itself, never runs the
 * command again, and never releases one that may still be running:
 *
 * 1. the lease must belong to an Ardent action on this node;
 * 2. its deadline must have passed by the receipt margin, so no delayed request
 *    can still be admitted;
 * 3. the node agent's receipt decides what happens next. A completed result or a
 *    recorded decision settles the lease as the evidence it is. A receipt still
 *    `running` is refused. No receipt at all goes through the signed ledger trace,
 *    the same proof `magnus-server agents doctor --heal` uses, which settles only
 *    what it proves;
 * 4. only an `unknown` receipt takes the ADMIN's decision. The server signs it with
 *    COMMAND_RECONCILIATION_SECRET, bound to the exact request, fence, the ADMIN's
 *    reason and a digest of the node's Ardent inventory, and the node agent records
 *    it under its execution lock. The lease settles only when the node acknowledges
 *    that exact decision.
 */
import { createHash, randomUUID } from 'node:crypto';
import { HTTPError } from 'ky';
import type { ArdentCommandOwner, ArdentCommandReconcile, ArdentCommandReconcileResult } from '@hivemagnus/magnus-contracts';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';
import { commandFenceSchema } from '../schemas/node-responses.js';
import { commandReconciliationSigningPayload, managedCommandOf, NodeApiClient, type CommandReceipt } from '../sdk/node-api-client.js';
import { getNodeManagerSecret } from '../utils/env.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { recoverNodeLeases } from './agent-upgrade-preflight.js';
import { logAuditEvent } from './audit-service.js';
import { ABSENT_RECEIPT_MARGIN_MS, HELD_RESOURCE_STATES } from './command-resource-leases.js';

type Lease = {
  commandId: string; nodeId: string; state: string; label: string | null; completionDescriptorId: string | null;
  requestSha256: string; coordinationJson: string; acquiredAt: Date; dispatchedAt: Date | null; deadline: Date;
  settlement: string | null; evidenceSha256: string | null;
};

const LABEL = /^ardent:([A-Za-z0-9_-]{1,64}):([a-z-]{1,32})$/;

function ownerView(lease: Lease): ArdentCommandOwner {
  const label = lease.label && LABEL.exec(lease.label);
  return {
    commandId: lease.commandId, state: lease.state as ArdentCommandOwner['state'], label: lease.label,
    profile: label ? label[1]! : null, action: label ? label[2]! : null,
    ardent: lease.completionDescriptorId === 'ardent-action',
    acquiredAt: lease.acquiredAt.toISOString(), dispatchedAt: lease.dispatchedAt?.toISOString() ?? null,
    deadline: lease.deadline.toISOString(), reconcilableAfter: new Date(lease.deadline.getTime() + ABSENT_RECEIPT_MARGIN_MS).toISOString(),
  };
}

/** Held command owners per node, oldest first. */
export async function ardentCommandOwners(nodeIds: readonly string[]): Promise<Map<string, ArdentCommandOwner[]>> {
  const rows = nodeIds.length ? await getDb().commandResourceLease.findMany({
    where: { nodeId: { in: [...nodeIds] }, state: { in: [...HELD_RESOURCE_STATES] } }, orderBy: { acquiredAt: 'asc' } }) : [];
  const owners = new Map<string, ArdentCommandOwner[]>(nodeIds.map(id => [id, []]));
  for (const row of rows) owners.get(row.nodeId)?.push(ownerView(row));
  return owners;
}

import { commandReconciliationKey, signNodeDecision } from './server-authorization.js';
export { commandReconciliationKey };

/** How a held owner reads to a person: the action and profile when known, else the command. */
export function describeOwner(owner: Pick<ArdentCommandOwner, 'commandId' | 'action' | 'profile'>): string {
  return owner.action ? `${owner.action} on ${owner.profile} (command ${owner.commandId})` : `command ${owner.commandId}`;
}

/**
 * Why Ardent work on this node is blocked, in words, when an error came from a
 * held or newly uncertain command owner. Undefined for any other failure.
 */
export async function ardentOwnerBlock(nodeId: string, error: unknown): Promise<HttpError | undefined> {
  const commandId = managedCommandOf(error);
  const conflict = error instanceof HttpError && error.code === 'RESOURCE_LEASE_CONFLICT';
  if (!commandId && !conflict) return undefined;
  const db = getDb();
  const lease = commandId
    ? await db.commandResourceLease.findUnique({ where: { commandId } })
    : await db.commandResourceLease.findFirst({ where: { nodeId, state: { in: [...HELD_RESOURCE_STATES] } }, orderBy: { acquiredAt: 'asc' } });
  if (!lease || !HELD_RESOURCE_STATES.includes(lease.state)) return conflict ? error as HttpError : undefined;
  const owner = ownerView(lease);
  if (lease.state !== 'unknown')
    return new HttpError(409, 'RESOURCE_LEASE_CONFLICT', `${describeOwner(owner)} is still running on this node; try again when it finishes`);
  return new HttpError(409, commandId ? 'ARDENT_OUTCOME_UNKNOWN' : 'RESOURCE_LEASE_CONFLICT',
    `${commandId ? 'The node could not confirm the outcome of' : 'Ardent actions on this node wait for'} ${describeOwner(owner)}. `
    + 'An ADMIN must check what it did and reconcile it on the Ardent installations page before other Ardent actions run.');
}

const inflight = new Set<string>();

/**
 * Settle an Ardent command owner from the node agent's evidence, or from an
 * ADMIN's decision when the agent itself holds an unknown outcome. Audited
 * whether it settles or not.
 */
export async function reconcileArdentCommandOwner(nodeId: string, commandId: string, input: ArdentCommandReconcile,
  actor: { actorId: string; details: Record<string, unknown> }, now = Date.now()): Promise<ArdentCommandReconcileResult> {
  const audit = (outcome: string, details: Record<string, unknown>) => logAuditEvent({ action: 'ardent.command-reconcile', actorId: actor.actorId,
    targetType: 'command', targetId: commandId, details: { nodeId, outcome, disposition: input.disposition, reason: input.reason, ...actor.details, ...details } });
  if (inflight.has(commandId)) throw new HttpError(409, 'RECONCILE_IN_PROGRESS', 'Another reconciliation of this command is in progress');
  inflight.add(commandId);
  try {
    const result = await decide(nodeId, commandId, input, actor.actorId, now);
    await audit(result.outcome, { receipt: result.receipt, settlement: result.settlement, evidenceSha256: result.evidenceSha256, decisionId: result.decisionId });
    return result;
  } catch (error: unknown) {
    await audit('refused', { code: error instanceof HttpError ? error.code : 'INTERNAL_ERROR' });
    throw error;
  } finally {
    inflight.delete(commandId);
  }
}

async function decide(nodeId: string, commandId: string, input: ArdentCommandReconcile, actorId: string, now: number): Promise<ArdentCommandReconcileResult> {
  const db = getDb();
  const lease: Lease | null = await db.commandResourceLease.findUnique({ where: { commandId } });
  if (!lease || lease.nodeId !== nodeId) throw new HttpError(404, 'NOT_FOUND', 'This node holds no command owner with that ID');
  const settled = async (receipt: ArdentCommandReconcileResult['receipt'], decisionId: string | null = null): Promise<ArdentCommandReconcileResult> => {
    const row = await db.commandResourceLease.findUniqueOrThrow({ where: { commandId } });
    if (row.state !== 'released') throw new HttpError(409, 'RESOURCE_EVIDENCE_INVALID', 'The node answered, but the command owner is still held');
    return { commandId, outcome: 'settled', receipt, settlement: row.settlement, evidenceSha256: row.evidenceSha256, decisionId };
  };
  if (lease.state === 'released')
    return { commandId, outcome: 'already-settled', receipt: null, settlement: lease.settlement, evidenceSha256: lease.evidenceSha256, decisionId: null };
  if (lease.completionDescriptorId !== 'ardent-action')
    throw new HttpError(409, 'NOT_ARDENT_COMMAND', 'This command is not an Ardent action; reconcile it with POST /api/v1/commands/{commandId}/reconcile-resource');
  if (lease.deadline.getTime() + ABSENT_RECEIPT_MARGIN_MS > now)
    throw new HttpError(409, 'COMMAND_IN_PROGRESS', `The command may still be running until ${new Date(lease.deadline.getTime() + ABSENT_RECEIPT_MARGIN_MS).toISOString()}; try again after that`);
  const node = await db.node.findUnique({ where: { id: nodeId }, select: { id: true, hostname: true, ipAddress: true, port: true } });
  if (!node) throw new HttpError(409, 'RESOURCE_TARGET_INVALID', 'The node of this command is no longer in the inventory');
  const client = new NodeApiClient({ baseUrl: getNodeBaseUrl(node.ipAddress, node.port), nodeToken: getNodeManagerSecret(),
    resourceNodeId: node.id, resourceActorId: actorId });
  const expected = { nodeFqdn: node.hostname, requestSha256: lease.requestSha256 };

  let receipt: CommandReceipt | null;
  try {
    // A completed or reconciled receipt settles the lease here, as evidence.
    receipt = await client.getCommandReceipt(commandId, expected);
  } catch (error: unknown) {
    if (!(error instanceof HTTPError && error.response.status === 404))
      throw new HttpError(503, 'NODE_UNAVAILABLE', `The node agent could not be asked about the command: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
    receipt = null;
  }
  if (!receipt) {
    // No receipt: settle only what the signed ledger trace proves never ran.
    const recovery = (await recoverNodeLeases(nodeId, actorId, now)).find(item => item.commandId === commandId);
    if (recovery?.outcome === 'settled') return settled('absent');
    throw new HttpError(409, 'RECEIPT_ABSENT_UNPROVEN', `The node holds no receipt for the command and its ledger does not prove that it never ran`
      + `${recovery?.code ? ` (${recovery.code}${recovery.detail ? `: ${recovery.detail}` : ''})` : ''}. See docs/COMMAND_RESOURCE_LEASES.md`);
  }
  if (receipt.state === 'completed' || receipt.state === 'reconciled') return settled(receipt.state);
  if (receipt.state === 'running') throw new HttpError(409, 'COMMAND_IN_PROGRESS', 'The node agent is still executing the command');

  // The agent verifies a decision signed with the server key once it has a node key; older agents need the shared HMAC key.
  const decisions = await client.decisionCapabilities().catch(() => ({ serverSignatures: false, hmac: true }));
  if (!decisions.serverSignatures && commandReconciliationKey() === null)
    throw new HttpError(409, 'RECONCILIATION_UNAVAILABLE', 'The node agent has no node key yet; set an independent COMMAND_RECONCILIATION_SECRET (32+ characters) on the server and the node agent to record a decision about an unknown outcome');
  const inventory = await client.getArdentState(10_000).then(reply => JSON.stringify(reply.data ?? null), (error: unknown) => `unavailable: ${error instanceof Error ? error.message : String(error)}`);
  const decisionId = randomUUID();
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
  const evidenceSha256 = sha256(JSON.stringify({ version: 1, kind: 'magnus.ardent-command-reconcile', nodeId, nodeFqdn: node.hostname, commandId,
    requestSha256: lease.requestSha256, label: lease.label, receipt: receipt.state, disposition: input.disposition, reason: input.reason,
    actorId, decidedAt: new Date(now).toISOString(), ardentInventorySha256: sha256(inventory) }));
  const unsigned = { nodeFqdn: node.hostname, commandId, requestSha256: lease.requestSha256,
    coordination: commandFenceSchema.parse(JSON.parse(lease.coordinationJson)), disposition: input.disposition, evidenceSha256,
    approvalRef: `magnus:ardent-command-reconcile:${decisionId}`, decisionId, expiresAt: Date.now() + 120_000 };
  const assertion = signNodeDecision(nodeId, 'command-reconciliation', unsigned, commandReconciliationSigningPayload(unsigned),
    { agentVerifiesServerSignatures: decisions.serverSignatures });
  if (!assertion) throw new HttpError(409, 'RECONCILIATION_UNAVAILABLE', 'No signing authority is available for this node');
  try {
    await client.reconcileCommandReceipt(assertion, expected);
  } catch (error: unknown) {
    const text = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    if (/does not support explicit command reconciliation/.test(text))
      throw new HttpError(409, 'RECONCILIATION_UNAVAILABLE', 'The node agent accepts neither a server-signed decision (it has no node key) nor the server\'s COMMAND_RECONCILIATION_SECRET; set the same key there as on the server');
    if (error instanceof HTTPError) {
      const body = await error.response.clone().json().catch(() => null) as { error?: { code?: unknown; message?: unknown } } | null;
      const code = typeof body?.error?.code === 'string' ? body.error.code : `HTTP_${error.response.status}`;
      // Another decision won the node's execution lock: the lease is settled by that one.
      const current = await db.commandResourceLease.findUnique({ where: { commandId } });
      if (current?.state === 'released') return { commandId, outcome: 'already-settled', receipt: 'reconciled', settlement: current.settlement, evidenceSha256: current.evidenceSha256, decisionId: null };
      if (code === 'RESOURCE_BUSY') throw new HttpError(409, 'COMMAND_IN_PROGRESS', 'The node agent is executing a command; try again when it finishes');
      throw new HttpError(409, 'RECONCILIATION_REFUSED', `The node agent refused the decision (${code}${typeof body?.error?.message === 'string' ? `: ${body.error.message.slice(0, 200)}` : ''})`);
    }
    throw new HttpError(503, 'NODE_UNAVAILABLE', `The decision could not be delivered: ${text}`);
  }
  return settled('unknown', decisionId);
}
