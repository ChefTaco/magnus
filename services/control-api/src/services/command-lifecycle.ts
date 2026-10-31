import { retainUnknownResourceCommand } from './command-resource-leases.js';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';
import { enqueueCommand } from '../queue/workers.js';

export const COMMAND_LEASE_MS = 300_000;
const RESULT_GRACE_MS = 30_000;

/** The worker and cancellation compete for the same QUEUED row. */
export async function cancelQueuedCommand(commandId: string) {
  return getDb().$transaction(async tx => {
    const changed = await tx.remoteCommand.updateMany({
      where: { id: commandId, status: { in: ['PENDING', 'QUEUED'] } },
      data: { status: 'CANCELLED', completedAt: new Date() },
    });
    const command = await tx.remoteCommand.findUnique({ where: { id: commandId } });
    if (!command) throw new HttpError(404, 'NOT_FOUND', 'Command not found');
    if (!changed.count) throw new HttpError(409, 'INVALID_STATE', `Cannot cancel command in ${command.status} state`);
    const { environment: _environment, ...safe } = command;
    return safe;
  });
}

/** Database rows are the admission outbox. Requeue only never-claimed commands;
 * a RUNNING command has an unknown outcome and must never be executed again. */
export async function reconcileCommands(now = new Date()): Promise<void> {
  const db = getDb();
  const candidates = await db.remoteCommand.findMany({
    where: { status: { in: ['QUEUED', 'RUNNING'] } },
    orderBy: { createdAt: 'asc' }, take: 1000,
  });
  for (const command of candidates) {
    const expired = command.status === 'QUEUED'
      ? now.getTime() - command.createdAt.getTime() >= COMMAND_LEASE_MS || Boolean(command.executionDeadline && command.executionDeadline <= now)
      : !command.startedAt || now.getTime() - command.startedAt.getTime() > command.timeoutSeconds * 1000 + RESULT_GRACE_MS;
    if (!expired) {
      if (command.status === 'QUEUED') await enqueueCommand(command.id);
      continue;
    }
    if (command.status === 'RUNNING') await retainUnknownResourceCommand(command.id);
    await db.$transaction(async tx => {
      const changed = await tx.remoteCommand.updateMany({
        where: { id: command.id, status: command.status, startedAt: command.startedAt },
        data: { status: 'FAILED', completedAt: now },
      });
      if (!changed.count) return;
      await tx.commandResult.upsert({
        where: { commandId: command.id },
        create: { commandId: command.id, exitCode: -1, stdout: '', durationMs: 0,
          stderr: command.status === 'RUNNING'
            ? 'Execution interrupted or result overdue; outcome unknown. Not replayed; manual review required.'
            : 'Command expired before execution; not dispatched.',
        }, update: {},
      });
    });
  }
}
