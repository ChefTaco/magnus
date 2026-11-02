/**
 * Repairing the distance between the server's command fence generation and a
 * node ledger that has seen a higher fence (written by an older build, or
 * surviving a database restore). A fence is an ordering token the server
 * owns: the ledger refuses anything at or below its high-water, so the only
 * safe repair is to move the server's generation UP.
 *
 * Trust, precisely. The value must be signed with the fleet's result key, under
 * a nonce this server just chose (a preflight) or bound to this node's lease and
 * request (a STALE_FENCE refusal), and it must arrive over a connection this server
 * opened to the node's inventory address. Only that node's own keys are accepted, and
 * the cap keeps a value from pushing the column near BIGINT overflow. The result
 * key and the node credential are shared by the fleet, so these signatures tell
 * agents apart only by what they claim: whoever holds them can sign for any node.
 * The limit is the connection, which ends at whatever the inventory says. A
 * heartbeat with the fleet credential can repoint a node only while its stored
 * address is loopback or unroutable (shouldRepairNodeIp), or to the DNS name of its own
 * agent certificate; a routable address stays. So a holder of the fleet secrets,
 * with a certificate the server trusts for its own address, could answer for a node
 * in that state. It can then inflate that node's counters and settle its leases that
 * left no receipt there. The cost of the counter is only numbering: a generation
 * moves up and nothing depends on its size.
 * Heartbeat values are never used for this.
 *
 * command_resource_fences has no database trigger. The increase-only triggers
 * guard the separate shared_resource_fences table, so "never lower" is enforced
 * here, under the same advisory lock admission takes for this node.
 */
import { getDb } from '../db/index.js';
import { logAuditEvent } from './audit-service.js';

/** Well below BIGINT's 9223372036854775807, with room for every later increment. */
export const FENCE_HIGH_WATER_CAP = 4_000_000_000_000_000_000n;

export type FenceCheck = { ok: true; value: bigint } | { ok: false; code: 'FENCE_INVALID' | 'FENCE_OVERFLOW'; detail: string };

/** A node's fences live under `node:<id>` or `node:<id>:<scope>`. */
export const isOwnFenceKey = (nodeId: string, resourceKey: string): boolean => resourceKey === `node:${nodeId}` || resourceKey.startsWith(`node:${nodeId}:`);

export function checkReportedFence(nodeId: string, resourceKey: string, value: unknown): FenceCheck {
  if (!isOwnFenceKey(nodeId, resourceKey)) return { ok: false, code: 'FENCE_INVALID', detail: `reported a fence for ${resourceKey.slice(0, 100)}, which is not its own` };
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value)) return { ok: false, code: 'FENCE_INVALID', detail: `reported a fence for ${resourceKey} that is not a positive decimal` };
  const parsed = BigInt(value);
  if (parsed > FENCE_HIGH_WATER_CAP) return { ok: false, code: 'FENCE_OVERFLOW', detail: `reports fence ${value} for ${resourceKey}, above the ${FENCE_HIGH_WATER_CAP} the server adopts` };
  return { ok: true, value: parsed };
}

/** The generation admission would hand out next is below or at the agent's high-water. */
export const fenceIsAhead = (highWater: bigint, generation: bigint): boolean => highWater >= generation + 1n;

export type FenceAdvance =
  | { status: 'advanced'; from: bigint; to: bigint }
  | { status: 'current' }
  | { status: 'rejected'; code: 'FENCE_INVALID' | 'FENCE_OVERFLOW'; detail: string };

/** Move the generation to high-water + 1, audited. Never lowers: the check and the write hold the node's admission lock. */
export async function advanceCommandFence(input: { nodeId: string; resourceKey: string; highWater: unknown; source: string; actorId?: string }): Promise<FenceAdvance> {
  const check = checkReportedFence(input.nodeId, input.resourceKey, input.highWater);
  if (!check.ok) {
    console.warn(`[command-fence] node ${input.nodeId} ${check.detail}; generation unchanged`);
    return { status: 'rejected', code: check.code, detail: check.detail };
  }
  const moved = await getDb().$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`command-resource-node:${input.nodeId}`}, 0))`;
    const row = await tx.commandResourceFence.findUnique({ where: { resourceKey: input.resourceKey } });
    const from = row?.generation ?? 0n;
    if (!fenceIsAhead(check.value, from)) return null;
    const to = check.value + 1n;
    await tx.commandResourceFence.upsert({ where: { resourceKey: input.resourceKey },
      create: { resourceKey: input.resourceKey, generation: to }, update: { generation: to } });
    return { from, to };
  });
  if (!moved) return { status: 'current' };
  await logAuditEvent({ action: 'agent.fence.advanced', actorId: input.actorId ?? 'system:agent-upgrade', actorType: 'system', targetType: 'node', targetId: input.nodeId,
    details: { resourceKey: input.resourceKey, oldGeneration: moved.from.toString(), newGeneration: moved.to.toString(), reportedHighWater: check.value.toString(), source: input.source } })
    .catch((error: unknown) => console.warn(`[command-fence] audit of ${input.nodeId} failed: ${error instanceof Error ? error.message : String(error)}`));
  return { status: 'advanced', ...moved };
}
