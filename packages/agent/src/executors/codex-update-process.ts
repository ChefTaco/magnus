import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedExecution } from '../security/managed-context.js';
import { agentPrivileged } from '../privileged.js';
import { ExecutionSupervisor } from './execution-supervisor.js';

/** Includes npm, release discovery and the final App Server inspection in one cgroup. */
export async function runCodexUpdateWorker(target: { user: string; home: string; codexHome: string; bin: string | null }): Promise<string> {
  if (!agentPrivileged() || process.env['MAGNUS_EXECUTION_SUPERVISOR_ENABLED'] !== 'true')
    throw new Error('Codex updates require privileged mode and MAGNUS_EXECUTION_SUPERVISOR_ENABLED=true');
  const context = managedExecution.getStore();
  const identity = context ? `${context.commandId}:${context.requestSha256}` : randomUUID();
  const commandId = `codex-update-${createHash('sha256').update(identity).digest('hex')}`;
  // The supervisor's unregistered worker uses a shell. Quote each argument;
  // neither account settings nor installation paths become executable syntax.
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const worker = join(dirname(fileURLToPath(import.meta.url)), 'codex-update-worker.js');
  const observation = await new ExecutionSupervisor().run({
    commandId,
    command: quote('/usr/bin/node'),
    args: [quote(worker)],
    timeoutSeconds: 780,
    ...(context?.coordination ? { coordination: context.coordination } : {}),
    environment: {
      HOME: target.home,
      CODEX_USER: target.user,
      CODEX_HOME: target.codexHome,
      ...(target.bin ? { CODEX_BIN: target.bin } : {}),
    },
  });
  if (observation.state !== 'completed' || observation.evidence.groupEmpty !== true || !observation.result)
    throw new Error('Codex update completion is uncertain; inspect the original managed receipt before retrying');
  if (observation.result.exitCode !== 0)
    throw new Error(`Codex update worker failed (exit ${observation.result.exitCode}): ${observation.result.stderr.slice(-1000)}`);
  return observation.result.stdout;
}
