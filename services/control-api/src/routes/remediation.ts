/**
 * remediation.ts — Auto-remediation rule management and execution history.
 *
 * GET    /remediation/rules             — List all remediation rules
 * GET    /remediation/rules/:id         — Get a single rule
 * POST   /remediation/rules             — Create a new rule
 * PATCH  /remediation/rules/:id         — Update a rule
 * DELETE /remediation/rules/:id         — Delete a rule
 * GET    /remediation/executions        — List executions (with filters)
 * POST   /remediation/trigger           — Manually trigger remediation for an anomaly
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, requireRole, getUser } from '../middleware/auth.js';
import { parseBody } from '../utils/validate.js';
import { logAuditEvent } from '../services/audit-service.js';
import {
  approveRemediation,
  RUNBOOKS,
  listRules,
  getRule,
  createRule,
  updateRule,
  deleteRule,
  listExecutions,
  triggerManualRemediation,
} from '../services/remediation-service.js';


export const remediationRouter = new Hono<AppVariables>();

remediationRouter.use('*', authMiddleware);

// ── Schemas ──

const CreateRuleSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  metric: z.enum(['cpu', 'memory', 'disk', 'swap', '*']).optional(),
  severityThreshold: z.enum(['warning', 'critical']).optional(),
  agentDefinitionId: z.enum(RUNBOOKS),
  input: z.string().max(2000).optional(),
  cooldownMinutes: z.number().int().min(1).max(10080).optional(),
  maxConcurrentRuns: z.number().int().min(1).max(10).optional(),
  nodeFilter: z.string().max(200).optional(),
  enabled: z.boolean().optional(),
});

const UpdateRuleSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  metric: z.enum(['cpu', 'memory', 'disk', 'swap', '*']).optional(),
  severityThreshold: z.enum(['warning', 'critical']).optional(),
  agentDefinitionId: z.enum(RUNBOOKS).optional(),
  input: z.string().max(2000).optional(),
  cooldownMinutes: z.number().int().min(1).max(10080).optional(),
  maxConcurrentRuns: z.number().int().min(1).max(10).optional(),
  nodeFilter: z.string().max(200).nullable().optional(),
  enabled: z.boolean().optional(),
});

const TriggerSchema = z.object({
  anomalyEventId: z.string().min(1),
  ruleId: z.string().min(1),
});

// ── Rules CRUD ──

remediationRouter.get('/rules', async (c) => {
  const rules = await listRules();
  return c.json({ data: rules });
});

remediationRouter.get('/rules/:id', async (c) => {
  const rule = await getRule(c.req.param('id')!);
  if (!rule) return c.json({ error: 'NOT_FOUND', message: 'Rule not found' }, 404);
  return c.json({ data: rule });
});

remediationRouter.post('/rules', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const body = await parseBody(c, CreateRuleSchema);
  const user = c.get('user');
  const rule = await createRule({ ...body, createdBy: user?.userId ?? 'system' });
  await logAuditEvent({ action: 'remediation.rule.create', actorId: getUser(c).userId, targetType: 'remediation-rule',
    targetId: rule.id, details: { name: body.name, runbook: body.agentDefinitionId, metric: body.metric ?? null,
      enabled: body.enabled ?? null } });
  return c.json({ data: rule }, 201);
});

remediationRouter.patch('/rules/:id', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const body = await parseBody(c, UpdateRuleSchema);
  const rule = await updateRule(c.req.param('id')!, body);
  await logAuditEvent({ action: 'remediation.rule.update', actorId: getUser(c).userId, targetType: 'remediation-rule',
    targetId: c.req.param('id')!, details: { changedFields: Object.keys(body).sort(),
      ...(body.enabled !== undefined && { enabled: body.enabled }),
      ...(body.agentDefinitionId !== undefined && { runbook: body.agentDefinitionId }) } });
  return c.json({ data: rule });
});

remediationRouter.delete('/rules/:id', requireRole('ADMIN'), async (c) => {
  await deleteRule(c.req.param('id')!);
  await logAuditEvent({ action: 'remediation.rule.delete', actorId: getUser(c).userId, targetType: 'remediation-rule',
    targetId: c.req.param('id')! });
  return c.json({ success: true });
});

// ── Executions ──

remediationRouter.get('/executions', async (c) => {
  const params = {
    ruleId: c.req.query('ruleId'),
    nodeId: c.req.query('nodeId'),
    status: c.req.query('status'),
    page: c.req.query('page') ? Number(c.req.query('page')) : undefined,
    pageSize: c.req.query('pageSize') ? Number(c.req.query('pageSize')) : undefined,
  };
  const result = await listExecutions(params);
  return c.json({ data: result });
});

// ── Manual trigger ──

remediationRouter.post('/trigger', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const body = await parseBody(c, TriggerSchema);
  const user = c.get('user');
  const result = await triggerManualRemediation({
    ...body,
    triggeredBy: user?.userId ?? 'system',
  });
  await logAuditEvent({ action: 'remediation.trigger', actorId: getUser(c).userId, targetType: 'remediation-rule',
    targetId: body.ruleId, details: { anomalyEventId: body.anomalyEventId } });
  return c.json({ data: result }, 201);
});

remediationRouter.post('/executions/:id/approve', requireRole('ADMIN', 'OPERATOR'), async c => {
  return approveRemediation(c.req.param('id')!, getUser(c).userId);
});
