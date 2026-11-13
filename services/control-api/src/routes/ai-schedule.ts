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
import { authMiddleware, requireRole } from '../middleware/auth.js';
import { parseBody } from '../utils/validate.js';
import { isCronExpression } from '../services/cron-next-run.js';

export const aiScheduleRouter = new Hono();

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
  if (!op) return c.json({ success: false, error: 'Not found' }, 404);
  return c.json({ data: op });
});

// Create scheduled op
aiScheduleRouter.post('/', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const body = await parseBody(c, CreateSchema);
  const user = c.get('user');

  const op = await createScheduledOp({ "name": body.name, "cronExpr": body.cronExpr, "prompt": body.prompt, ...optional("description", body.description), ...optional("type", body.type), ...optional("nodeId", body.nodeId), createdBy: user?.email ?? user?.userId ?? 'unknown' });

  return c.json({ data: op }, 201);
});

// Update scheduled op
aiScheduleRouter.patch('/:id', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const body = await parseBody(c, UpdateSchema);

  const op = await updateScheduledOp(c.req.param('id')!, { ...optional("name", body.name), ...optional("description", body.description), ...optional("cronExpr", body.cronExpr), ...optional("prompt", body.prompt), ...optional("enabled", body.enabled), ...optional("nodeId", body.nodeId) });
  return c.json({ data: op });
});

// Delete scheduled op
aiScheduleRouter.delete('/:id', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  await deleteScheduledOp(c.req.param('id')!);
  return c.json({ success: true });
});

// Manually trigger all due ops (admin/cron endpoint)
aiScheduleRouter.post('/execute-due', requireRole('ADMIN'), async (c) => {
  const executed = await executeDueOps();
  return c.json({ success: true, data: { executed } });
});
