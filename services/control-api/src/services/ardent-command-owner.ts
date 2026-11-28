/**
 * The command owners that hold an Ardent node, and an ADMIN's explicit, audited
 * decision about one whose outcome is unknown.
 *
 * A managed Ardent action owns the node's single execution slot through a
 * command resource lease (docs/COMMAND_RESOURCE_LEASES.md). Only a request whose
 * outcome nobody knows stays `unknown`, and then nothing else runs on the node
 * until someone establishes what it did. The decision itself, shared with other
 * commands, lives in `command-owner-reconcile.ts`; an Ardent decision is also
 * bound to a digest of the node's Ardent inventory.
 */
import type { ArdentCommandOwner, ArdentCommandReconcile, ArdentCommandReconcileResult } from '@hivemagnus/magnus-contracts';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';
import { managedCommandOf } from '../sdk/node-api-client.js';
import { ABSENT_RECEIPT_MARGIN_MS, HELD_RESOURCE_STATES } from './command-resource-leases.js';
import { reconcileCommandOwner } from './command-owner-reconcile.js';

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

import { commandReconciliationKey } from './server-authorization.js';
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

/**
 * Settle an Ardent command owner from the node agent's evidence, or from an
 * ADMIN's decision when the agent itself holds an unknown outcome. Audited
 * whether it settles or not (`services/command-owner-reconcile.ts`).
 */
export async function reconcileArdentCommandOwner(nodeId: string, commandId: string, input: ArdentCommandReconcile,
  actor: { actorId: string; details: Record<string, unknown> }, now = Date.now()): Promise<ArdentCommandReconcileResult> {
  return reconcileCommandOwner(commandId, input, actor, { kind: 'ardent', nodeId, audit: 'ardent.command-reconcile' }, now);
}
