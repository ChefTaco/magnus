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

export const aiScheduleRouter = new Hono();

aiScheduleRouter.use('*', authMiddleware);

const CreateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  cronExpr: z.string().min(5).max(100),
  type: z.enum(['chat', 'analysis', 'runbook']).optional(),
  prompt: z.string().min(1).max(5000),
  nodeId: z.string().optional(),
});

const UpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  cronExpr: z.string().min(5).max(100).optional(),
  prompt: z.string().min(1).max(5000).optional(),
  enabled: z.boolean().optional(),
  nodeId: z.string().nullable().optional(),
});

// List scheduled ops
aiScheduleRouter.get('/', async (c) => {
  const page = parseInt(c.req.query('page') ?? '1', 10) || 1;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10) || 20, 100);

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
  const raw = await c.req.json();
  const body = CreateSchema.parse(raw);
  const user = c.get('user');

  const op = await createScheduledOp({
    ...body,
    createdBy: user?.email ?? user?.userId ?? 'unknown',
  });

  return c.json({ data: op }, 201);
});

// Update scheduled op
aiScheduleRouter.patch('/:id', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const raw = await c.req.json();
  const body = UpdateSchema.parse(raw);

  const op = await updateScheduledOp(c.req.param('id')!, body);
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
