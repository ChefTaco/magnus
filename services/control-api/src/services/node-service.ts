/**
 * Node cascade-delete helper.
 *
 * Deletes all related records in dependency order before removing the
 * Node row itself.  Used by both the hard-delete route and the migrate
 * route in `routes/nodes.ts`.
 */
import { getDb } from '../db/index.js';

/** Remove a node and all child records in the correct dependency order. */
export async function deleteNodeCascade(nodeId: string): Promise<void> {
  const db = getDb();
  await db.$transaction(async (tx) => {
    // Hermes posture is node-owned snapshot state. The schema cascade is the
    // final invariant; this explicit delete also supports databases created
    // before the foreign-key migration is deployed.
    await tx.hermesInstallation.deleteMany({ where: { nodeId } });
    await tx.rolloutTarget.deleteMany({ where: { nodeId } });
    await tx.skillInstallation.deleteMany({ where: { nodeId } });
    await tx.cronJobExecution.deleteMany({ where: { nodeId } });
    await tx.cronJob.deleteMany({ where: { nodeId } });
    await tx.filePatchTask.deleteMany({ where: { nodeId } });
    // Anomaly records protect their source snapshots from retention. Explicit
    // node deletion removes that evidence relationship before its snapshots.
    await tx.anomalyEvent.deleteMany({ where: { nodeId } });
    // The schema FK cascades this after migration; keep the explicit cleanup so
    // node deletion is deterministic across rolling upgrades.
    await tx.engineeringMetricSample.deleteMany({ where: { nodeId } });
    await tx.healthSnapshot.deleteMany({ where: { nodeId } });
    await tx.logEntry.deleteMany({ where: { nodeId } });
    await tx.remoteCommand.deleteMany({ where: { nodeId } });
    await tx.agent.deleteMany({ where: { nodeId } });
    await tx.node.delete({ where: { id: nodeId } });
  });
}
