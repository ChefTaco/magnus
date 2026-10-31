import { ResourceLeaseConflict } from '../services/command-resource-leases.js';
import { securityFusionLocal } from '../services/security-export.js';
import { recordMonitorPulse } from '../services/monitor-pulse.js';
import { Queue, Worker, type Job } from 'bullmq';
import { addDurableJob } from './requeue.js';
import { validateRemediationCommandForDispatch } from '../services/remediation-service.js';
import { reconcileCommands } from '../services/command-lifecycle.js';
import { reconcileRestartVerification } from '../services/security-fusion-verification.js';
import { getDb } from '../db/index.js';
import { NodeApiClient } from '../sdk/index.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { createNotification } from '../services/notification-service.js';
import {
  RESULT_SIGNING_PREVIOUS_SECRET,
  RESULT_SIGNING_SECRET,
  getNodeManagerSecret,
} from '../utils/env.js';
import { safeParse } from '../utils/validate.js';
import { commandFenceSchema, commandResultSchema } from '../schemas/node-responses.js';
import { incMetric } from '../routes/metrics.js';
import { securityFusionActionSources } from '../services/security-fusion-actions.js';
import { verifyCommandResultSignature } from '../security/command-result-signature.js';

// ─── Command execution queue ───

const REDIS_PREFIX = process.env['REDIS_PREFIX'] ?? 'magnus-';
const COMMAND_QUEUE = `${REDIS_PREFIX}commands`;

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';

let _commandQueue: Queue<CommandJobPayload> | null = null;
let _commandWorker: Worker<CommandJobPayload> | null = null;

let reconciliationTimer: ReturnType<typeof setInterval> | undefined;
let reconciliationBusy = false;

const COMMAND_EXECUTION_LEASE_MS = 5 * 60 * 1_000;
const NODE_HEARTBEAT_FRESHNESS_MS = Number(
  process.env['STALE_NODE_THRESHOLD_MS'] ?? 120_000,
);

/** Get the singleton command queue instance. */
export function getCommandQueue(): Queue<CommandJobPayload> {
  if (!_commandQueue) {
    _commandQueue = new Queue<CommandJobPayload>(COMMAND_QUEUE, {
      connection: { url: REDIS_URL },
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 60 * 60, count: 1_000 },
        removeOnFail: { age: 24 * 60 * 60, count: 1_000 },
      },
    });
  }
  return _commandQueue;
}

/** Close the singleton command queue. */
export async function closeCommandQueue(): Promise<void> {
  if (reconciliationTimer) clearInterval(reconciliationTimer);
  reconciliationTimer = undefined;
  if (_commandWorker) {
    await _commandWorker.close();
    _commandWorker = null;
  }
  if (_commandQueue) {
    await _commandQueue.close();
    _commandQueue = null;
  }
}

export interface CommandJobPayload {
  commandId: string;
}

export function createCommandJobPayload(commandId: string): CommandJobPayload {
  return { commandId };
}

/** Persist only the database identifier in Redis. All credentials and command
 * fields are loaded immediately before the worker atomically claims execution. */
export async function enqueueCommand(commandId: string): Promise<void> {
  // A retained finished job (claim skipped for a stale node, lease conflict
  // reset to QUEUED, transient claim error) must not swallow the requeue.
  await addDurableJob(getCommandQueue(), 'execute', createCommandJobPayload(commandId), {
    jobId: `cmd-${commandId}`,
    attempts: 1,
    removeOnComplete: { age: 60 * 60, count: 1_000 },
    removeOnFail: { age: 24 * 60 * 60, count: 1_000 },
  });
}

/**
 * Verify agent HMAC-SHA256 signature over command result fields.
 * Returns true if valid, false if tampered. Skips if secret is not configured.
 */
async function recordSecurityFusionCommandResult(
  commandId: string,
  succeeded: boolean,
  detail: Record<string, unknown>,
): Promise<void> {
  const db = getDb();
  const outbox = await db.securityFusionCommandOutbox.findUnique({
    where: { remoteCommandId: commandId },
  });
  const action = outbox
    ? await db.securityFusionAction.findUnique({ where: { id: outbox.actionId } })
    : null;
  if (action && outbox) {
    if (succeeded && action.kind === 'service_restart') {
      const transitioned = await db.securityFusionAction.updateMany({
        where: { id: action.id, status: { in: securityFusionActionSources('verifying') } },
        data: { status: 'verifying', resultJson: JSON.stringify({ commandId, ...detail }) },
      });
      if (transitioned.count !== 1) return;
      await db.securityFusionCaseActivity.create({
        data: {
          caseId: action.caseId,
          kind: 'containment.restart_verifying',
          actorId: 'system:command-worker',
          detailJson: JSON.stringify({ actionId: action.id, commandId }),
        },
      });
      return;
    }
    const releasing = outbox.operation === 'release';
    const status = succeeded ? (releasing ? 'released' : 'succeeded') : 'failed';
    const transitioned = await db.securityFusionAction.updateMany({
      where: {
        id: action.id,
        status: {
          in: securityFusionActionSources(status),
        },
      },
      data: { status, resultJson: JSON.stringify({ commandId, ...detail }) },
    });
    if (transitioned.count !== 1) return;
    await db.securityFusionCaseActivity.create({
      data: {
        caseId: action.caseId,
        kind: `containment.${status}`,
        actorId: 'system:command-worker',
        detailJson: JSON.stringify({ actionId: action.id, commandId, ...detail }),
      },
    });
  }
}

/** Start the command execution worker. */
export function startCommandWorker(): Worker<CommandJobPayload> {
  if (_commandWorker) return _commandWorker;
  const worker = new Worker<CommandJobPayload>(
    COMMAND_QUEUE,
    async (job: Job<CommandJobPayload>) => {
      const db = getDb();
      const { commandId } = job.data;
      const now = new Date();

      // This compare-and-set is the execution idempotency boundary. Duplicate,
      // delayed, cancelled, recovered, stale-node, or already-finished jobs
      // never reach the side-effecting agent call. The lease cutoff also closes
      // the startup race where BullMQ can deliver a legacy job before stale
      // recovery has completed.
      const claimed = await db.remoteCommand.updateMany({
        where: {
          id: commandId,
          status: 'QUEUED',
          OR: [{ executionDeadline: null }, { executionDeadline: { gt: now } }],
          createdAt: { gte: new Date(now.getTime() - COMMAND_EXECUTION_LEASE_MS) },
          node: {
            status: 'ONLINE',
            lastHeartbeatAt: {
              gte: new Date(now.getTime() - NODE_HEARTBEAT_FRESHNESS_MS),
            },
          },
        },
        data: { status: 'RUNNING', startedAt: now },
      });
      if (claimed.count !== 1) return;

      let command = '<unavailable>';
      let args: string[] = [];
      let nodeId: string | null = null;

      try {
        // Hydrate only after the atomic claim, so Redis never contains command
        // arguments, environment, endpoint data, or credentials. Keep all
        // parsing and client construction inside the failure boundary so a
        // malformed stored record cannot remain RUNNING.
        const commandRecord = await db.remoteCommand.findUnique({
          where: { id: commandId },
          include: { node: true },
        });
        if (!commandRecord) throw new Error('Claimed command no longer exists');
        command = commandRecord.command;
        args = JSON.parse(commandRecord.args as string) as string[];
        if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
          throw new Error('Stored command args are malformed');
        }
        const environment = commandRecord.environment
          ? JSON.parse(commandRecord.environment as string) as Record<string, string>
          : undefined;
        if (
          environment
          && (
            Array.isArray(environment)
            || typeof environment !== 'object'
            || Object.entries(environment).some(
              ([key, value]) => !key || typeof value !== 'string',
            )
          )
        ) {
          throw new Error('Stored command environment is malformed');
        }
        nodeId = commandRecord.nodeId;
        const heartbeat = commandRecord.node.lastHeartbeatAt;
        if (
          commandRecord.node.status !== 'ONLINE'
          || !heartbeat
          || Date.now() - heartbeat.getTime() > NODE_HEARTBEAT_FRESHNESS_MS
        ) {
          throw new Error('Command target is no longer online with a fresh heartbeat');
        }
        const nodeBaseUrl = getNodeBaseUrl(
          commandRecord.node.ipAddress,
          commandRecord.node.port,
        );
        const client = new NodeApiClient({
          baseUrl: nodeBaseUrl,
          resourceNodeId: commandRecord.nodeId, resourceActorId: commandRecord.createdBy,
          nodeToken: getNodeManagerSecret(),
        });
        const coordination = commandRecord.coordinationJson ? commandFenceSchema.parse(JSON.parse(commandRecord.coordinationJson)) : undefined;
        if (commandRecord.executionDeadline && (!coordination
          || coordination.expiresAt !== commandRecord.executionDeadline.getTime()
          || coordination.resourceKey !== `node:${commandRecord.nodeId}`))
          throw new Error('Approved command deadline/fence binding is missing or differs');
        if (commandRecord.executionDeadline && commandRecord.executionDeadline.getTime() <= Date.now())
          throw new Error('Approved command deadline expired before dispatch');
        await validateRemediationCommandForDispatch(commandRecord);
        const response = await client.executeCommand({
          commandId,
          command,
          args,
          workingDirectory: commandRecord.workingDirectory ?? undefined,
          environment,
          timeoutSeconds: commandRecord.timeoutSeconds,
          ...(coordination ? { coordination } : {}),
        });

        const rawResult = response.data;

        // Validate response shape before persisting to DB
        const parsed = safeParse(rawResult, commandResultSchema);
        if (!parsed.success) {
          throw new Error(`Invalid command result from node-manager: ${parsed.error}`);
        }
        const result = parsed.data;
        if (result.commandId !== commandId) {
          throw new Error('Command result commandId does not match the dispatched command');
        }

        // Verify HMAC signature to detect tampered results
        if (!verifyCommandResultSignature(
          result,
          RESULT_SIGNING_SECRET,
          RESULT_SIGNING_PREVIOUS_SECRET,
        )) {
          console.warn(`[CommandWorker] HMAC verification failed for command ${commandId}`);
          throw new Error('HMAC signature verification failed — result may be tampered');
        }

        incMetric('commandsCompleted');

        // Persist the signed result and terminal state atomically. Late workers
        // cannot overwrite a cancellation or an expired unknown outcome.
        const recorded = await db.$transaction(async tx => {
          const changed = await tx.remoteCommand.updateMany({
            where: { id: commandId, status: 'RUNNING' },
            data: { status: result.exitCode === 0 ? 'COMPLETED' : 'FAILED', completedAt: new Date() },
          });
          if (!changed.count) return false;
          await tx.commandResult.create({ data: { commandId, exitCode: result.exitCode,
            stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs, truncated: result.truncated } });
          return true;
        });
        if (!recorded) return;
        if (securityFusionLocal()) await recordSecurityFusionCommandResult(commandId, result.exitCode === 0, {
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        });

        // Emit notification on command failure
        if (result.exitCode !== 0) {
          // Look up node name for the notification
          const node = await db.node.findUnique({
            where: { id: nodeId },
            select: { name: true },
          });
          await createNotification({
            type: 'command.failed',
            severity: 'warning',
            title: `Command failed on ${node?.name ?? 'unknown'}`,
            message: `"${command} ${args.join(' ')}" exited with code ${result.exitCode}`,
            nodeId,
            nodeName: node?.name ?? null,
            sourceRef: commandId,
          });
        }
      } catch (err: unknown) {
        if (err instanceof ResourceLeaseConflict) {
          await db.remoteCommand.updateMany({ where: { id: commandId, status: 'RUNNING' },
            data: { status: 'QUEUED', startedAt: null } });
          return; // Durable reconciler retries only before the original approval deadline.
        }
        const errMsg = err instanceof Error ? err.message : 'unknown error';
        incMetric('commandsFailed');

        const failed = await db.$transaction(async tx => {
          const changed = await tx.remoteCommand.updateMany({
            where: { id: commandId, status: 'RUNNING' },
            data: { status: 'FAILED', completedAt: new Date() },
          });
          if (!changed.count) return false;
          await tx.commandResult.upsert({
            where: { commandId }, create: { commandId, exitCode: -1, stdout: '',
              stderr: `Worker error; outcome may be unknown: ${errMsg}`, durationMs: 0, truncated: false }, update: {},
          });
          return true;
        });
        if (!failed) throw err;
        if (securityFusionLocal()) await recordSecurityFusionCommandResult(commandId, false, { error: errMsg });

        // Emit notification on worker-level failure
        const node = nodeId ? await db.node.findUnique({
          where: { id: nodeId },
          select: { name: true },
        }).catch(() => null) : null;
        await createNotification({
          type: 'command.failed',
          severity: 'warning',
          title: `Command failed on ${node?.name ?? 'unknown'}`,
          message: `"${command} ${args.join(' ')}" failed: ${errMsg}`,
          nodeId: nodeId ?? undefined,
          nodeName: node?.name ?? null,
          sourceRef: commandId,
        });

        throw err;
      }
    },
    {
      connection: { url: REDIS_URL },
      concurrency: 10,
    },
  );

  worker.on('failed', (job, err) => {
    console.error(`[CommandWorker] Job ${job?.id} failed:`, err.message);
  });

  worker.on('error', (err) => {
    console.error('[CommandWorker] Worker error:', err.message);
  });

  const reconcile = async () => {
    if (reconciliationBusy) return;
    reconciliationBusy = true;
    try {
      await reconcileCommands();
      if (securityFusionLocal()) await reconcileRestartVerification();
      recordMonitorPulse('commands');
    } catch { console.error('[commands] reconciliation pending'); }
    finally { reconciliationBusy = false; }
  };
  void reconcile();
  reconciliationTimer = setInterval(() => void reconcile(), 5000);
  reconciliationTimer.unref();

  console.log('⚡ Command worker started');
  _commandWorker = worker;
  return worker;
}
