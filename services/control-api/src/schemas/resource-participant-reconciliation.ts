import { createHash } from 'node:crypto';
import { z } from 'zod';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const participantSchema = z.enum(['api', 'dashboard']);
export const participantWorkKindSchema = z.enum([
  'ssh-command', 'agent-deploy', 'agent-upgrade', 'control-deploy', 'agent-migrate',
  'self-update-check', 'self-update-apply', 'self-update-restart',
  'terminal-http', 'terminal-ws', 'hermes-http', 'hermes-ws',
]);
export type ParticipantWorkKind = z.infer<typeof participantWorkKindSchema>;

export const participantWorkReconciliationSchema = z.object({
  version: z.literal(1),
  workId: z.string().guid(),
  nodeId: z.string().min(1).max(128),
  nodeFqdn: z.string().min(1).max(253),
  participant: participantSchema,
  ownerId: z.string().guid(),
  kind: participantWorkKindSchema,
  epoch: z.number().int().nonnegative(),
  barrierId: z.string().guid().nullable(),
  operationSha256: sha256Schema,
  fence: z.string().regex(/^[1-9][0-9]{0,19}$/),
  deadline: z.number().int().positive().max(8_640_000_000_000_000),
  requestSha256: sha256Schema,
  disposition: z.enum(['effects_verified', 'no_effect_verified']),
  evidenceSha256: sha256Schema,
  approvalRef: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,199}$/),
  decisionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  expiresAt: z.number().int().positive().max(8_640_000_000_000_000),
  signature: sha256Schema,
}).strict();

export type ParticipantWorkReconciliation = z.infer<typeof participantWorkReconciliationSchema>;

/** Historical rows had no request identity. This assertion binds their actual
 * stored bytes and three independently retained observations of quiescence.
 * It never asserts what the unknown HTTP request did. */
export const historicalParticipantWorkReconciliationSchema = z.object({
  version: z.literal(2),
  workId: z.string().guid(),
  nodeId: z.string().min(1).max(128),
  participant: z.literal('dashboard'),
  kind: z.literal('hermes-http'),
  recordSha256: sha256Schema,
  dashboardObservationSha256: sha256Schema,
  nodeObservationSha256: sha256Schema,
  operationAuditSha256: sha256Schema,
  observedAt: z.number().int().positive(),
  disposition: z.literal('historical_descendants_absent_outcome_unknown'),
  approvalRef: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,199}$/),
  decisionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  expiresAt: z.number().int().positive(),
  signature: sha256Schema,
}).strict();
export type HistoricalParticipantWorkReconciliation = z.infer<typeof historicalParticipantWorkReconciliationSchema>;
export function historicalParticipantWorkSigningPayload(value: Omit<HistoricalParticipantWorkReconciliation, 'signature'>): string {
  return 'magnus.resource-participant-historical-reconciliation.v2\n' + JSON.stringify(value);
}

export interface ParticipantWorkRequestIdentity {
  participant: z.infer<typeof participantSchema>;
  workId: string;
  nodeId: string;
  nodeFqdn: string;
  ownerId: string;
  kind: ParticipantWorkKind;
  epoch: number;
  barrierId: string | null;
  operationSha256: string;
  fence: string;
  deadline: number;
}

/**
 * Bind the complete immutable reservation. The operation digest is produced
 * from the exact bounded request bytes where that is possible. Interactive and
 * external work still cannot settle without independent descendant evidence.
 */
export function participantWorkRequestDigest(value: ParticipantWorkRequestIdentity): string {
  return createHash('sha256').update(JSON.stringify({
    domain: 'magnus.resource-participant-work.v2',
    participant: value.participant,
    workId: value.workId,
    nodeId: value.nodeId,
    nodeFqdn: value.nodeFqdn,
    ownerId: value.ownerId,
    kind: value.kind,
    epoch: value.epoch,
    barrierId: value.barrierId,
    operationSha256: value.operationSha256,
    fence: value.fence,
    deadline: value.deadline,
  })).digest('hex');
}

/** Separate domain prevents a command/result signature from releasing participant work. */
export function participantWorkReconciliationSigningPayload(
  assertion: Omit<ParticipantWorkReconciliation, 'signature'>,
): string {
  return JSON.stringify({
    domain: 'magnus.resource-participant-reconciliation.v1',
    version: assertion.version,
    workId: assertion.workId,
    nodeId: assertion.nodeId,
    nodeFqdn: assertion.nodeFqdn,
    participant: assertion.participant,
    ownerId: assertion.ownerId,
    kind: assertion.kind,
    epoch: assertion.epoch,
    barrierId: assertion.barrierId,
    operationSha256: assertion.operationSha256,
    fence: assertion.fence,
    deadline: assertion.deadline,
    requestSha256: assertion.requestSha256,
    disposition: assertion.disposition,
    evidenceSha256: assertion.evidenceSha256,
    approvalRef: assertion.approvalRef,
    decisionId: assertion.decisionId,
    expiresAt: assertion.expiresAt,
  });
}
