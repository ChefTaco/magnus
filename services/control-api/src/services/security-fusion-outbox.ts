import { getDb } from '../db/index.js';
import { enqueueCommand } from '../queue/workers.js';
import { securityFusionActionSources } from './security-fusion-actions.js';

const OUTBOX_LEASE_MS = 30_000;
const OUTBOX_INTERVAL_MS = 2_000;
/**
 * Absolute path of an operator-installed containment helper on managed nodes
 * (`SECURITY_FUSION_CONTAINMENT_COMMAND`). Magnus does not ship one; without it
 * release records fail closed and stay visible for manual handling.
 */
function containmentCommand(): string {
  const command = process.env['SECURITY_FUSION_CONTAINMENT_COMMAND']?.trim() ?? '';
  if (!/^\/[A-Za-z0-9._/-]{1,255}$/.test(command) || command.includes('..'))
    throw new Error('SECURITY_FUSION_CONTAINMENT_COMMAND is not configured');
  return command;
}

function containmentArgs(
  operation: string,
): string[] {
  if (operation !== 'release') throw new Error('Embedded containment execute authority is retired');
  return ['release'];
}

async function dispatchOutboxRecord(outboxId: string): Promise<boolean> {
  const db = getDb();
  const now = new Date();
  const claimed = await db.securityFusionCommandOutbox.updateMany({
    where: {
      id: outboxId,
      operation: 'release',
      OR: [
        { status: { in: ['pending', 'failed'] }, nextAttemptAt: { lte: now } },
        { status: 'dispatching', leaseExpiresAt: { lt: now } },
      ],
    },
    data: {
      status: 'dispatching',
      leaseExpiresAt: new Date(now.getTime() + OUTBOX_LEASE_MS),
      attempts: { increment: 1 },
      lastError: null,
    },
  });
  if (claimed.count !== 1) return false;

  const outbox = await db.securityFusionCommandOutbox.findUnique({ where: { id: outboxId } });
  const action = outbox
    ? await db.securityFusionAction.findUnique({ where: { id: outbox.actionId } })
    : null;
  if (!outbox || !action) throw new Error('Security Fusion outbox references a missing action');
  const node = await db.node.findUnique({ where: { id: action.nodeId } });
  if (!node) throw new Error('Security Fusion containment target no longer exists');

  const command = containmentCommand();
  const args = containmentArgs(outbox.operation);
  const idempotencyKey = `security-fusion:${action.id}:${node.id}:${outbox.operation}`;
  const remote = await db.remoteCommand.upsert({
    where: { idempotencyKey },
    create: {
      nodeId: node.id,
      command,
      args: JSON.stringify(args),
      environment: '{}',
      timeoutSeconds: 120,
      status: 'QUEUED',
      riskLevel: 'high',
      idempotencyKey,
      correlationId: outbox.id,
      createdBy: outbox.actorId,
    },
    update: {},
  });
  await db.securityFusionCommandOutbox.update({
    where: { id: outbox.id },
    data: { remoteCommandId: remote.id },
  });

  await enqueueCommand(remote.id);

  await db.$transaction([
    db.securityFusionCommandOutbox.update({
      where: { id: outbox.id },
      data: {
        status: 'dispatched',
        leaseExpiresAt: null,
        lastError: null,
        dispatchedAt: new Date(),
      },
    }),
    db.securityFusionAction.updateMany({
      where: {
        id: action.id,
        status: {
          in: securityFusionActionSources('releasing'),
        },
      },
      data: {
        status: 'releasing',
        resultJson: JSON.stringify({
          commandId: remote.id,
          outboxId: outbox.id,
          operation: outbox.operation,
        }),
      },
    }),
  ]);
  return true;
}

export async function dispatchSecurityFusionOutbox(): Promise<number> {
  const db = getDb();
  const now = new Date();
  // Initial containment belongs exclusively to the standalone Security Fusion
  // service. Keep only the independent emergency release path in this embedded
  // compatibility service, and quarantine any row old code could retry.
  await db.securityFusionCommandOutbox.updateMany({
    where: {
      operation: 'execute',
      status: { in: ['pending', 'failed'] },
    },
    data: {
      status: 'blocked',
      leaseExpiresAt: null,
      lastError: 'Embedded execute quarantined; standalone Security Fusion approval is required',
    },
  });
  await db.securityFusionCommandOutbox.updateMany({
    where: {
      operation: 'execute',
      status: { in: ['dispatching', 'unknown'] },
    },
    data: {
      status: 'blocked',
      leaseExpiresAt: null,
      lastError: 'Embedded execute quarantined; execution may have occurred; do not retry',
    },
  });
  const records = await db.securityFusionCommandOutbox.findMany({
    where: {
      operation: 'release',
      OR: [
        { status: { in: ['pending', 'failed'] }, nextAttemptAt: { lte: now } },
        { status: 'dispatching', leaseExpiresAt: { lt: now } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: 20,
  });
  let dispatched = 0;
  for (const record of records) {
    try {
      if (await dispatchOutboxRecord(record.id)) dispatched += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryDelay = Math.min(60_000, 1_000 * (2 ** Math.min(record.attempts, 6)));
      await db.securityFusionCommandOutbox.updateMany({
        where: { id: record.id, status: 'dispatching' },
        data: {
          status: 'failed',
          leaseExpiresAt: null,
          lastError: message.slice(0, 1000),
          nextAttemptAt: new Date(Date.now() + retryDelay),
        },
      });
      console.error(`[security-fusion] outbox dispatch failed for ${record.id}: ${message}`);
    }
  }
  return dispatched;
}

let dispatcherTimer: ReturnType<typeof setInterval> | null = null;

export function startSecurityFusionOutboxDispatcher(): void {
  if (dispatcherTimer) return;
  const dispatch = () => {
    void dispatchSecurityFusionOutbox().catch((error: unknown) => {
      console.error('[security-fusion] outbox scan failed', error instanceof Error ? error.message : String(error));
    });
  };
  dispatch();
  dispatcherTimer = setInterval(dispatch, OUTBOX_INTERVAL_MS);
  dispatcherTimer.unref();
}

export function stopSecurityFusionOutboxDispatcher(): void {
  if (dispatcherTimer) clearInterval(dispatcherTimer);
  dispatcherTimer = null;
}
