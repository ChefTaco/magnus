import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, requireRole, getUser } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';
import { logAuditEvent } from '../services/audit-service.js';
import { createRollout, executeRollout, getRolloutStatus, setRolloutControl, rolloutInputSchema } from '../services/rollout-service.js';
import { parseBody } from '../utils/validate.js';

export const rolloutRouter = new Hono<AppVariables>();
rolloutRouter.use('*', authMiddleware);

/**
 * POST /rollouts
 * Create and start a rolling deployment.
 * Body: { type, strategy, nodeIds, metadata, percentageWaves? }
 */
rolloutRouter.post('/', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const body = await parseBody(c, rolloutInputSchema);
  const strategy = body.strategy;

  const run = await createRollout({
    type: body.type,
    strategy,
    nodeIds: body.nodeIds,
    metadata: body.metadata ?? {},
    createdBy: user.userId,
    percentageWaves: body.percentageWaves,
    rolloutId: body.rolloutId,
    canaryNodeId: body.canaryNodeId,
    waveSize: body.waveSize,
    maxUnavailable: body.maxUnavailable,
  });

  // Execute in background
  executeRollout(run.id).catch((err) => {
    console.error(`[Rollout ${run.id}] Execution error:`, err);
  });

  await logAuditEvent({
    action: 'rollout.create',
    actorId: user.userId,
    targetType: 'rollout',
    targetId: run.id,
    details: { type: body.type, strategy, nodeCount: body.nodeIds.length },
  });

  return c.json({
    success: true,
    data: {
      id: run.id,
      type: run.type,
      strategy: run.rolloutStrategy,
      status: run.status,
      totalNodes: run.totalNodes,
      targetCount: run.targets.length,
    },
  }, 202);
});

/**
 * GET /rollouts/:id
 * Get rollout status with target-level details.
 */
rolloutRouter.get('/:id', async (c) => {
  const status = await getRolloutStatus(c.req.param('id')!);
  return c.json({ success: true, data: status });
});

/**
 * GET /rollouts
 * List recent rollouts.
 */
rolloutRouter.get('/', async (c) => {
  const db = getDb();
  const runs = await db.executionRun.findMany({
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      type: true,
      rolloutStrategy: true,
      status: true,
      totalNodes: true,
      completedNodes: true,
      failedNodes: true,
      createdBy: true,
      createdAt: true,
      startedAt: true,
      completedAt: true,
    },
  });

  return c.json({ success: true, data: runs });
});

/**
 * POST /rollouts/:id/cancel
 * Cancel a running rollout (mark pending targets as cancelled).
 */
rolloutRouter.post('/:id/cancel', requireRole('ADMIN'), async (c) => {
  const user = getUser(c);
  const runId = c.req.param('id')!;
  await setRolloutControl(runId, 'abort');

  await logAuditEvent({
    action: 'rollout.cancel',
    actorId: user.userId,
    targetType: 'rollout',
    targetId: runId,
    details: { cancelledBy: user.email },
  });

  return c.json({ success: true, data: { id: runId, status: 'cancelled' } });
});

rolloutRouter.post('/:id/:action', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const action = c.req.param('action') ?? '';
  if (!['pause', 'resume', 'abort'].includes(action)) throw new HttpError(404, 'NOT_FOUND', 'Unknown rollout action');
  const rolloutAction = action as 'pause' | 'resume' | 'abort';
  // Abort is the same control as /cancel and needs the same authority.
  if (rolloutAction === 'abort' && getUser(c).role !== 'ADMIN') {
    throw new HttpError(403, 'FORBIDDEN', 'Requires one of: ADMIN');
  }
  const runId = c.req.param('id')!;
  await setRolloutControl(runId, rolloutAction);
  await logAuditEvent({
    action: `rollout.${rolloutAction}`,
    actorId: getUser(c).userId,
    targetType: 'rollout',
    targetId: runId,
    details: { correlationId: c.get('requestId') },
  });
  return c.json({ success: true, data: { id: runId, action } });
});
