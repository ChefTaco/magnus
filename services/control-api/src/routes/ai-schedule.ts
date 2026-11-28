import { optional } from '../utils/optional.js';
import { pagination } from '../utils/query.js';
/**
 * ai-schedule.ts — Routes for Scheduled AI Operations.
 *
 * CRUD + manual trigger for recurring AI tasks.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  createScheduledOp,
  updateScheduledOp,
  deleteScheduledOp,
  listScheduledOps,
  getScheduledOp,
  executeDueOps,
} from '../services/ai-schedule-service.js';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, getUser, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { logAuditEvent } from '../services/audit-service.js';
import { parseBody } from '../utils/validate.js';
import { isCronExpression } from '../services/cron-next-run.js';

export const aiScheduleRouter = new Hono<AppVariables>();

aiScheduleRouter.use('*', authMiddleware);

const cronExpr = z.string().min(5).max(100).refine(isCronExpression, {
  message: 'cronExpr must be a five-field cron expression (minute hour day-of-month month day-of-week) using numbers, *, ranges, steps and lists',
});

const CreateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  cronExpr,
  type: z.enum(['chat', 'analysis', 'runbook']).optional(),
  prompt: z.string().min(1).max(5000),
  nodeId: z.string().optional(),
});

const UpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  cronExpr: cronExpr.optional(),
  prompt: z.string().min(1).max(5000).optional(),
  enabled: z.boolean().optional(),
  nodeId: z.string().nullable().optional(),
});

// List scheduled ops
aiScheduleRouter.get('/', async (c) => {
  const { page, pageSize: limit } = pagination(c, { pageSize: 20, maxPageSize: 100, pageSizeParam: 'limit' });

  const { data, total } = await listScheduledOps(page, limit);
  return c.json({
    data,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

// Get single scheduled op
aiScheduleRouter.get('/:id', async (c) => {
  const op = await getScheduledOp(c.req.param('id'));
  if (!op) throw new HttpError(404, 'NOT_FOUND', 'Scheduled operation not found');
  return c.json({ data: op });
});

// Create scheduled op
aiScheduleRouter.post('/', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const body = await parseBody(c, CreateSchema);
  const user = c.get('user');

  const op = await createScheduledOp({ "name": body.name, "cronExpr": body.cronExpr, "prompt": body.prompt, ...optional("description", body.description), ...optional("type", body.type), ...optional("nodeId", body.nodeId), createdBy: user?.email ?? user?.userId ?? 'unknown' });
  await logAuditEvent({ action: 'ai_schedule.create', actorId: getUser(c).userId, targetType: 'ai-schedule', targetId: op.id,
    details: { name: body.name, cronExpr: body.cronExpr, type: body.type ?? 'chat', nodeId: body.nodeId ?? null } });

  return c.json({ data: op }, 201);
});

// Update scheduled op
aiScheduleRouter.patch('/:id', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const body = await parseBody(c, UpdateSchema);

  const id = c.req.param('id')!;
  const op = await updateScheduledOp(id, { ...optional("name", body.name), ...optional("description", body.description), ...optional("cronExpr", body.cronExpr), ...optional("prompt", body.prompt), ...optional("enabled", body.enabled), ...optional("nodeId", body.nodeId) });
  // The prompt is free text: record that it changed, not what it says.
  await logAuditEvent({ action: 'ai_schedule.update', actorId: getUser(c).userId, targetType: 'ai-schedule', targetId: id,
    details: { changedFields: Object.keys(body).sort(), ...optional('enabled', body.enabled), ...optional('cronExpr', body.cronExpr), ...optional('nodeId', body.nodeId) } });
  return c.json({ data: op });
});

// Delete scheduled op
aiScheduleRouter.delete('/:id', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const id = c.req.param('id')!;
  const op = await deleteScheduledOp(id);
  await logAuditEvent({ action: 'ai_schedule.delete', actorId: getUser(c).userId, targetType: 'ai-schedule', targetId: id, details: { name: op.name } });
  return c.json({ success: true });
});

// Manually trigger all due ops (admin/cron endpoint)
aiScheduleRouter.post('/execute-due', requireRole('ADMIN'), async (c) => {
  // Each run is audited as ai_schedule.run with this user as the actor.
  const executed = await executeDueOps(undefined, { actorId: getUser(c).userId, actorType: 'user' });
  return c.json({ success: true, data: { executed } });
});
