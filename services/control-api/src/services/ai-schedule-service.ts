import { optional } from '../utils/optional.js';
/**
 * ai-schedule-service.ts — Scheduled AI Operations.
 *
 * Manages recurring AI operations (fleet analysis, reports, runbooks)
 * using five-field cron expressions (see cron-next-run.ts). Due operations run when
 * POST /ai-schedules/execute-due is called.
 */

import { getDb } from '../db/index.js';
import { chat } from './ai-assistant-service.js';
import { nanoid } from 'nanoid';
import { nextCronRun } from './cron-next-run.js';

/**
 * When the operation runs next. An expression that cannot be scheduled (only possible for a row
 * stored before expressions were validated) is retried in an hour instead of running in a loop.
 */
function parseCronToNextRun(cronExpr: string): Date {
  return nextCronRun(cronExpr) ?? new Date(Date.now() + 3600_000);
}

export async function createScheduledOp(params: {
  name: string;
  description?: string;
  cronExpr: string;
  type?: string;
  prompt: string;
  nodeId?: string;
  createdBy: string;
}) {
  const db = getDb();
  const nextRunAt = parseCronToNextRun(params.cronExpr);

  return db.aiScheduledOp.create({
    data: {
      id: nanoid(),
      name: params.name,
      description: params.description ?? '',
      cronExpr: params.cronExpr,
      type: params.type ?? 'chat',
      prompt: params.prompt,
      nodeId: params.nodeId ?? null,
      createdBy: params.createdBy,
      nextRunAt,
    },
  });
}

export async function updateScheduledOp(
  id: string,
  updates: { name?: string; description?: string; cronExpr?: string; prompt?: string; enabled?: boolean; nodeId?: string | null },
) {
  const db = getDb();
  const data: Record<string, unknown> = {};

  if (updates.name !== undefined) data.name = updates.name;
  if (updates.description !== undefined) data.description = updates.description;
  if (updates.prompt !== undefined) data.prompt = updates.prompt;
  if (updates.enabled !== undefined) data.enabled = updates.enabled;
  if (updates.nodeId !== undefined) data.nodeId = updates.nodeId;
  if (updates.cronExpr !== undefined) {
    data.cronExpr = updates.cronExpr;
    data.nextRunAt = parseCronToNextRun(updates.cronExpr);
  }

  return db.aiScheduledOp.update({ where: { id }, data });
}

export async function deleteScheduledOp(id: string) {
  const db = getDb();
  return db.aiScheduledOp.delete({ where: { id } });
}

export async function listScheduledOps(page = 1, limit = 20) {
  const db = getDb();
  const [data, total] = await Promise.all([
    db.aiScheduledOp.findMany({
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    db.aiScheduledOp.count(),
  ]);
  return { data, total };
}

export async function getScheduledOp(id: string) {
  const db = getDb();
  return db.aiScheduledOp.findUnique({ where: { id } });
}

/**
 * Execute due scheduled operations.
 * Called periodically (e.g. every minute by BullMQ repeatable job).
 */
export async function executeDueOps(): Promise<number> {
  const db = getDb();

  const dueOps = await db.aiScheduledOp.findMany({
    where: {
      enabled: true,
      nextRunAt: { lte: new Date() },
    },
    take: 10,
  });

  let executed = 0;

  for (const op of dueOps) {
    try {
      const result = await chat({ message: op.prompt, type: op.type as 'chat' | 'analysis', ...optional("nodeId", op.nodeId ?? undefined), createdBy: `scheduler:${op.id}` });

      const nextRunAt = parseCronToNextRun(op.cronExpr);

      await db.aiScheduledOp.update({
        where: { id: op.id },
        data: {
          lastRunAt: new Date(),
          nextRunAt,
          runCount: { increment: 1 },
          lastResult: result.content.slice(0, 2000),
          lastError: null,
        },
      });

      executed++;
    } catch (err) {
      const nextRunAt = parseCronToNextRun(op.cronExpr);
      await db.aiScheduledOp.update({
        where: { id: op.id },
        data: {
          lastRunAt: new Date(),
          nextRunAt,
          runCount: { increment: 1 },
          lastError: err instanceof Error ? err.message : 'Unknown error',
        },
      });
    }
  }

  return executed;
}
