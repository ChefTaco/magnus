/**
 * Run one command on a node through the durable command queue and wait for its result.
 *
 * The command gets a RemoteCommand row (QUEUED), the command worker dispatches it with the node
 * SDK (signed request, receipt and result signature checks) and the reconciler retries it if
 * Redis was unavailable. Callers that need an answer, like the AI assistant's tools, poll the row.
 */
import { nanoid } from 'nanoid';
import { getDb } from '../db/index.js';
import { enqueueCommand } from '../queue/workers.js';
import { errorText } from '../utils/redact.js';

export interface QueuedCommandInput {
  nodeId: string;
  command: string;
  args: string[];
  workingDirectory?: string | undefined;
  timeoutSeconds: number;
  /** Who the command runs for: the approving user, never a made-up service name when one is known. */
  createdBy: string;
  approvedBy?: string | undefined;
  riskLevel?: 'low' | 'medium' | 'high';
  correlationId?: string | undefined;
  /** Prefix of the idempotency key, naming the caller (for example `ai-exec`). */
  source: string;
}

export interface QueuedCommandOutcome {
  commandId: string;
  status: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number | null;
}

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED']);

export async function runQueuedCommand(
  input: QueuedCommandInput,
  options: { pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<QueuedCommandOutcome> {
  const db = getDb();
  const pollMs = options.pollMs ?? 1_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const command = await db.remoteCommand.create({
    data: {
      nodeId: input.nodeId,
      command: input.command,
      args: JSON.stringify(input.args),
      workingDirectory: input.workingDirectory ?? null,
      timeoutSeconds: input.timeoutSeconds,
      status: 'QUEUED',
      riskLevel: input.riskLevel ?? 'high',
      idempotencyKey: `${input.source}-${nanoid()}`,
      createdBy: input.createdBy,
      approvedBy: input.approvedBy ?? null,
      correlationId: input.correlationId ?? null,
    },
  });
  // The durable QUEUED row is retried by the reconciler if Redis is unavailable.
  await enqueueCommand(command.id).catch((error: unknown) => console.error(`[${input.source}] queue admission pending for ${command.id}: ${errorText(error)}`));

  const deadline = now() + (input.timeoutSeconds + 30) * 1_000;
  while (now() < deadline) {
    await sleep(pollMs);
    const row = await db.remoteCommand.findUnique({ where: { id: command.id }, include: { result: true } });
    if (row && TERMINAL.has(row.status)) {
      return {
        commandId: command.id,
        status: row.status,
        exitCode: row.result?.exitCode ?? 1,
        stdout: row.result?.stdout ?? '',
        stderr: row.result?.stderr ?? '',
        durationMs: row.result?.durationMs ?? null,
      };
    }
  }
  return { commandId: command.id, status: 'WAITING', exitCode: 124, stdout: '', stderr: 'Timed out waiting for the command result; it may still finish (see the command list)', durationMs: null };
}
