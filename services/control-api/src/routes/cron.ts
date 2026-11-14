import { optional } from '../utils/optional.js';
import { managedCronRouter } from './managed-cron.js';
import { canStageLegacyCronForEnrollment, cronMutationMode, finalizeManagedCronRevocation, installManagedCron, registerManagedCron,
  reconcileForeignSchedulerSource, revokeManagedCron, stageLegacyCronForEnrollment,
  updateAndRegisterManagedCron, requestSchedulerSourceReconciliation, approveSchedulerSourceReconciliation,
  rejectSchedulerSourceReconciliation } from '../services/managed-cron.js';
import { z } from 'zod';
import { managedCronSchema, managedCronRegistrationSchema, schedulerSourceSettlementSchema, type ManagedCronIdentity } from '../schemas/managed-cron.js';
import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { cronJobForRole, mergeEnvironmentEdit, nodeForRole } from '../services/secret-views.js';
import { getDb } from '../db/index.js';
import { authMiddleware, getUser, requireRole } from '../middleware/auth.js';
import { logAuditEvent, sanitizeDetails } from '../services/audit-service.js';
import { HttpError } from '../middleware/error-handler.js';
import { parseBody } from '../utils/validate.js';
import { createCronSchema, updateCronSchema } from '../schemas/cron.js';
import { enforceIdempotencyFromHeader } from '../utils/idempotency.js';
import { NodeApiClient } from '../sdk/index.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { getNodeManagerSecret } from '../utils/env.js';
import { readManagedCronHistory } from '../services/managed-cron-history.js';

export const cronRouter = new Hono<AppVariables>();
cronRouter.route('/managed-occurrences', managedCronRouter);
cronRouter.use('*', authMiddleware);

/** Push a cron sync to the agent (fire-and-forget; DB is source of truth). */
async function pushCronSync(
  nodeIp: string,
  nodePort: number,
  job: {
    nodeId: string;
    name: string;
    description?: string;
    schedule: string;
    command: string;
    args: string[];
    workingDirectory?: string | null;
    environment?: Record<string, string>;
    timeoutSeconds: number;
  },
): Promise<void> {
  try {
    const client = new NodeApiClient({
      baseUrl: getNodeBaseUrl(nodeIp, nodePort),
      resourceNodeId: job.nodeId,
      nodeToken: getNodeManagerSecret(),
    });
    await client.syncCronJob({ nodeId: job.nodeId, name: job.name, ...optional("description", job.description), schedule: job.schedule, command: job.command, args: job.args, ...optional("workingDirectory", job.workingDirectory ?? undefined), ...optional("environment", job.environment), timeoutSeconds: job.timeoutSeconds });
  } catch {
    // Agent push failure is non-fatal — DB remains source of truth.
    // The cron job will be synced on next heartbeat reconciliation.
    console.warn(`[cron] Failed to push sync for "${job.name}" to ${nodeIp}`);
  }
}

/** Remove a cron job from the agent (fire-and-forget). */
async function pushCronDelete(nodeIp: string, nodePort: number, name: string, nodeId: string): Promise<void> {
  try {
    const client = new NodeApiClient({
      baseUrl: getNodeBaseUrl(nodeIp, nodePort),
      resourceNodeId: nodeId,
      nodeToken: getNodeManagerSecret(),
    });
    await client.deleteCronJob(name);
  } catch {
    console.warn(`[cron] Failed to push delete for "${name}" to ${nodeIp}`);
  }
}

function managedRequired(): never {
  throw new HttpError(409, 'MANAGED_CRON_REQUIRED', 'This node has activated resource ownership; an exact finite managed cron revision is required');
}

// ── List cron jobs (optionally by node) ──
cronRouter.get('/', async (c) => {
  const db = getDb();
  const nodeId = c.req.query('nodeId');
  const where = nodeId ? { nodeId } : {};

  const jobs = await db.cronJob.findMany({
    where,
    orderBy: { name: 'asc' },
    include: { node: { select: { name: true } } },
  });

  const definitions = await db.managedCronDefinition.findMany({ where: { cronJobId: { in: jobs.map(job => job.id) } },
    select: { cronJobId: true, revision: true, enabled: true, expiresAt: true } });
  const history = await readManagedCronHistory(jobs.filter(job => definitions.some(value => value.cronJobId === job.id)));
  const viewer = getUser(c).role;
  return c.json({ success: true, data: jobs.map(job => {
    const definition = definitions.find(value => value.cronJobId === job.id);
    const latest = history.get(job.id)?.[0];
    return { ...cronJobForRole(job, viewer), ...(latest ? { lastRunAt: latest.startedAt, lastRunExitCode: latest.exitCode } : {}), managed: definition ? { revision: definition.revision,
      enabled: definition.enabled, expiresAt: definition.expiresAt.toISOString(), timezone: 'UTC' } : null };
  }) });
});

// ── Get single cron job ──
cronRouter.get('/:cronId', async (c) => {
  const db = getDb();
  const job = await db.cronJob.findUnique({
    where: { id: c.req.param('cronId')! },
    include: { executions: { orderBy: { startedAt: 'desc' }, take: 10 } },
  });
  if (!job) throw new HttpError(404, 'NOT_FOUND', 'Cron job not found');
  const definition = await db.managedCronDefinition.findUnique({ where: { cronJobId: job.id }, select: { cronJobId: true } });
  const managedExecutions = definition ? (await readManagedCronHistory([job], true)).get(job.id) ?? [] : [];
  const executions = [...managedExecutions, ...job.executions]
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || b.id.localeCompare(a.id)).slice(0, 10);
  const latest = managedExecutions[0];
  return c.json({ success: true, data: cronJobForRole({ ...job, executions,
    ...(latest ? { lastRunAt: latest.startedAt, lastRunExitCode: latest.exitCode } : {}) }, getUser(c).role) });
});

// ── Create cron job ──
cronRouter.post('/', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const body = await parseBody(c, createCronSchema);

  // Look up node to get the agent connection details
  const node = await db.node.findUnique({ where: { id: body.nodeId } });
  if (!node) throw new HttpError(404, 'NOT_FOUND', 'Node not found');
  const mode = await cronMutationMode(node.id);
  if (mode === 'managed' && !body.managed) managedRequired();
  if (mode === 'legacy' && body.managed) throw new HttpError(409, 'MANAGED_CRON_ENROLLMENT_REQUIRED',
    'Enroll the node before creating a finite managed schedule');

  if (mode === 'managed') {
    const checked = managedCronSchema.safeParse({ nodeFqdn: node.hostname, name: body.name,
      revision: body.managed!.revision, timezone: body.managed!.timezone, expiresAt: body.managed!.expiresAt,
      schedule: body.schedule, command: body.command, args: body.args, environment: body.environment,
      workingDirectory: body.workingDirectory ?? undefined, timeoutSeconds: body.timeoutSeconds });
    if (!checked.success || body.managed!.timeoutSeconds !== body.timeoutSeconds || body.managed!.expiresAt <= Date.now())
      throw new HttpError(400, 'INVALID_MANAGED_CRON', 'Review the finite UTC schedule, job name, timeout and future expiry');
  }

  // Claim after validation/preview/preflight so a rejected retry is not a duplicate.
  const claim = await enforceIdempotencyFromHeader(c);
  const job = await db.cronJob.create({
    data: {
      nodeId: body.nodeId,
      name: body.name,
      description: body.description ?? '',
      schedule: body.schedule,
      command: body.command,
      args: JSON.stringify(body.args ?? []),
      workingDirectory: body.workingDirectory ?? null,
      environment: JSON.stringify(sanitizeDetails(body.environment ?? {})),
      timeoutSeconds: body.timeoutSeconds ?? 600,
      status: 'ACTIVE',
      createdBy: user.userId,
    },
  }).catch(async (err: unknown) => { await claim?.release(); throw err; });

  await logAuditEvent({
    action: 'cron.create',
    actorId: user.userId,
    targetType: 'cron',
    targetId: job.id,
    details: { name: body.name, schedule: body.schedule, nodeId: body.nodeId },
  });

  if (mode === 'managed') {
    await registerManagedCron(job.id, body.managed!);
    await installManagedCron(job.id, user.userId);
  } else {
    // Preserve the established best-effort legacy path until activation or the
    // first durable ownership record makes that bypass permanently ineligible.
    void pushCronSync(node.ipAddress, node.port, { nodeId: body.nodeId, name: body.name, description: body.description, schedule: body.schedule, command: body.command, args: body.args ?? [], ...optional("workingDirectory", body.workingDirectory), environment: sanitizeDetails(body.environment ?? {}) as Record<string, string>, timeoutSeconds: body.timeoutSeconds ?? 600 });
  }

  return c.json({ success: true, data: cronJobForRole(job, user.role) }, 201);
});

cronRouter.post('/scheduler-sources/reconcile', requireRole('ADMIN'), async c => {
  const assertion = await parseBody(c, schedulerSourceSettlementSchema);
  const result = await reconcileForeignSchedulerSource(assertion);
  await logAuditEvent({ action: 'cron.update', actorId: getUser(c).userId, targetType: 'scheduler-source',
    targetId: assertion.sourceSha256, details: { kind: assertion.kind, count: assertion.count,
      disposition: assertion.disposition, evidenceSha256: assertion.evidenceSha256,
      approvalRef: assertion.approvalRef, decisionId: assertion.decisionId, replayed: result.replayed } });
  return c.json({ success: true, data: result });
});

// Two-ADMIN approval of a scheduler-source settlement (services/managed-cron.ts): the enforce-mode
// equivalent of the reviewer's COMMAND_RECONCILIATION_SECRET signature. People only, two of them.
function adminPerson(c: Parameters<typeof getUser>[0]): string {
  const user = getUser(c);
  if (user.role !== 'ADMIN' || user.userId === 'system' || user.service)
    throw new HttpError(403, 'ADMIN_PERSON_REQUIRED', 'A signed-in ADMIN must take this step; the API secret and service identities cannot');
  return user.userId;
}
const reconcileRequestSchema = z.object({
  nodeId: z.string().min(1).max(128), kind: z.string().regex(/^[A-Z_]{1,80}$/), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  count: z.number().int().positive().max(1_000_000), disposition: z.enum(['effects_verified', 'no_effect_verified']),
  reason: z.string().trim().min(10).max(500), evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

cronRouter.post('/scheduler-sources/reconcile-requests', requireRole('ADMIN'), async c => {
  const actorId = adminPerson(c);
  const input = await parseBody(c, reconcileRequestSchema);
  const request = await requestSchedulerSourceReconciliation(input, actorId);
  await logAuditEvent({ action: 'cron.scheduler-source.reconcile_request', actorId, targetType: 'scheduler-source', targetId: request.sourceSha256,
    details: { requestId: request.id, nodeId: request.nodeId, kind: request.kind, count: request.count, disposition: request.disposition,
      reason: request.reason, epoch: request.epoch, barrierId: request.barrierId, expiresAt: request.expiresAt } });
  return c.json({ success: true, data: request }, 201);
});

cronRouter.post('/scheduler-sources/reconcile-requests/:id/approve', requireRole('ADMIN'), async c => {
  const actorId = adminPerson(c);
  await parseBody(c, z.object({}).strict());
  const id = c.req.param('id')!;
  try {
    const result = await approveSchedulerSourceReconciliation(id, actorId);
    await logAuditEvent({ action: 'cron.scheduler-source.reconcile_approve', actorId, targetType: 'scheduler-source', targetId: result.sourceSha256,
      details: { requestId: id, nodeId: result.nodeId, decisionId: result.decisionId, evidenceSha256: result.evidenceSha256, replayed: result.replayed } });
    return c.json({ success: true, data: result });
  } catch (error) {
    await logAuditEvent({ action: 'cron.scheduler-source.reconcile_approve', actorId, targetType: 'scheduler-source', targetId: id,
      details: { requestId: id, refused: error instanceof HttpError ? error.code : 'ERROR' } }).catch(() => undefined);
    throw error;
  }
});

cronRouter.post('/scheduler-sources/reconcile-requests/:id/reject', requireRole('ADMIN'), async c => {
  const actorId = adminPerson(c);
  await parseBody(c, z.object({}).strict());
  const request = await rejectSchedulerSourceReconciliation(c.req.param('id')!, actorId);
  await logAuditEvent({ action: 'cron.scheduler-source.reconcile_reject', actorId, targetType: 'scheduler-source', targetId: request.sourceSha256,
    details: { requestId: request.id, nodeId: request.nodeId } });
  return c.json({ success: true, data: request });
});

// Explicit opt-in: legacy jobs have no managed authority until this admin action.
cronRouter.post('/:cronId/managed', requireRole('ADMIN'), async c => {
  const existing = await getDb().cronJob.findUnique({ where: { id: c.req.param('cronId')! } });
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Cron job not found');
  const input = await parseBody(c, managedCronRegistrationSchema);
  if (await canStageLegacyCronForEnrollment(c.req.param('cronId')!)) {
    const definition = await stageLegacyCronForEnrollment(c.req.param('cronId')!, input);
    await logAuditEvent({ action: 'cron.update', actorId: getUser(c).userId, targetType: 'cron',
      targetId: definition.cronJobId, details: { revision: definition.revision, specSha256: definition.specSha256,
        expiresAt: input.expiresAt, stagedForEnrollment: true } });
    return c.json({ success: true, data: { cronJobId: definition.cronJobId, revision: definition.revision,
      specSha256: definition.specSha256, acknowledged: false, enabled: false,
      conversionPendingEnrollment: true, expiresAt: input.expiresAt } });
  }
  await cronMutationMode(existing.nodeId);
  const definition = await registerManagedCron(c.req.param('cronId')!, input);
  const activated = await installManagedCron(definition.cronJobId, getUser(c).userId);
  await logAuditEvent({ action: 'cron.update', actorId: getUser(c).userId, targetType: 'cron',
    targetId: definition.cronJobId, details: { revision: definition.revision, specSha256: definition.specSha256, expiresAt: input.expiresAt } });
  return c.json({ success: true, data: { cronJobId: activated.cronJobId, revision: activated.revision,
    specSha256: activated.specSha256, acknowledged: true, enabled: activated.enabled, expiresAt: input.expiresAt } });
});

// ── Update cron job ──
cronRouter.patch('/:cronId', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const cronId = c.req.param('cronId')!;
  const body = await parseBody(c, updateCronSchema);

  const initial = await db.cronJob.findUnique({ where: { id: cronId }, include: { node: true } });
  if (!initial) throw new HttpError(404, 'NOT_FOUND', 'Cron job not found');
  const mode = await cronMutationMode(initial.nodeId);
  const nextStatus = body.status?.toUpperCase() as 'ACTIVE' | 'PAUSED' | 'ERROR' | undefined;
  const executionChanged = body.name !== undefined || body.schedule !== undefined || body.command !== undefined
    || body.args !== undefined || body.workingDirectory !== undefined || body.environment !== undefined
    || body.timeoutSeconds !== undefined;
  const disabling = nextStatus !== undefined && nextStatus !== 'ACTIVE';
  const needsInstall = !disabling && (executionChanged || nextStatus === 'ACTIVE' && initial.status !== 'ACTIVE');
  if (mode === 'managed' && body.name !== undefined && body.name !== initial.name)
    throw new HttpError(409, 'MANAGED_CRON_RENAME_UNSUPPORTED', 'Revoke and create a new managed cron identity when changing its name');
  if (mode === 'managed' && needsInstall && !body.managed)
    managedRequired();

  let revokedIdentity: ManagedCronIdentity | undefined;
  if (mode === 'managed' && disabling) {
    const revoked = await revokeManagedCron(cronId, user.userId);
    revokedIdentity = revoked?.identity;
    if (!revoked) {
      const client = new NodeApiClient({ baseUrl: getNodeBaseUrl(initial.node.ipAddress, initial.node.port),
        resourceNodeId: initial.nodeId, resourceActorId: user.userId, nodeToken: getNodeManagerSecret() });
      const response = await client.deleteCronJob(initial.name);
      if (!response.success || response.data.deleted !== true) throw new HttpError(409, 'CRON_REVOCATION_UNACKNOWLEDGED', 'Node did not acknowledge cron revocation');
    }
  }

  const updateData = {
      ...(body.name && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.schedule && { schedule: body.schedule }),
      ...(body.command && { command: body.command }),
      ...(body.args && { args: JSON.stringify(body.args) }),
      ...(body.workingDirectory !== undefined && { workingDirectory: body.workingDirectory }),
      ...(body.environment !== undefined && { environment: JSON.stringify(sanitizeDetails(
        user.role === 'ADMIN' ? body.environment : mergeEnvironmentEdit(initial.environment, body.environment),
      )) }),
      ...(nextStatus && { status: nextStatus }),
      ...(body.timeoutSeconds && { timeoutSeconds: body.timeoutSeconds }),
  };
  const job = mode === 'managed' && needsInstall
    ? (await updateAndRegisterManagedCron(cronId, updateData, body.managed!)).job
    : mode === 'managed' && revokedIdentity
      ? (await finalizeManagedCronRevocation(cronId, revokedIdentity, updateData))!
    : await db.cronJob.update({ where: { id: cronId }, data: updateData, include: { node: true } });

  if (mode === 'managed' && needsInstall) {
    await installManagedCron(cronId, user.userId);
  }

  await logAuditEvent({
    action: 'cron.update',
    actorId: user.userId,
    targetType: 'cron',
    targetId: cronId,
    details: { name: body.name, schedule: body.schedule, command: body.command, status: body.status },
  });

  if (mode === 'legacy') void (async () => {
    // Legacy crontab entries are keyed by name: remove a renamed entry before
    // installing the new one, and a paused/errored job must not keep running.
    if (job.name !== initial.name) await pushCronDelete(job.node.ipAddress, job.node.port, initial.name, job.nodeId);
    if (job.status !== 'ACTIVE') {
      await pushCronDelete(job.node.ipAddress, job.node.port, job.name, job.nodeId);
      return;
    }
    await pushCronSync(job.node.ipAddress, job.node.port, {
      nodeId: job.nodeId, name: job.name, description: job.description ?? undefined,
      schedule: job.schedule, command: job.command, args: JSON.parse(job.args as string) as string[],
      workingDirectory: job.workingDirectory, environment: JSON.parse(job.environment as string) as Record<string, string>,
      timeoutSeconds: job.timeoutSeconds,
    });
  })();

  // The agent connection above needs the node; its token must never leave the server.
  return c.json({ success: true, data: { ...cronJobForRole(job, user.role), node: nodeForRole(job.node, user.role) } });
});

// ── Delete cron job ──
cronRouter.delete('/:cronId', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb();
  const user = getUser(c);
  const cronId = c.req.param('cronId')!;

  // Fetch job + node before deleting so we can notify the agent
  const existing = await db.cronJob.findUnique({
    where: { id: cronId },
    include: { node: true },
  });
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Cron job not found');

  const mode = await cronMutationMode(existing.nodeId);
  if (mode === 'managed') {
    const revoked = await revokeManagedCron(cronId, user.userId);
    if (!revoked) {
      const client = new NodeApiClient({ baseUrl: getNodeBaseUrl(existing.node.ipAddress, existing.node.port),
        resourceNodeId: existing.nodeId, resourceActorId: user.userId, nodeToken: getNodeManagerSecret() });
      const response = await client.deleteCronJob(existing.name);
      if (!response.success || response.data.deleted !== true) throw new HttpError(409, 'CRON_REVOCATION_UNACKNOWLEDGED', 'Node did not acknowledge cron revocation');
    }
    // Keep the disabled managed definition as monotonic revision and ownership
    // history. A same-name recreation must advance that durable identity.
    if (revoked) await finalizeManagedCronRevocation(cronId, revoked.identity, null);
    else await db.cronJob.delete({ where: { id: cronId } });
  } else {
    await db.cronJob.delete({ where: { id: cronId } });
  }

  await logAuditEvent({
    action: 'cron.delete',
    actorId: user.userId,
    targetType: 'cron',
    targetId: cronId,
  });

  if (mode === 'legacy') void pushCronDelete(existing.node.ipAddress, existing.node.port, existing.name, existing.nodeId);

  return c.json({ success: true, data: { deleted: true } });
});
