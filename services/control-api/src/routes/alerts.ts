import { optional } from '../utils/optional.js';
import { pagination } from '../utils/query.js';
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
import { z } from 'zod';
import { parseBody } from '../utils/validate.js';

const alertRuleFields = {
  name: z.string().trim().min(1, 'name is required').max(200),
  metric: z.enum(['cpu', 'memory', 'disk', 'swap', 'gpu_fan']),
  operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq']),
  threshold: z.number().finite(),
  durationSeconds: z.number().int().min(0).max(7 * 24 * 3600),
  severity: z.enum(['info', 'warning', 'critical']),
  nodeFilter: z.string().trim().min(1).max(1000),
  cooldownMinutes: z.number().int().min(0).max(7 * 24 * 60),
};
const alertRuleCreateSchema = z.object({
  ...alertRuleFields,
  durationSeconds: alertRuleFields.durationSeconds.optional(),
  severity: alertRuleFields.severity.optional(),
  nodeFilter: alertRuleFields.nodeFilter.optional(),
  cooldownMinutes: alertRuleFields.cooldownMinutes.optional(),
});
const alertRuleUpdateSchema = z.object({
  name: alertRuleFields.name.optional(), metric: alertRuleFields.metric.optional(), operator: alertRuleFields.operator.optional(),
  threshold: alertRuleFields.threshold.optional(), durationSeconds: alertRuleFields.durationSeconds.optional(),
  severity: alertRuleFields.severity.optional(), nodeFilter: alertRuleFields.nodeFilter.optional(),
  active: z.boolean().optional(), cooldownMinutes: alertRuleFields.cooldownMinutes.optional(),
});

/** Drop keys a client left out, so `Object.keys(body)` lists only the fields it changed. */
type Defined<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] }
  & { [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined> };
function stripUndefined<T extends Record<string, unknown>>(value: T): Defined<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Defined<T>;
}

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
  const body = stripUndefined(await parseBody(c, alertRuleCreateSchema));

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

  const body = stripUndefined(await parseBody(c, alertRuleUpdateSchema));

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
  const result = await listAlertViolations({ ...optional("ruleId", c.req.query('ruleId')), ...optional("nodeId", c.req.query('nodeId')), ...optional("status", c.req.query('status')), ...pagination(c, { pageSize: 50, maxPageSize: 100 }) });
  return c.json(result);
});
