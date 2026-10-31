import { randomUUID } from 'node:crypto';
import { freshSchedulerStatus, schedulerStatusSchema } from './scheduler-status.js';
/** Fresh fixed-endpoint authority and the existing signed supervisor/command ledger. */
import { CONTROL_API_URL, HOST_FQDN, NODE_MANAGER_SECRET, RESULT_SIGNING_SECRET, MAGNUS_EXECUTION_SUPERVISOR_ENABLED } from '../env.js';
import { controlApiFetch } from '../tls.js';
import { CommandLedger, commandRequestDigest } from './command-ledger.js';
import { ExecutionSupervisor } from './execution-supervisor.js';
import { signCommandResult } from '../security/command-result-signature.js';
import { managedClaimSchema } from '../security/managed-http.js';
import type { SchedulerAuthority, SchedulerOccurrence } from './managed-scheduler.js';

export async function schedulerPost(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await controlApiFetch(CONTROL_API_URL.replace(/\/+$/, '') + '/api/v1/' + path, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', 'x-node-token': NODE_MANAGER_SECRET, 'cache-control': 'no-store' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('Scheduler authority unavailable or rejected');
  const reader = response.body?.getReader(); if (!reader) throw new Error('Scheduler authority response absent');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 64 * 1024) { await reader.cancel(); throw new Error('Unbounded scheduler authority response'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const text = Buffer.concat(chunks).toString('utf8');
  const result = JSON.parse(text) as { success?: boolean; data?: Record<string, unknown> };
  if (result.success !== true || !result.data) throw new Error('Scheduler authority response invalid');
  return result.data;
}
export function schedulerAuthority(options: { ledger?: CommandLedger; supervisor?: ExecutionSupervisor; post?: typeof schedulerPost; status?: typeof freshSchedulerStatus } = {}): SchedulerAuthority {
  const ledger = options.ledger ?? new CommandLedger(); const supervisor = options.supervisor ?? new ExecutionSupervisor();
  const post = options.post ?? schedulerPost;
  const signed = (row: SchedulerOccurrence, observation: Awaited<ReturnType<ExecutionSupervisor['status']>>) => {
    if (observation.state !== 'completed' || !observation.result || observation.evidence.requestSha256 !== row.requestSha256) throw new Error('Supervisor completion remains unknown');
    const value = { commandId: row.command.commandId, ...observation.result,
      coordination: { ...row.command.coordination!, requestSha256: row.requestSha256 } };
    return { ...value, signature: signCommandResult(value, RESULT_SIGNING_SECRET) };
  };
  return {
    async enrolled(identity) {
      const query = { nodeFqdn: HOST_FQDN, nonce: randomUUID() };
      const value = schedulerStatusSchema.parse(await (options.status ?? freshSchedulerStatus)(query));
      if (value.nonce !== query.nonce || value.state !== 'enrolled' || value.nodeId !== identity.nodeId
        || value.nodeFqdn !== HOST_FQDN || value.nodeFqdn !== identity.nodeFqdn || value.epoch !== identity.epoch
        || value.barrierId !== identity.barrierId) return null;
      return identity;
    },
    async admit(row) {
      if (!MAGNUS_EXECUTION_SUPERVISOR_ENABLED || RESULT_SIGNING_SECRET.length < 32) throw new Error('Managed scheduler supervisor is disabled');
      const value = await post('cron/managed-occurrences/admit', { nodeFqdn: HOST_FQDN, jobId: row.jobId,
        revision: row.revision, specSha256: row.specSha256, occurrenceId: row.occurrenceId, scheduledAt: row.scheduledAt, deadline: row.deadline });
      if (value['occurrenceId'] !== row.occurrenceId || value['specSha256'] !== row.specSha256 || value['commandId'] !== row.command.commandId)
        throw new Error('Occurrence authority binding differs');
      return value;
    },
    async execute(row) {
      if (!MAGNUS_EXECUTION_SUPERVISOR_ENABLED) throw new Error('Managed scheduler supervisor is disabled');
      const claim = managedClaimSchema.parse(row.admission?.['claim']);
      if (claim.nodeFqdn !== HOST_FQDN || row.command.coordination?.resourceKey !== 'node:' + claim.nodeId
        || row.admission?.['requestSha256'] !== commandRequestDigest(row.command)) throw new Error('Scheduler execution binding differs');
      const confirmation = { ...claim, commandId: row.command.commandId, requestSha256: row.requestSha256, coordination: row.command.coordination };
      const response = await post('resource-leases/claim', confirmation);
      if (response['admitted'] !== true || Object.entries(confirmation).some(([key, value]) => JSON.stringify(response[key]) !== JSON.stringify(value)))
        throw new Error('Fresh canonical occurrence admission differs');
      return ledger.execute(row.command, async () => signed(row, await supervisor.run(row.command)), claim);
    },
    async recover(row) {
      if (!row.command.coordination) return undefined;
      const receipt = await ledger.receipt(row.command.commandId);
      if (!receipt || receipt.requestSha256 !== row.requestSha256) return undefined;
      if (receipt.state === 'completed') return receipt.result;
      const observation = await supervisor.status(row.command.commandId, row.requestSha256);
      if (observation.state !== 'completed') return undefined;
      return (await ledger.adoptRecoveredResult(row.command.commandId, row.requestSha256, signed(row, observation))).result;
    },
    async settle(row) {
      // A no-dispatch assertion cannot free a grant already sent across the API
      // boundary. Such occurrences deliberately retain ownership for review.
      if (!row.result) throw new Error('Signed original completion required for scheduler settlement');
      const result = await post('cron/managed-occurrences/settle', { nodeFqdn: HOST_FQDN, occurrenceId: row.occurrenceId, result: row.result });
      if (result['occurrenceId'] !== row.occurrenceId || result['state'] !== 'completed') throw new Error('Scheduler settlement binding differs');
    },
  };
}
