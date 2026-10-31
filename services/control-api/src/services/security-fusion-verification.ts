import { getDb } from '../db/index.js';
import { securityFusionActionSources } from './security-fusion-actions.js';

/** Derive a durable verification deadline from the signed command's persisted
 * completion, not a process-local timer or a heartbeat preceding the action. */
export async function reconcileRestartVerification(now = new Date()): Promise<void> {
  const db = getDb();
  const actions = await db.securityFusionAction.findMany({
    where: { kind: 'service_restart', status: { in: ['dispatch_pending', 'executing', 'verifying'] } },
    orderBy: { createdAt: 'asc' }, take: 100,
  });
  for (const action of actions) {
    const outbox = await db.securityFusionCommandOutbox.findFirst({ where: { actionId: action.id, operation: 'execute' } });
    if (!outbox?.remoteCommandId) continue;
    const command = await db.remoteCommand.findUnique({ where: { id: outbox.remoteCommandId }, include: { result: true } });
    if (!command || !['COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED'].includes(command.status)) continue;
    const completedAt = command.completedAt;
    const successful = command.status === 'COMPLETED' && command.result?.exitCode === 0;
    const snapshot = successful && completedAt ? await db.healthSnapshot.findFirst({
      where: { nodeId: action.nodeId, timestamp: { gt: completedAt, gte: new Date(now.getTime() - 120_000), lte: now } },
      orderBy: { timestamp: 'desc' },
    }) : null;
    let active = false;
    try {
      const services: unknown = snapshot ? JSON.parse(snapshot.services) : [];
      const name = action.serviceName?.replace(/\.service$/, '');
      active = Boolean(name && Array.isArray(services) && services.some(s =>
        s && typeof s.name === 'string' && s.name.replace(/\.service$/, '') === name && s.status === 'active'));
    } catch { /* malformed evidence never proves recovery */ }
    const expired = !completedAt || now.getTime() - completedAt.getTime() >= 180_000;
    const status = !successful || expired ? 'failed' : active ? 'succeeded' : 'verifying';
    await db.$transaction(async tx => {
      const changed = await tx.securityFusionAction.updateMany({
        where: { id: action.id, status: { in: securityFusionActionSources(status) } },
        data: { status, resultJson: JSON.stringify({ commandId: command.id,
          commandCompletedAt: completedAt?.toISOString(), verificationDeadline: completedAt ? new Date(completedAt.getTime() + 180_000).toISOString() : null,
          serviceName: action.serviceName, serviceVerified: active, snapshotId: snapshot?.id ?? null,
          reason: !successful ? 'Command failed or outcome unknown' : expired ? 'Service recovery verification expired' : active ? 'Fresh service evidence passed' : 'Awaiting fresh service evidence',
        }) },
      });
      if (changed.count && status !== 'verifying') await tx.securityFusionCaseActivity.create({ data: {
        caseId: action.caseId, kind: `containment.${status}`, actorId: 'system:command-reconciler',
        detailJson: JSON.stringify({ actionId: action.id, commandId: command.id, serviceVerified: active, snapshotId: snapshot?.id ?? null }),
      } });
    });
  }
}
