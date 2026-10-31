import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, getUser, requireRole } from '../middleware/auth.js';
import { logAuditEvent } from '../services/audit-service.js';
import { HttpError } from '../middleware/error-handler.js';
import {
  listAlertRules,
  getAlertRule,
  createAlertRule,
  updateAlertRule,
  deleteAlertRule,
  listAlertViolations,
} from '../services/alert-service.js';

export const alertsRouter = new Hono<AppVariables>();

alertsRouter.use('*', authMiddleware);

// ── List all alert rules ──
alertsRouter.get('/rules', async (c) => {
  const rules = await listAlertRules();
  return c.json({ rules });
});

// ── Get a specific alert rule ──
alertsRouter.get('/rules/:id', async (c) => {
  const rule = await getAlertRule(c.req.param('id')!);
  if (!rule) throw new HttpError(404, 'NOT_FOUND', 'Alert rule not found');
  return c.json({ rule });
});

// ── Create an alert rule (ADMIN only) ──
alertsRouter.post('/rules', requireRole('ADMIN'), async (c) => {
  const body = await c.req.json<{
    name: string;
    metric: string;
    operator: string;
    threshold: number;
    durationSeconds?: number;
    severity?: string;
    nodeFilter?: string;
    cooldownMinutes?: number;
  }>();

  if (!body.name || !body.metric || !body.operator || body.threshold === undefined) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'name, metric, operator, and threshold are required');
  }

  const validMetrics = ['cpu', 'memory', 'disk', 'swap', 'gpu_fan'];
  if (!validMetrics.includes(body.metric)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `metric must be one of: ${validMetrics.join(', ')}`);
  }

  const validOperators = ['gt', 'gte', 'lt', 'lte', 'eq'];
  if (!validOperators.includes(body.operator)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `operator must be one of: ${validOperators.join(', ')}`);
  }

  const user = c.get('user');
  const rule = await createAlertRule({
    ...body,
    createdBy: user?.userId ?? user?.email ?? 'system',
  });
  await logAuditEvent({ action: 'alert.rule.create', actorId: getUser(c).userId, targetType: 'alert-rule',
    targetId: (rule as { id?: string }).id ?? 'unknown', details: { name: body.name, metric: body.metric, operator: body.operator,
      threshold: body.threshold, severity: body.severity ?? null } });
  return c.json({ rule }, 201);
});

// ── Update an alert rule (ADMIN only) ──
alertsRouter.patch('/rules/:id', requireRole('ADMIN'), async (c) => {
  const id = c.req.param('id')!;
  const existing = await getAlertRule(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Alert rule not found');

  const body = await c.req.json<Partial<{
    name: string;
    metric: string;
    operator: string;
    threshold: number;
    durationSeconds: number;
    severity: string;
    nodeFilter: string;
    active: boolean;
    cooldownMinutes: number;
  }>>();

  const rule = await updateAlertRule(id, body);
  await logAuditEvent({ action: 'alert.rule.update', actorId: getUser(c).userId, targetType: 'alert-rule',
    targetId: id, details: { changedFields: Object.keys(body).sort(),
      ...(body.active !== undefined && { active: body.active }) } });
  return c.json({ rule });
});

// ── Delete an alert rule (ADMIN only) ──
alertsRouter.delete('/rules/:id', requireRole('ADMIN'), async (c) => {
  const id = c.req.param('id')!;
  const existing = await getAlertRule(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Alert rule not found');

  await deleteAlertRule(id);
  await logAuditEvent({ action: 'alert.rule.delete', actorId: getUser(c).userId, targetType: 'alert-rule',
    targetId: id, details: { name: (existing as { name?: string }).name ?? null } });
  return c.json({ success: true });
});

// ── List violations (with optional filters) ──
alertsRouter.get('/violations', async (c) => {
  const result = await listAlertViolations({
    ruleId: c.req.query('ruleId'),
    nodeId: c.req.query('nodeId'),
    status: c.req.query('status'),
    page: parseInt(c.req.query('page') ?? '1', 10),
    pageSize: parseInt(c.req.query('pageSize') ?? '50', 10),
  });
  return c.json(result);
});
