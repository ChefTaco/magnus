import { recordMonitorPulse } from './monitor-pulse.js';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';
import { enqueueCommand } from '../queue/workers.js';

export const rolloutInputSchema = z
  .object({
    type: z.literal('command'),
    strategy: z
      .enum(['all_at_once', 'one_at_a_time', 'percentage', 'canary'])
      .default('all_at_once'),
    nodeIds: z.array(z.string().min(1).max(200)).min(1).max(100),
    metadata: z
      .object({
        command: z.string().trim().min(1).max(4096),
        args: z.array(z.string().max(4096)).max(64).default([]),
        timeoutSeconds: z.number().int().min(1).max(300).default(60),
        expectedAgentVersion: z.string().max(100).optional(),
        applicationId: z.string().max(200).optional(),
        executionDeadline: z.number().int().positive().optional(),
      })
      .strict(),
    percentageWaves: z.array(z.number().int().min(1).max(100)).min(1).max(100).optional(),
    rolloutId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,100}$/)
      .optional(),
    canaryNodeId: z.string().max(200).optional(),
    waveSize: z.number().int().min(1).max(100).default(5),
    maxUnavailable: z.number().int().min(1).max(100).default(1),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.nodeIds).size !== v.nodeIds.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate node IDs' });
    if (v.strategy === 'canary' && (!v.canaryNodeId || !v.nodeIds.includes(v.canaryNodeId)))
      ctx.addIssue({ code: 'custom', message: 'Select a canary from rollout targets' });
    const waves = v.percentageWaves ?? [25, 50, 100];
    if (
      v.strategy === 'percentage' &&
      (waves.at(-1) !== 100 || waves.some((p, i) => i > 0 && p <= waves[i - 1]!))
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Percentage waves must increase strictly and finish at 100',
      });
    }
  });
export type RolloutStrategy = z.infer<typeof rolloutInputSchema>['strategy'];
export type CreateRolloutOpts = z.input<typeof rolloutInputSchema> & { createdBy: string };

export function planRolloutWaves(
  ids: string[],
  strategy: RolloutStrategy,
  config: { percentageWaves?: number[]; waveSize?: number; canaryNodeId?: string },
): string[][] {
  if (strategy === 'all_at_once') return [ids];
  if (strategy === 'percentage') {
    let start = 0;
    return (config.percentageWaves ?? [25, 50, 100])
      .map((p) => {
        const end = Math.ceil((ids.length * p) / 100);
        const wave = ids.slice(start, end);
        start = end;
        return wave;
      })
      .filter((w) => w.length);
  }
  const size = strategy === 'one_at_a_time' ? 1 : (config.waveSize ?? 5);
  const rest = strategy === 'canary' ? ids.filter((id) => id !== config.canaryNodeId) : ids;
  const waves: string[][] = strategy === 'canary' ? [[config.canaryNodeId!]] : [];
  for (let i = 0; i < rest.length; i += size) waves.push(rest.slice(i, i + size));
  return waves;
}

export async function createRollout(opts: CreateRolloutOpts) {
  const { createdBy, ...raw } = opts;
  const parsed = rolloutInputSchema.safeParse(raw);
  if (!parsed.success)
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues.map((i) => i.message).join('; '),
    );
  const input = parsed.data;
  const id = input.rolloutId ?? nanoid();
  const ids = [...input.nodeIds].sort();
  const digest = createHash('sha256')
    .update(JSON.stringify({ ...input, rolloutId: undefined, nodeIds: ids, createdBy }))
    .digest('hex');
  const db = getDb();
  return db.$transaction(async (tx) => {
    // Serialize competing submissions and overlapping target sets in stable order.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`rollout:${id}`}, 0))`;
    for (const nodeId of ids)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`rollout-node:${nodeId}`}, 0))`;
    const existing = await tx.executionRun.findUnique({
      where: { id },
      include: { targets: true },
    });
    if (existing) {
      if (JSON.parse(existing.metadata)['requestDigest'] !== digest)
        throw new HttpError(
          409,
          'ROLLOUT_CONFLICT',
          'Rollout ID is bound to a different request or actor',
        );
      return existing;
    }
    const nodes = await tx.node.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, lastHeartbeatAt: true },
    });
    if (
      nodes.length !== ids.length ||
      nodes.some(
        (n) =>
          n.status !== 'ONLINE' ||
          !n.lastHeartbeatAt ||
          Date.now() - n.lastHeartbeatAt.getTime() > 120000,
      )
    ) {
      throw new HttpError(
        400,
        'VALIDATION_ERROR',
        'Every target must be online with a fresh heartbeat',
      );
    }
    if (input.metadata.applicationId) {
      const app = await tx.applicationObservation.findUnique({
        where: { id: input.metadata.applicationId },
      });
      if (
        !app ||
        !app.observedAt ||
        Date.now() - app.observedAt.getTime() >= 180000 ||
        ids.length !== 1 ||
        app.nodeId !== ids[0]
      )
        throw new HttpError(
          400,
          'VALIDATION_ERROR',
          'A fresh application observation must belong to the sole target',
        );
    }
    const conflict = await tx.rolloutTarget.findFirst({
      where: { nodeId: { in: ids }, rollout: { status: { in: ['created', 'running', 'paused'] } } },
    });
    if (conflict)
      throw new HttpError(409, 'ROLLOUT_CONFLICT', 'A target already has an active rollout');
    return tx.executionRun.create({
      data: {
        id,
        type: input.type,
        rolloutStrategy: input.strategy,
        totalNodes: ids.length,
        createdBy,
        metadata: JSON.stringify({
          ...input.metadata,
          requestDigest: digest,
          waves: planRolloutWaves(ids, input.strategy, input),
          maxUnavailable: input.maxUnavailable,
          contractVersion: 1,
        }),
        targets: { create: ids.map((nodeId) => ({ id: nanoid(), nodeId })) },
      },
      include: { targets: true },
    });
  });
}

/** One transactional reconciliation step. Commands are durable records and the
 * existing command worker claims each at most once. Ambiguous interrupted
 * commands fail rather than being replayed. No remote I/O occurs in this lock. */
export async function executeRollout(runId: string): Promise<void> {
  const db = getDb();
  const dispatch = await db.$transaction(async (tx) => {
    const locks = await tx.$queryRaw<
      Array<{ locked: boolean }>
    >`SELECT pg_try_advisory_xact_lock(hashtextextended(${`rollout:${runId}`}, 0)) AS locked`;
    if (!locks[0]?.locked) return [] as string[];
    const run = await tx.executionRun.findUnique({
      where: { id: runId },
      include: { targets: { include: { node: { include: { agent: true } } } } },
    });
    if (!run || !['created', 'running', 'paused'].includes(run.status)) return [] as string[];
    const metadata = JSON.parse(run.metadata) as {
      contractVersion?: number;
      waves?: string[][];
      command: string;
      args: string[];
      timeoutSeconds: number;
      expectedAgentVersion?: string;
      applicationId?: string;
      executionDeadline?: number;
      maxUnavailable: number;
    };
    if (metadata.contractVersion !== 1 || !metadata.waves) {
      await tx.executionRun.update({
        where: { id: runId },
        data: { status: 'failed', completedAt: new Date() },
      });
      await tx.rolloutTarget.updateMany({
        where: { rolloutId: runId, status: { in: ['pending', 'running'] } },
        data: {
          status: 'failed',
          error: 'Legacy rollout requires explicit resubmission',
          completedAt: new Date(),
        },
      });
      return [] as string[];
    }
    if (run.status === 'created')
      await tx.executionRun.update({
        where: { id: runId },
        data: { status: 'running', startedAt: new Date() },
      });
    const commands = await tx.remoteCommand.findMany({
      where: { id: { in: run.targets.flatMap((t) => (t.commandId ? [t.commandId] : [])) } },
      include: { result: true },
    });
    const enqueue: string[] = [];
    for (const target of run.targets) {
      if (!target.commandId || !['queued', 'verifying'].includes(target.status)) continue;
      const command = commands.find((c) => c.id === target.commandId);
      const age = Date.now() - (target.startedAt?.getTime() ?? Date.now());
      let error: string | undefined;
      if (!command) error = 'Durable command is missing';
      else if (['FAILED', 'TIMEOUT', 'CANCELLED'].includes(command.status))
        error = `Command ${command.status.toLowerCase()}`;
      else if (command.status === 'COMPLETED') {
        const heartbeat = target.node.lastHeartbeatAt;
        const fresh =
          heartbeat &&
          command.completedAt &&
          heartbeat > command.completedAt &&
          Date.now() - heartbeat.getTime() < 120000;
        const version = target.node.agent?.version ?? null;
        let application = true;
        if (metadata.applicationId) {
          const probe = await tx.applicationObservation.findUnique({
            where: { id: metadata.applicationId },
          });
          application = Boolean(
            probe &&
            probe.nodeId === target.nodeId &&
            probe.status === 'pass' &&
            probe.observedAt &&
            command.completedAt &&
            probe.observedAt > command.completedAt &&
            Date.now() - probe.observedAt.getTime() < 180000,
          );
        }
        if (
          command.result?.exitCode === 0 &&
          fresh &&
          application &&
          (!metadata.expectedAgentVersion || version === metadata.expectedAgentVersion)
        ) {
          target.status = 'completed';
          await tx.rolloutTarget.update({
            where: { id: target.id },
            data: {
              status: 'completed',
              completedAt: new Date(),
              evidence: JSON.stringify({
                commandId: command.id,
                exitCode: 0,
                heartbeatAt: heartbeat?.toISOString(),
                agentVersion: version,
                applicationVerified: application,
                verifiedAt: new Date().toISOString(),
              }),
            },
          });
          continue;
        }
        if (command.result?.exitCode !== 0) error = 'Successful signed command result missing';
        else {
          target.status = 'verifying';
          await tx.rolloutTarget.update({
            where: { id: target.id },
            data: { status: 'verifying' },
          });
        }
      } else if (command.status === 'QUEUED') enqueue.push(command.id);
      if (age > (metadata.timeoutSeconds + 180) * 1000)
        error = 'Execution or recovery verification expired; manual review required';
      if (error) {
        target.status = 'failed';
        await tx.rolloutTarget.update({
          where: { id: target.id },
          data: { status: 'failed', error, completedAt: new Date() },
        });
        if (command)
          await tx.remoteCommand.updateMany({
            where: { id: command.id, status: 'QUEUED' },
            data: { status: 'CANCELLED', completedAt: new Date() },
          });
      }
    }
    const failed = run.targets.filter((t) => t.status === 'failed').length;
    const completed = run.targets.filter((t) => t.status === 'completed').length;
    await tx.executionRun.update({
      where: { id: runId },
      data: { failedNodes: failed, completedNodes: completed },
    });
    const stop = failed > 0;
    if (stop || completed + failed === run.totalNodes) {
      // Wait for already admitted targets before closing; never claim pending targets completed.
      if (run.targets.some((t) => ['queued', 'verifying'].includes(t.status))) return enqueue;
      await tx.rolloutTarget.updateMany({
        where: { rolloutId: runId, status: 'pending' },
        data: { status: 'cancelled', completedAt: new Date() },
      });
      await tx.executionRun.update({
        where: { id: runId },
        data: { status: failed ? 'failed' : 'completed', completedAt: new Date() },
      });
      return [] as string[];
    }
    if (
      run.status === 'paused' ||
      run.targets.some((t) => ['queued', 'verifying'].includes(t.status))
    )
      return enqueue;
    const wave = metadata.waves.find((w) =>
      w.some((id) => run.targets.some((t) => t.nodeId === id && t.status === 'pending')),
    );
    // maxUnavailable is the disruption budget: admitted operations remain in
    // flight until their post-action evidence passes, even after command exit.
    const budget = Math.max(1, metadata.maxUnavailable ?? 1);
    const unhealthy = run.targets.filter(t => !['failed', 'cancelled'].includes(t.status) &&
      (t.node.status !== 'ONLINE' || !t.node.lastHeartbeatAt || Date.now() - t.node.lastHeartbeatAt.getTime() >= 120000));
    if (unhealthy.length) {
      for (const target of unhealthy) await tx.rolloutTarget.update({ where: { id: target.id },
        data: { status: 'failed', error: 'Target lost fresh online health before next admission', completedAt: new Date() } });
      return enqueue; // next reconciliation closes the failed rollout; admit nothing
    }
    const pendingWave = (wave ?? []).filter(nodeId =>
      run.targets.some(t => t.nodeId === nodeId && t.status === 'pending'));
    for (const nodeId of pendingWave.slice(0, budget)) {
      const target = run.targets.find((t) => t.nodeId === nodeId && t.status === 'pending');
      if (!target) continue;
      if (metadata.executionDeadline !== undefined && metadata.executionDeadline <= Date.now()) {
        await tx.rolloutTarget.update({ where: { id: target.id }, data: { status: 'failed', error: 'Approved execution deadline expired before dispatch', completedAt: new Date() } });
        continue;
      }
      let coordinationJson: string | undefined;
      if (metadata.executionDeadline !== undefined) {
        const resourceKey = `node:${target.nodeId}`;
        const fence = await tx.commandResourceFence.upsert({ where: { resourceKey },
          create: { resourceKey, generation: 1n }, update: { generation: { increment: 1n } } });
        coordinationJson = JSON.stringify({ version: 1, resourceKey, fence: fence.generation.toString(), expiresAt: metadata.executionDeadline });
      }
      const command = await tx.remoteCommand.create({
        data: {
          nodeId,
          command: metadata.command,
          args: JSON.stringify(metadata.args),
          timeoutSeconds: metadata.timeoutSeconds,
          executionDeadline: metadata.executionDeadline !== undefined ? new Date(metadata.executionDeadline) : null,
          coordinationJson,
          status: 'QUEUED',
          idempotencyKey: `rollout:${runId}:${nodeId}`,
          correlationId: runId,
          createdBy: run.createdBy,
        },
      });
      await tx.rolloutTarget.update({
        where: { id: target.id },
        data: { status: 'queued', startedAt: new Date(), commandId: command.id },
      });
      enqueue.push(command.id);
    }
    return enqueue;
  });
  for (const id of dispatch) await enqueueCommand(id);
}

export async function setRolloutControl(
  runId: string,
  action: 'pause' | 'resume' | 'abort',
): Promise<void> {
  const db = getDb();
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`rollout:${runId}`}, 0))`;
    const run = await tx.executionRun.findUnique({
      where: { id: runId },
      include: { targets: true },
    });
    if (!run) throw new HttpError(404, 'NOT_FOUND', 'Rollout not found');
    if (!['created', 'running', 'paused'].includes(run.status))
      throw new HttpError(409, 'ROLLOUT_STATE', 'Rollout is terminal');
    if (
      (action === 'pause' && run.status !== 'running') ||
      (action === 'resume' && run.status !== 'paused')
    )
      throw new HttpError(409, 'ROLLOUT_STATE', 'Invalid control transition');
    if (action === 'abort') {
      await tx.remoteCommand.updateMany({
        where: {
          id: { in: run.targets.flatMap((t) => (t.commandId ? [t.commandId] : [])) },
          status: 'QUEUED',
        },
        data: { status: 'CANCELLED', completedAt: new Date() },
      });
      await tx.rolloutTarget.updateMany({
        where: { rolloutId: runId, status: { in: ['pending', 'queued', 'verifying'] } },
        data: {
          status: 'cancelled',
          error: 'Operator aborted; an already running command may finish',
          completedAt: new Date(),
        },
      });
    }
    await tx.executionRun.update({
      where: { id: runId },
      data: {
        status: action === 'abort' ? 'cancelled' : action === 'pause' ? 'paused' : 'running',
        ...(action === 'abort' ? { completedAt: new Date() } : {}),
      },
    });
  });
}

export async function getRolloutStatus(runId: string) {
  const run = await getDb().executionRun.findUnique({
    where: { id: runId },
    include: { targets: { include: { node: { select: { hostname: true } } } } },
  });
  if (!run) throw new HttpError(404, 'NOT_FOUND', 'Rollout not found');
  return {
    ...run,
    strategy: run.rolloutStrategy,
    metadata: JSON.parse(run.metadata),
    targets: run.targets.map((t) => ({
      ...t,
      hostname: t.node.hostname,
      evidence: JSON.parse(t.evidence),
    })),
  };
}
let timer: ReturnType<typeof setInterval> | undefined;
let busy = false;
export function startRolloutReconciler() {
  if (timer) return;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const runs = await getDb().executionRun.findMany({
        where: { status: { in: ['created', 'running', 'paused'] } },
        take: 100,
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      for (const run of runs) {
        try {
          await executeRollout(run.id);
        } catch {
          console.error(`[rollout] reconciliation pending for ${run.id}`);
        }
      }
      const { reconcileRemediation } = await import('./remediation-service.js');
      await reconcileRemediation();
      recordMonitorPulse('rollouts');
    } finally {
      busy = false;
    }
  };
  timer = setInterval(() => {
    void tick().catch(() => console.error('[rollout] storage unavailable'));
  }, 2000);
  timer.unref();
}
export function stopRolloutReconciler() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
