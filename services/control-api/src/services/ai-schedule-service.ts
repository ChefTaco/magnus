import { optional } from '../utils/optional.js';
/**
 * ai-schedule-service.ts — Scheduled AI Operations.
 *
 * Manages recurring AI operations (fleet analysis, reports, runbooks)
 * using five-field cron expressions (see cron-next-run.ts). Due operations run when
 * POST /ai-schedules/execute-due is called, and every minute from the server when
 * MAGNUS_AI_SCHEDULER_ENABLED=true.
 */

import { getDb } from '../db/index.js';
import { chat } from './ai-assistant-service.js';
import { nanoid } from 'nanoid';
import { nextCronRun } from './cron-next-run.js';
import { errorText } from '../utils/redact.js';
import { logAuditEvent } from './audit-service.js';

/** Who started a batch of scheduled runs: the server's scheduler, or a user through POST /ai-schedules/execute-due. */
export interface ScheduledRunActor {
  actorId: string;
  actorType: 'user' | 'system';
}

const SCHEDULER_ACTOR: ScheduledRunActor = { actorId: 'ai-scheduler', actorType: 'system' };

/** Audit one run. A failed audit write is logged; it must not stop the other due operations. */
async function auditRun(actor: ScheduledRunActor, opId: string, details: Record<string, unknown>): Promise<void> {
  await logAuditEvent({ action: 'ai_schedule.run', actorId: actor.actorId, actorType: actor.actorType, targetType: 'ai-schedule', targetId: opId, details })
    .catch((error: unknown) => console.error(`[ai-schedule] ${opId}: audit event not written: ${errorText(error)}`));
}

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
 *
 * Each row is claimed before it runs: a compare-and-set moves `nextRunAt` from the value read to
 * the next occurrence, so concurrent callers (the scheduler, `POST /ai-schedules/execute-due`, a
 * second server) run every occurrence once. A run that fails is not retried until its next turn.
 */
export async function executeDueOps(now: () => Date = () => new Date(), actor: ScheduledRunActor = SCHEDULER_ACTOR): Promise<number> {
  const db = getDb();

  const dueOps = await db.aiScheduledOp.findMany({
    where: {
      enabled: true,
      nextRunAt: { lte: now() },
    },
    orderBy: { nextRunAt: 'asc' },
    take: 10,
  });

  let executed = 0;

  for (const op of dueOps) {
    const startedAt = now();
    const claim = await db.aiScheduledOp.updateMany({
      where: { id: op.id, enabled: true, nextRunAt: op.nextRunAt },
      data: { nextRunAt: parseCronToNextRun(op.cronExpr), lastRunAt: startedAt },
    });
    if (claim.count !== 1) continue; // another caller has this occurrence, or the op changed

    try {
      const result = await chat({ message: op.prompt, type: op.type as 'chat' | 'analysis', ...optional("nodeId", op.nodeId ?? undefined), createdBy: `scheduler:${op.id}` });
      // A scheduled run never executes a tool that needs approval: nobody is there to approve it,
      // so the run stops at that tool and is recorded as not completed, naming the tool.
      const waiting = result.pendingApproval?.toolName;
      await db.aiScheduledOp.update({
        where: { id: op.id },
        data: {
          runCount: { increment: 1 },
          lastResult: result.content.slice(0, 2000),
          lastError: waiting
            ? `Stopped: the operation asked to run ${waiting}, which needs approval; scheduled operations do not run such tools unattended (conversation ${result.conversationId})`
            : null,
        },
      });
      if (!waiting) executed++;
      await auditRun(actor, op.id, { outcome: waiting ? 'stopped' : 'completed', conversationId: result.conversationId ?? null,
        ...(waiting ? { toolName: waiting } : {}) });
    } catch (err) {
      await db.aiScheduledOp.update({
        where: { id: op.id },
        data: { runCount: { increment: 1 }, lastError: err instanceof Error ? err.message.slice(0, 2000) : 'Unknown error' },
      }).catch((error: unknown) => console.error(`[ai-schedule] ${op.id}: result not recorded: ${errorText(error)}`));
      await auditRun(actor, op.id, { outcome: 'failed', error: errorText(err) });
    }
  }

  return executed;
}

let schedulerTimer: ReturnType<typeof setInterval> | undefined;
let schedulerBusy = false;

/** MAGNUS_AI_SCHEDULER_ENABLED=true runs due operations every minute from the server itself. */
export function aiSchedulerEnabled(): boolean {
  return (process.env['MAGNUS_AI_SCHEDULER_ENABLED'] ?? 'false').toLowerCase() === 'true';
}

export function startAiScheduler(intervalMs = 60_000): boolean {
  if (schedulerTimer || !aiSchedulerEnabled()) return false;
  const tick = async () => {
    if (schedulerBusy) return;
    schedulerBusy = true;
    try {
      const ran = await executeDueOps();
      if (ran > 0) console.log(`[ai-schedule] ran ${ran} scheduled operation(s)`);
    } catch (error) {
      console.error(`[ai-schedule] tick failed: ${errorText(error)}`);
    } finally {
      schedulerBusy = false;
    }
  };
  schedulerTimer = setInterval(() => void tick(), intervalMs);
  schedulerTimer.unref?.();
  return true;
}

export function stopAiScheduler(): void {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = undefined;
}
