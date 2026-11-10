/** Retain the exact inner supervisor identity before dispatch; recovery only observes. */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { embermendCanonical, embermendOperationSchema, embermendResultPointerSchema, embermendNativeResultSchema, type EmbermendOperation } from '@hivemagnus/magnus-contracts/embermend';
import { commandFenceSchema, type CommandFence } from './command-ledger.js';
import { privateDirectory, readJson, writeJson, requestDigest, type SupervisorInput } from './execution-supervisor-state.js';
import type { ExecutionSupervisor } from './execution-supervisor.js';
import { NATIVE_COMPLETION_REGISTRY_SHA256 } from '../security/native-completion-registry.js';
import { loadEmbermendConfig } from './embermend-config.js';
import { workerContainerGone } from './embermend-scan.js';
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown): string => sha(embermendCanonical(value));
const bindingSchema = z.object({ version: z.literal(1), registrySha256: z.literal(NATIVE_COMPLETION_REGISTRY_SHA256), commandId: z.string(), requestSha256: z.string().regex(/^[a-f0-9]{64}$/), coordination: commandFenceSchema, operation: embermendOperationSchema, supervisorCommandId: z.string(), supervisorRequestSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const directory = (): string => resolve(process.env['AGENT_INSTALL_DIR'] ?? process.cwd(), '.magnus/embermend-bindings');
export async function retainEmbermendExecution(context: { commandId: string; requestSha256: string; coordination?: CommandFence }, operation: EmbermendOperation, input: SupervisorInput): Promise<void> {
  const row = bindingSchema.parse({ version: 1, registrySha256: NATIVE_COMPLETION_REGISTRY_SHA256, commandId: context.commandId, requestSha256: context.requestSha256, coordination: context.coordination, operation, supervisorCommandId: input.commandId, supervisorRequestSha256: requestDigest(input) });
  const root = directory(); await privateDirectory(root); const name = sha(row.commandId) + '.json'; const prior = await readJson<unknown>(root, name);
  if (prior && digest(bindingSchema.parse(prior)) !== digest(row)) throw new Error('Native execution binding differs');
  if (!prior) await writeJson(root, name, row);
}
export async function recoverEmbermendResponse(commandId: string, requestSha256: string, coordination: CommandFence | undefined, supervisor: Pick<ExecutionSupervisor, 'status'>): Promise<{ status: 200; body: string; durationMs: number } | undefined> {
  const raw = await readJson<unknown>(directory(), sha(commandId) + '.json'); if (!raw) return undefined;
  const binding = bindingSchema.parse(raw);
  if (binding.commandId !== commandId || binding.requestSha256 !== requestSha256 || digest(binding.coordination) !== digest(coordination ?? null) || binding.supervisorCommandId !== 'embermend-' + sha(commandId + ':' + requestSha256)) throw new Error('Native recovery owner differs');
  const observation = await supervisor.status(binding.supervisorCommandId, binding.supervisorRequestSha256);
  if (observation.state !== 'completed' || observation.evidence.commandId !== binding.supervisorCommandId || observation.evidence.requestSha256 !== binding.supervisorRequestSha256 || observation.evidence.groupEmpty !== true || !observation.result || observation.result.truncated || observation.result.exitCode !== 0) return undefined;
  // The inner cgroup alone cannot establish completion of a rootless daemon's work.
  if (['repository-scan.v1', 'repository-prepare.v1', 'repository-source.v1'].includes(binding.operation.action.version)) {
    const inner = z.object({ request: z.object({ operationId: z.string().optional(), id: z.string().optional() }).passthrough() }).passthrough().parse(binding.operation.action.parameters).request;
    const id = inner.operationId ?? inner.id; const config = await loadEmbermendConfig();
    if (!id || !config.worker || !await workerContainerGone(config.worker, id)) return undefined;
  }
  const pointer = embermendResultPointerSchema.parse({ success: true, data: JSON.parse(observation.result.stdout) });
  const resultKey = sha(binding.operation.operationId + ':' + digest(binding.operation));
  if (pointer.data.resultKey !== resultKey) throw new Error('Native result operation differs');
  const resultRoot = resolve(process.env['AGENT_INSTALL_DIR'] ?? process.cwd(), '.magnus/embermend-results');
  const result = embermendNativeResultSchema.parse(await readJson<unknown>(resultRoot, resultKey + '.json', 8 * 1024 * 1024));
  if (!result.success || pointer.data.resultDigest !== digest(result)) throw new Error('Native result digest differs');
  return { status: 200, body: JSON.stringify(pointer), durationMs: observation.result.durationMs };
}
