import { managedExecution } from '../security/managed-context.js';
import { Hono } from 'hono';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { RESULT_SIGNING_SECRET, MAGNUS_EXECUTION_SUPERVISOR_ENABLED } from '../env.js';
import { startSpan } from '../collectors/otel-collector.js';
import { CommandLedger, CommandAdmissionError, commandFenceSchema, commandReconciliationSchema, type CommandReceiptResult } from './command-ledger.js';
import { signCommandResult } from '../security/command-result-signature.js';
import { ExecutionSupervisor } from './execution-supervisor.js';
import { mutationBarrier } from './mutation-barrier.js';
import { COMMAND_COMPLETION_REGISTRY, COMMAND_COMPLETION_REGISTRY_SHA256, commandCompletionDescriptor } from '../security/command-completion-registry.js';
import { childEnvironment } from '../utils/child-env.js';

export const commandRoutes = new Hono();
export const commandLedger = new CommandLedger();
export const executionSupervisor = new ExecutionSupervisor();
export const COMMAND_OUTPUT_MAX_BYTES = 1_000_000;

function utf8PrefixWithinBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let used = 0;
  let end = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (used + bytes > maxBytes) break;
    used += bytes;
    end += character.length;
  }
  return value.slice(0, end);
}

/** Retain at most `maxBytes` per stream without ever appending a crossing chunk. */
export class ByteBoundedOutput {
  readonly #chunks: Buffer[] = [];
  #byteLength = 0;
  public truncated = false;

  public constructor(readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new Error('maxBytes must be a non-negative safe integer');
    }
  }

  public get byteLength(): number {
    return this.#byteLength;
  }

  public append(data: Buffer | Uint8Array | string): void {
    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    const remaining = this.maxBytes - this.#byteLength;
    if (buffer.byteLength > remaining) this.truncated = true;
    if (remaining <= 0) return;
    const accepted = buffer.subarray(0, remaining);
    this.#chunks.push(Buffer.from(accepted));
    this.#byteLength += accepted.byteLength;
  }

  public toString(): string {
    const decoded = Buffer.concat(this.#chunks, this.#byteLength).toString('utf8');
    // An input limit may land inside a multibyte code point. Bound the encoded
    // result too, avoiding a replacement character that exceeds maxBytes.
    return utf8PrefixWithinBytes(decoded, this.maxBytes);
  }
}

/** Track running child processes for graceful drain */
const runningProcesses = new Set<ReturnType<typeof spawn>>();
const pendingExecutions = new Set<Promise<CommandReceiptResult>>();
let draining = false;

/** Wait for all in-flight commands to finish, with a hard timeout */
export async function drainRunningCommands(timeoutMs = 30_000): Promise<void> {
  draining = true;
  if (pendingExecutions.size === 0) return;
  console.log(`[command-executor] Draining ${pendingExecutions.size} running command(s)...`);
  const wait = async (duration: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.allSettled([...pendingExecutions]),
      new Promise<void>(resolve => { timer = setTimeout(resolve, duration); })]); }
    finally { clearTimeout(timer); }
  };
  await wait(timeoutMs);
  for (const child of runningProcesses) signalProcessGroup(child, 'SIGKILL');
  // Include persistence, not only process close: shutdown must allow the signed
  // terminal receipt to reach disk. If this expires, the durable claim remains.
  if (pendingExecutions.size) await wait(5_000);
}

/** Zod schema for command execution request body. */
export const executeBodySchema = z.object({
  commandId: z.string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'commandId must be a bounded identifier'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  workingDirectory: z.string().optional(),
  environment: z.record(z.string(), z.string()).optional(),
  coordination: commandFenceSchema.optional(),
  timeoutSeconds: z.number().int().min(1).max(3600).default(60),
});

type ExecuteBody = z.infer<typeof executeBodySchema>;

// ── Execute a command locally ──
commandRoutes.post('/execute', async (c) => {
  const raw = await c.req.json();
  const parsed = executeBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: parsed.error.issues.map(e => e.message).join('; ') },
    }, 400);
  }

  try {
    const result = await executeCommand(parsed.data);
    return c.json({ success: true, data: result });
  } catch (error) {
    if (!(error instanceof CommandAdmissionError)) throw error;
    return c.json({ success: false, error: { code: error.code, message: error.message } },
      error.code === 'LEDGER_UNAVAILABLE' ? 503 : 409);
  }
});

/**
 * Execute a shell command with timeout, capturing stdout and stderr.
 *
 * @param opts - Execution options from the API request body.
 * @param opts.commandId - Unique ID passed through to the result (for correlation).
 * @param opts.command - The command to run (passed as shell string).
 * @param opts.args - Argument array appended after `command`.
 * @param opts.workingDirectory - CWD for the child process; defaults to `process.cwd()`.
 * @param opts.environment - Additional environment variables merged over the agent environment (agent credentials removed).
 * @param opts.timeoutSeconds - Hard kill timeout; process receives SIGTERM then SIGKILL.
 * @returns Resolved CommandResult with exit code, stdout/stderr, duration, and truncation flag.
 */
export async function executeCommand(input: ExecuteBody): Promise<CommandReceiptResult> {
  // Parse/snapshot even internal callers before awaiting or executing effects.
  const opts = executeBodySchema.parse(input);
  if (draining) throw new CommandAdmissionError('LEDGER_UNAVAILABLE', 'Node is draining; no command executed');
  if (RESULT_SIGNING_SECRET.length < 32) throw new CommandAdmissionError('LEDGER_UNAVAILABLE', 'Command signing is unavailable; no command executed');
  if (opts.coordination && !MAGNUS_EXECUTION_SUPERVISOR_ENABLED)
    throw new CommandAdmissionError('LEDGER_UNAVAILABLE', 'Managed commands require the node execution supervisor; no command executed');
  const pending = commandLedger.execute(opts, (digest) => MAGNUS_EXECUTION_SUPERVISOR_ENABLED
    ? executeSupervised(opts, digest) : executeProcess(opts, digest), managedExecution.getStore()?.claim);
  pendingExecutions.add(pending);
  try { return await pending; } finally { pendingExecutions.delete(pending); }
}

async function executeSupervised(opts: ExecuteBody, digest: string): Promise<CommandReceiptResult> {
  const descriptor = commandCompletionDescriptor(opts);
  const completionOwner = descriptor ? { version: 1 as const, registrySha256: COMMAND_COMPLETION_REGISTRY_SHA256,
    descriptorId: descriptor.id } : undefined;
  const observation = await executionSupervisor.run(opts, completionOwner);
  if (!completionOwner) throw new CommandAdmissionError('OUTCOME_UNKNOWN',
    'The immediate process ended without registered whole-effect evidence; retain ownership');
  if (observation.state !== 'completed' || !observation.result || observation.evidence.requestSha256 !== digest)
    throw new CommandAdmissionError('OUTCOME_UNKNOWN', 'Execution supervisor has not proven completion; retain ownership and reconcile');
  if (JSON.stringify(observation.evidence.completionOwner) !== JSON.stringify(completionOwner))
    throw new CommandAdmissionError('OUTCOME_UNKNOWN', 'Execution completion registry evidence differs; retain ownership');
  const result = { commandId: opts.commandId, ...observation.result,
    ...(opts.coordination ? { coordination: { ...opts.coordination, requestSha256: digest } } : {}),
    completion: { registryVersion: 1 as const, registrySha256: completionOwner.registrySha256,
      descriptorId: completionOwner.descriptorId } };
  return { ...result, signature: signCommandResult(result, RESULT_SIGNING_SECRET) };
}

/** Agent restart adopts the original unit's terminal evidence; it never starts it. */
export async function recoverCommandReceipt(commandId: string) {
  const row = await commandLedger.receipt(commandId);
  if (!row || !['unknown', 'completed'].includes(row.state)) return row;
  try {
    const observation = await executionSupervisor.status(commandId, row.requestSha256);
    if (observation.state !== 'completed' || !observation.result || observation.evidence.requestSha256 !== row.requestSha256
      || observation.evidence.completionOwner?.version !== 1
      || observation.evidence.completionOwner.registrySha256 !== COMMAND_COMPLETION_REGISTRY_SHA256
      || !COMMAND_COMPLETION_REGISTRY.descriptors.some(descriptor => descriptor.id === observation.evidence.completionOwner?.descriptorId)) return row;
    const result = { commandId, ...observation.result,
      ...(row.coordination ? { coordination: { ...row.coordination, requestSha256: row.requestSha256 } } : {}),
      completion: { registryVersion: 1 as const, registrySha256: observation.evidence.completionOwner.registrySha256,
        descriptorId: observation.evidence.completionOwner.descriptorId } };
    const recovered = await commandLedger.adoptRecoveredResult(commandId, row.requestSha256,
      { ...result, signature: signCommandResult(result, RESULT_SIGNING_SECRET) });
    await mutationBarrier.settleCompletedCommand(commandId, commandLedger);
    return recovered;
  } catch { return row; }
}

function signalProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function executeProcess(opts: ExecuteBody, digest: string): Promise<CommandReceiptResult> {
  const span = startSpan('command.execute', {
    kind: 'internal',
    attributes: {
      'command.id': opts.commandId,
      // The request digest identifies the command without retaining arguments
      // (which may carry secrets) in the trace buffer or OTLP export.
      'command.request_sha256': digest,
      'command.timeout_s': opts.timeoutSeconds,
    },
  });

  return new Promise((resolve, reject) => {
    const start = Date.now();
    const stdout = new ByteBoundedOutput(COMMAND_OUTPUT_MAX_BYTES);
    const stderr = new ByteBoundedOutput(COMMAND_OUTPUT_MAX_BYTES);
    let killed = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(hardKillTimer);
      if (child) runningProcesses.delete(child);
      const result = {
        commandId: opts.commandId, exitCode, stdout: stdout.toString(), stderr: stderr.toString(),
        durationMs: Date.now() - start, truncated: stdout.truncated || stderr.truncated,
        ...(opts.coordination ? { coordination: { ...opts.coordination, requestSha256: digest } } : {}),
      };
      span.setAttribute('command.exit_code', exitCode);
      span.setAttribute('command.duration_ms', result.durationMs);
      span.setAttribute('command.truncated', result.truncated);
      span.end(exitCode === 0 ? 'ok' : 'error');
      try { resolve({ ...result, signature: signCommandResult(result, RESULT_SIGNING_SECRET) }); }
      catch (error) { reject(error); }
    };
    // Recheck immediately before spawn, after the durable claim's filesystem IO.
    const remaining = opts.coordination ? opts.coordination.expiresAt - Date.now() : Infinity;
    if (remaining <= 0) {
      stderr.append('Command lease expired before process start; command not executed'); finish(125); return;
    }
    child = spawn(opts.command, opts.args, {
      cwd: opts.workingDirectory ?? process.cwd(), env: childEnvironment(opts.environment),
      shell: true, detached: process.platform !== 'win32',
    });
    const processChild = child;
    runningProcesses.add(child);
    child.stdout?.on('data', (data: Buffer) => stdout.append(data));
    child.stderr?.on('data', (data: Buffer) => stderr.append(data));
    timer = setTimeout(() => {
      killed = true;
      signalProcessGroup(processChild, 'SIGTERM');
      hardKillTimer = setTimeout(() => signalProcessGroup(processChild, 'SIGKILL'), 5_000);
    }, Math.min(opts.timeoutSeconds * 1000, remaining));
    // On spawn errors Node emits close as well; finish exactly once at close,
    // after all inherited output descriptors have closed.
    let spawnError = false;
    child.on('error', (error) => { spawnError = true; stderr.append(error.message); });
    child.on('close', (code) => {
      if (killed) signalProcessGroup(processChild, 'SIGKILL');
      finish(killed ? 124 : spawnError ? 127 : (code ?? 1));
    });
  });
}

// Receipts are behind the same authenticated node routes as execution. Unknown
// means that no terminal receipt was persisted; never infer safe replay from age.
commandRoutes.get('/receipts/:commandId', async (c) => {
  const id = c.req.param('commandId');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid command identifier' } }, 400);
  try {
    const row = await recoverCommandReceipt(id);
    if (!row) return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Command receipt not found' } }, 404);
    return c.json({ success: true, data: row });
  } catch {
    return c.json({ success: false, error: { code: 'LEDGER_UNAVAILABLE', message: 'Command receipt unavailable; do not replay' } }, 503);
  }
});

// Existing node authentication is necessary but insufficient: only the separate
// service reconciliation key can attest that an operator reviewed the evidence.
// This releases a receipt claim, never executes or authorizes remediation.
commandRoutes.post('/receipts/:commandId/reconcile', async (c) => {
  const parsed = commandReconciliationSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || parsed.data.commandId !== c.req.param('commandId')) {
    return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid command reconciliation assertion' } }, 400);
  }
  try {
    return c.json({ success: true, data: await commandLedger.reconcile(parsed.data) });
  } catch (error) {
    if (!(error instanceof CommandAdmissionError)) throw error;
    return c.json({ success: false, error: { code: error.code, message: error.message } },
      error.code === 'LEDGER_UNAVAILABLE' ? 503 : error.code === 'INVALID_RECONCILIATION' ? 403 : 409);
  }
});

// The former streaming endpoint could buffer attacker-controlled output without
// the signed result envelope used by `/execute`. Keep the route explicit so old
// clients receive a deterministic retirement response instead of a 404 retry.
commandRoutes.post('/stream', (c) => c.json({
  success: false,
  error: {
    code: 'GONE',
    message: 'Command streaming is retired; use POST /commands/execute for a bounded signed result',
  },
}, 410));
