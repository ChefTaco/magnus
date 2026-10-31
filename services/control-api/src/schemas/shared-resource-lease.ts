import { createHash } from 'node:crypto';
import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const sharedResourceOperationIdSchema = identifier;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const unixSeconds = z.number().int().positive().max(253_402_300_799);
const actionClass = z.enum([
  'observe', 'analyze', 'create_artifact', 'create_draft', 'reversible_change',
  'deploy', 'external_publish', 'destructive_response',
]);

const repoKey = /^repo:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;
const providerKey = /^provider:[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)*$/;
const gpuKey = /^gpu:[a-z0-9][a-z0-9._-]*$/;

export const sharedResourceKeySchema = z.string().min(5).max(260).superRefine((value, context) => {
  if (!repoKey.test(value) && !providerKey.test(value) && !gpuKey.test(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom,
      message: 'Expected canonical lowercase repo:, provider:, provider:new:, or gpu: resource key' });
  }
});

const resourceKeys = z.array(sharedResourceKeySchema).min(1).max(8).superRefine((values, context) => {
  if (new Set(values).size !== values.length)
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Resource keys must be unique' });
  if (values.some((value, index) => index > 0 && values[index - 1]! >= value))
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Resource keys must be canonical-sorted' });
});

export const sharedResourceCallerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('direct') }).strict(),
  z.object({ kind: z.literal('delegated'), delegationId: identifier }).strict(),
]);

const sharedResourceReserveUnsignedSchema = z.object({
  version: z.literal(1),
  resourceKeys,
  missionRootId: identifier,
  missionRevision: z.number().int().positive().max(2_147_483_647),
  taskId: identifier,
  operationId: identifier,
  requestSha256: sha256,
  actionClass,
  deadline: unixSeconds,
  caller: sharedResourceCallerSchema,
}).strict();

export const sharedResourceMissionAssertionSchema = z.object({
  issuer: identifier,
  keyId: identifier,
  issuedAt: unixSeconds,
  expiresAt: unixSeconds,
  signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).min(80).max(128),
}).strict();

export const sharedResourceReserveSchema = sharedResourceReserveUnsignedSchema.extend({
  missionAssertion: sharedResourceMissionAssertionSchema,
}).strict();

export type SharedResourceReserve = z.infer<typeof sharedResourceReserveSchema>;
export type SharedResourceReserveUnsigned = z.infer<typeof sharedResourceReserveUnsignedSchema>;

export const sharedResourceFenceSchema = z.object({
  resourceKey: sharedResourceKeySchema,
  fenceGeneration: z.string().regex(/^[1-9][0-9]{0,19}$/),
}).strict();

const fences = z.array(sharedResourceFenceSchema).min(1).max(8).superRefine((values, context) => {
  if (new Set(values.map(value => value.resourceKey)).size !== values.length)
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Resource fences must be unique' });
  if (values.some((value, index) => index > 0 && values[index - 1]!.resourceKey >= value.resourceKey))
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Resource fences must be canonical-sorted' });
});

export const sharedResourceLeaseIdentitySchema = z.object({
  version: z.literal(1),
  resources: fences,
  missionRootId: identifier,
  missionRevision: z.number().int().positive().max(2_147_483_647),
  taskId: identifier,
  operationId: identifier,
  requestSha256: sha256,
  actionClass,
  deadline: unixSeconds,
  caller: sharedResourceCallerSchema,
  ownerActor: identifier,
}).strict();

export type SharedResourceLeaseIdentity = z.infer<typeof sharedResourceLeaseIdentitySchema>;

const terminalUnsigned = sharedResourceLeaseIdentitySchema.extend({
  outcome: z.enum(['succeeded', 'failed', 'no_effect']),
  evidenceSha256: sha256,
  completedAt: unixSeconds,
  issuer: identifier,
  keyId: identifier,
}).strict();

export const sharedResourceTerminalEvidenceSchema = terminalUnsigned.extend({
  signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).min(80).max(128),
}).strict();

export type SharedResourceTerminalEvidence = z.infer<typeof sharedResourceTerminalEvidenceSchema>;

export const sharedResourceReconciliationSchema = sharedResourceLeaseIdentitySchema.extend({
  disposition: z.enum(['effects_verified', 'no_effect_verified']),
  evidenceSha256: sha256,
  approvalRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/),
  decisionId: identifier,
  expiresAt: unixSeconds,
  signature: sha256,
}).strict();

export type SharedResourceReconciliation = z.infer<typeof sharedResourceReconciliationSchema>;

export const sharedResourceLeaseViewSchema = sharedResourceLeaseIdentitySchema.extend({
  leaseId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  state: z.enum(['reserved', 'running', 'unknown', 'released']),
  acquiredAt: unixSeconds,
  startedAt: unixSeconds.nullable(),
  settledAt: unixSeconds.nullable(),
  settlement: z.enum([
    'signed-terminal:succeeded',
    'signed-terminal:failed',
    'signed-terminal:no_effect',
    'signed-reconciliation:effects_verified',
    'signed-reconciliation:no_effect_verified',
  ]).nullable(),
  evidenceSha256: sha256.nullable(),
  settlementRecordSha256: sha256.nullable(),
  terminalEvidence: sharedResourceTerminalEvidenceSchema.nullable(),
  reconciliationDecisionId: identifier.nullable(),
  reconciliation: sharedResourceReconciliationSchema.nullable(),
}).strict();

export type SharedResourceLeaseView = z.infer<typeof sharedResourceLeaseViewSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value as object).sort()
    .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function sharedResourceTerminalSigningPayload(
  value: Omit<SharedResourceTerminalEvidence, 'signature'>,
): Buffer {
  return Buffer.from(canonical({ domain: 'magnus.shared-resource-terminal.v1', ...value }));
}

export function sharedResourceMissionSigningPayload(
  value: { reservation: SharedResourceReserveUnsigned; ownerActor: string;
    authority: Omit<z.infer<typeof sharedResourceMissionAssertionSchema>, 'signature'> },
): Buffer {
  return Buffer.from(canonical({ domain: 'magnus.shared-resource-mission.v1', ...value }));
}

export function sharedResourceReconciliationSigningPayload(
  value: Omit<SharedResourceReconciliation, 'signature'>,
): string {
  return canonical({ domain: 'magnus.shared-resource-reconciliation.v1', ...value });
}

export function sharedResourceSettlementRecordSha256(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
