/**
 * Alert rules, remediation rules, rollout reads and controls, fleet check logs and notification
 * preferences. Every route here sits behind `authMiddleware`.
 */
import { remediationRuleResponseSchema, rolloutActionResponseSchema } from '@hivemagnus/magnus-contracts/browser';
import {
  type JsonSchema, type Paths, body, browserOperation, err400, err401, err403, err404, errorResponse, pp, qp, success, userAuth, zodOut,
} from '../helpers.js';

// ── Alert rules (routes/alerts.ts) ──
const alertRuleFields: Record<string, JsonSchema> = {
  name: { type: 'string', minLength: 1, maxLength: 200, description: 'Trimmed' },
  metric: { type: 'string', enum: ['cpu', 'memory', 'disk', 'swap', 'gpu_fan'] },
  operator: { type: 'string', enum: ['gt', 'gte', 'lt', 'lte', 'eq'] },
  threshold: { type: 'number' },
  durationSeconds: { type: 'integer', minimum: 0, maximum: 604800, description: 'How long the condition must hold (0 fires at once). Default 0.' },
  severity: { type: 'string', enum: ['info', 'warning', 'critical'], description: 'Default warning.' },
  nodeFilter: { type: 'string', minLength: 1, maxLength: 1000, description: '`*` (default) for every node, or comma-separated node IDs or tags. Trimmed.' },
  cooldownMinutes: { type: 'integer', minimum: 0, maximum: 10080, description: 'Minutes before the rule fires again for a node. Default 15.' },
};
const alertRule: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' }, ...alertRuleFields, active: { type: 'boolean' }, createdBy: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
    _count: { type: 'object', properties: { violations: { type: 'integer' } } },
  },
};
const alertViolation: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' }, ruleId: { type: 'string' }, nodeId: { type: 'string' }, nodeName: { type: 'string', nullable: true },
    metric: { type: 'string' }, value: { type: 'number' }, threshold: { type: 'number' }, severity: { type: 'string' },
    status: { type: 'string', enum: ['active', 'resolved'] }, resolvedAt: { type: 'string', format: 'date-time', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
  },
};
const alertRuleBody = (description: string): JsonSchema => ({ description, content: { 'application/json': { schema: { type: 'object', properties: { rule: alertRule } } } } });
const alertRuleId = pp('id', 'Alert rule ID');

// ── Remediation (routes/remediation.ts) ──
const remediationRuleId = pp('id', 'Remediation rule ID');
/** routes/remediation.ts answers an unknown rule on GET with this body, not the ApiError envelope. */
const remediationNotFound = body('Rule not found', { type: 'object', properties: { error: { type: 'string', enum: ['NOT_FOUND'] }, message: { type: 'string' } } });
const remediationTags = ['Operations'];

// ── Rollouts (routes/rollout.ts) ──
const rolloutId = pp('id', 'Rollout (execution run) ID');
const rolloutState = errorResponse('ROLLOUT_STATE: the rollout is terminal, or the transition is invalid (pause needs `running`, resume needs `paused`)');

// ── Fleet checks (routes/fleet-checks.ts, services/fleet-check-log.ts) ──
const fleetCheckRun: JsonSchema = {
  type: 'object',
  required: ['runId', 'kind', 'status', 'startedAt', 'completedAt', 'durationMs', 'summary'],
  properties: {
    runId: { type: 'string' }, kind: { type: 'string' }, status: { type: 'string', enum: ['ok', 'warning', 'critical', 'error'] },
    startedAt: { type: 'string', format: 'date-time' }, completedAt: { type: 'string', format: 'date-time' }, durationMs: { type: 'number' },
    summary: { type: 'string' }, counts: { type: 'object', additionalProperties: true }, data: { type: 'object', additionalProperties: true },
    errors: { type: 'array', items: { type: 'string' } },
  },
};
const fleetCheckDirectory = { type: 'string', description: 'Server log directory (`MAGNUS_FLEET_CHECK_LOG_DIR` or the default)' };
const fleetCheckKind = qp('kind', 'Only runs of this kind');
const fleetChecksTags = ['Fleet checks'];

export const paths: Paths = {
  '/alerts/rules': {
    get: {
      tags: ['Alerts'], summary: 'List alert rules', description: 'Newest first, each with its violation count. Any role.', security: userAuth,
      responses: { 200: body('Alert rules', { type: 'object', properties: { rules: { type: 'array', items: alertRule } } }), 401: err401 },
    },
    post: {
      tags: ['Alerts'], summary: 'Create an alert rule (ADMIN)', description: 'ADMIN only. Audited as `alert.rule.create`.', security: userAuth,
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'metric', 'operator', 'threshold'], properties: alertRuleFields } } } },
      responses: { 201: alertRuleBody('Created rule'), 400: err400, 401: err401, 403: err403 },
    },
  },
  '/alerts/rules/{id}': {
    get: {
      tags: ['Alerts'], summary: 'Get an alert rule with its 20 newest violations', description: 'Any role.', security: userAuth, parameters: [alertRuleId],
      responses: {
        200: body('Alert rule', { type: 'object', properties: { rule: { ...alertRule, properties: { ...(alertRule['properties'] as object), violations: { type: 'array', items: alertViolation } } } } }),
        401: err401, 404: err404,
      },
    },
    patch: {
      tags: ['Alerts'], summary: 'Update an alert rule (ADMIN)', description: 'ADMIN only. Send only the fields to change. Audited as `alert.rule.update` with the changed field names.',
      security: userAuth, parameters: [alertRuleId],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { ...alertRuleFields, active: { type: 'boolean' } } } } } },
      responses: { 200: alertRuleBody('Updated rule'), 400: err400, 401: err401, 403: err403, 404: err404 },
    },
    delete: {
      tags: ['Alerts'], summary: 'Delete an alert rule and its violations (ADMIN)', description: 'ADMIN only. Audited as `alert.rule.delete`.', security: userAuth, parameters: [alertRuleId],
      responses: { 200: body('Deleted', { type: 'object', properties: { success: { type: 'boolean', enum: [true] } } }), 401: err401, 403: err403, 404: err404 },
    },
  },
  '/alerts/violations': {
    get: {
      tags: ['Alerts'], summary: 'List alert violations', description: 'Newest first, each with its rule name. Any role.', security: userAuth,
      parameters: [qp('ruleId', 'Only this rule'), qp('nodeId', 'Only this node'), qp('status', 'Only this status', { enum: ['active', 'resolved'] }),
        qp('page', 'Page from 1 (invalid values fall back to 1)', { type: 'integer' }), qp('pageSize', 'Items per page (1-100, default 50; clamped)', { type: 'integer' })],
      responses: {
        200: body('Violations', { type: 'object', properties: {
          violations: { type: 'array', items: { ...alertViolation, properties: { ...(alertViolation['properties'] as object), rule: { type: 'object', properties: { name: { type: 'string' } } } } } },
          total: { type: 'integer' } } }),
        401: err401,
      },
    },
  },

  '/remediation/rules': {
    get: browserOperation('GET', '/remediation/rules', { tags: remediationTags, summary: 'List remediation rules',
      description: 'Newest first. `disposition` is `legacy_record_only` for a rule whose runbook is no longer offered.' }),
    post: browserOperation('POST', '/remediation/rules', { tags: remediationTags, summary: 'Create a remediation rule (operator/admin)',
      description: 'The rule only proposes plans: each one waits for approval through the signed approval bridge. Audited as `remediation.rule.create`.',
      errors: { 400: err400, 409: errorResponse('CONFLICT: the name is taken') } }),
  },
  '/remediation/rules/{id}': {
    get: {
      tags: remediationTags, summary: 'Get a remediation rule', description: 'Any role.', security: userAuth, parameters: [remediationRuleId],
      responses: { 200: body('Remediation rule', zodOut(remediationRuleResponseSchema)), 401: err401, 404: remediationNotFound },
    },
    patch: browserOperation('PATCH', '/remediation/rules/{id}', { tags: remediationTags, summary: 'Update a remediation rule (operator/admin)',
      description: 'Audited as `remediation.rule.update` with the changed field names.', params: { id: 'Remediation rule ID' },
      errors: { 400: err400, 404: err404, 409: errorResponse('CONFLICT: the name is taken') } }),
    delete: browserOperation('DELETE', '/remediation/rules/{id}', { tags: remediationTags, summary: 'Delete a remediation rule that never ran (ADMIN)',
      description: 'A rule with executions keeps them and answers 409 RULE_HAS_EXECUTIONS: disable it instead. Audited as `remediation.rule.delete`.',
      params: { id: 'Remediation rule ID' }, errors: { 404: err404, 409: errorResponse('RULE_HAS_EXECUTIONS: the rule has executions') } }),
  },
  '/remediation/executions': {
    get: browserOperation('GET', '/remediation/executions', { tags: remediationTags, summary: 'List remediation executions',
      description: 'Newest first, each with its rule name, metric and runbook. `pageSize` is clamped to 1-200 (default 50).' }),
  },
  '/remediation/trigger': {
    post: browserOperation('POST', '/remediation/trigger', { tags: remediationTags, summary: 'Propose a remediation plan for an anomaly (operator/admin)',
      description: 'Creates a `pending_approval` execution, or `skipped` when the runbook cannot be planned; inside the rule cooldown it returns the existing execution. Nothing runs until the plan is approved through the signed approval bridge. Audited as `remediation.trigger`.',
      errors: { 400: err400, 404: errorResponse('NOT_FOUND: unknown anomaly or rule'), 409: errorResponse('REMEDIATION_BUSY: the rule has reached its active plan limit') } }),
  },

  '/rollouts': {
    get: browserOperation('GET', '/rollouts', { tags: ['Operations'], summary: 'List the 50 newest rollouts' }),
  },
  '/rollouts/{id}': {
    get: browserOperation('GET', '/rollouts/{id}', { tags: ['Operations'], summary: 'Get a rollout with its targets',
      params: { id: 'Rollout (execution run) ID' }, errors: { 404: err404 } }),
  },
  '/rollouts/{id}/cancel': {
    post: {
      tags: ['Operations'], summary: 'Cancel a rollout (ADMIN)',
      description: 'ADMIN only. The same control as `abort`: queued target commands are cancelled. Audited as `rollout.cancel`. No body is read.',
      security: userAuth, parameters: [rolloutId],
      responses: {
        200: success('Cancelled', { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['cancelled'] } } }),
        401: err401, 403: err403, 404: err404, 409: rolloutState,
      },
    },
  },
  '/rollouts/{id}/{action}': {
    post: {
      tags: ['Operations'], summary: 'Pause, resume or abort a rollout',
      description: 'Pause and resume take ADMIN or OPERATOR; abort, like `cancel`, takes ADMIN. Any other action answers 404. Audited as `rollout.<action>`. No body is read.',
      security: userAuth,
      parameters: [rolloutId, { name: 'action', in: 'path', required: true, schema: { type: 'string', enum: ['pause', 'resume', 'abort'] }, description: 'Control to apply' }],
      responses: { 200: body('Control applied', zodOut(rolloutActionResponseSchema)), 401: err401, 403: err403, 404: errorResponse('Unknown rollout or action'), 409: rolloutState },
    },
  },

  '/fleet-checks/runs': {
    get: {
      tags: fleetChecksTags, summary: 'List recent fleet check runs', description: 'Read from the JSONL logs in the fleet check log directory, newest first. Any role.', security: userAuth,
      parameters: [qp('limit', 'Runs (1-200, default 20; clamped)', { type: 'integer' }), fleetCheckKind],
      responses: { 200: success('Fleet check runs', { type: 'object', properties: { directory: fleetCheckDirectory, runs: { type: 'array', items: fleetCheckRun } } }), 401: err401 },
    },
  },
  '/fleet-checks/latest': {
    get: {
      tags: fleetChecksTags, summary: 'Get the newest fleet check run', description: 'Any role. `run` is null when no log has one.', security: userAuth, parameters: [fleetCheckKind],
      responses: { 200: success('Newest run', { type: 'object', properties: { directory: fleetCheckDirectory, run: { ...fleetCheckRun, nullable: true } } }), 401: err401 },
    },
  },
  '/fleet-checks/files': {
    get: {
      tags: fleetChecksTags, summary: 'List fleet check log files', description: 'Any role.', security: userAuth,
      responses: {
        200: success('Log files', { type: 'object', properties: { directory: fleetCheckDirectory, files: { type: 'array', items: { type: 'object',
          properties: { file: { type: 'string' }, sizeBytes: { type: 'integer' }, modifiedAt: { type: 'string', format: 'date-time' } } } } } }),
        401: err401,
      },
    },
  },

  '/notifications/preferences': {
    get: browserOperation('GET', '/notifications/preferences', { tags: ['Notifications'], summary: 'Get your notification preferences', description: 'Ordered by category.' }),
    put: browserOperation('PUT', '/notifications/preferences', { tags: ['Notifications'], summary: 'Update your notification preferences',
      description: 'Upserts 1-100 entries by channel and category in one transaction. Audited as `notification.preferences_update`.', errors: { 400: err400 } }),
  },
};
