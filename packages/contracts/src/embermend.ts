import { z } from 'zod';

const id = z.string().min(1).max(200);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const embermendActionSchema = z.object({
  id, version: id, class: z.enum(['assess', 'prepare', 'repository-write', 'host-change', 'merge', 'build', 'artifact-publish', 'deploy', 'restart', 'reboot', 'exception', 'recovery']),
  targetId: id, targetKind: z.enum(['host', 'container', 'worker', 'repository']), requiredCapabilities: z.array(id),
  parameters: z.record(z.string(), z.json()), preconditions: z.record(z.string(), z.json()), dependsOn: z.array(id), verificationIds: z.array(id),
  recovery: z.string().max(4000), expectedRevision: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(), patchDigest: sha.nullable(), disruption: z.enum(['none', 'restart', 'reboot', 'outage']),
}).strict();
export const embermendOperationSchema = z.object({
  operationId: id, planId: id, planRevision: z.number().int().positive(), planDigest: sha, action: embermendActionSchema,
  installationId: id, authorizationRef: id, expiresAt: z.iso.datetime({ offset: true }),
}).strict();
export type EmbermendOperation = z.infer<typeof embermendOperationSchema>;
/** Explicit review of current effects settles ownership, never historical success. */
export const embermendSettlementSchema = z.object({
  originalOperationId: id, originalRequestDigest: sha, nativeCommandId: id, nativeRequestDigest: sha,
  evidenceId: id, evidenceDigest: sha,
  disposition: z.enum(['effects_verified', 'no_effect_verified']), originalOutcome: z.literal('unknown'),
}).strict();
export const embermendResultPointerSchema = z.object({ success: z.literal(true), data: z.object({ resultKey: sha, resultDigest: sha }).strict() }).strict();
export const embermendNativeResultSchema = z.object({ success: z.boolean(), data: z.record(z.string(), z.json()) }).strict();
export const embermendNodeCapabilitiesSchema = z.object({ success: z.literal(true), data: z.object({ protocol: z.literal(1), actions: z.array(id), platform: id, targetKind: z.enum(['host', 'worker', 'container']) }).strict() }).strict();
export function embermendCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') { const result = JSON.stringify(value); if (result === undefined) throw new Error('JSON value required'); return result; }
  if (Array.isArray(value)) return `[${value.map(embermendCanonical).join(',')}]`;
  const record = z.record(z.string(), z.unknown()).parse(value);
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${embermendCanonical(record[key])}`).join(',')}}`;
}
