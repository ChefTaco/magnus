/** Versioned native HTTP identity. Hashes bind request bytes; bodies stay off receipts. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { commandFenceSchema } from '../schemas/node-responses.js';
export const managedClaimSchema = z.object({
  leaseId: z.string().min(1).max(128), nodeId: z.string().min(1).max(128),
  nodeFqdn: z.string().min(1).max(253),
}).strict();
export type ManagedClaim = z.infer<typeof managedClaimSchema>;
export const managedHttpRequestSchema = z.object({
  claim: managedClaimSchema,
  commandId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().min(1).max(300),
  body: z.string().max(4 * 1024 * 1024),
  timeoutSeconds: z.number().int().min(1).max(3600),
  coordination: commandFenceSchema,
  recoveryOnly: z.literal(true).optional(),
}).strict().superRefine((value, context) => {
  if (value.recoveryOnly && (value.method !== 'POST' || value.path !== '/skills/install'))
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['recoveryOnly'],
      message: 'Recovery-only execution is limited to atomic skill publication' });
});
export type ManagedHttpRequest = z.infer<typeof managedHttpRequestSchema>;
export const MANAGED_HTTP_COMMAND = '@magnus/native-http/v1';
export const MANAGED_CLAIM_HEADER = 'x-magnus-resource-claim';
export function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function httpIdentity(commandId: string, method: string, path: string, body: string, timeoutSeconds: number) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || !/^\/[a-zA-Z0-9/_%.:-]+$/.test(path)
    || path.includes('..') || path.includes('//')) throw new Error('Canonical native mutation path required');
  return { commandId, command: MANAGED_HTTP_COMMAND, args: [method, path, sha256(body)], timeoutSeconds };
}
export function httpReceiptBody(method: string, path: string, status: number, body: string): string {
  return JSON.stringify({ version: 1, method, path, status, responseSha256: sha256(body) });
}

export const resourceClaimSchema = managedClaimSchema.extend({
  commandId: z.string().min(1).max(128), requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  coordination: commandFenceSchema,
}).strict();

export const legacyAdmissionRequestSchema = z.object({
  nodeFqdn: z.string().min(1).max(253), nonce: z.string().guid(),
}).strict();
export const legacyAdmissionResponseSchema = legacyAdmissionRequestSchema.extend({
  nodeId: z.string().min(1).max(128), enrolled: z.boolean(), gateEnabled: z.boolean(), allowedLegacy: z.boolean(),
}).strict();
