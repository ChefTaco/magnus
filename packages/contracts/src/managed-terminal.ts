import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const managedTerminalAuthoritySchema = z.object({
  workId: z.string().guid(), ownerId: z.string().guid(), nodeId: z.string().min(1).max(128),
  nodeFqdn: z.string().min(1).max(253), epoch: z.number().int().positive(), barrierId: z.string().guid(),
  operationSha256: digest, requestSha256: digest, fence: z.string().regex(/^[1-9][0-9]{0,19}$/),
  deadline: z.number().int().positive(),
}).strict();
export type ManagedTerminalAuthority = z.infer<typeof managedTerminalAuthoritySchema>;

/** Admission identity only. Terminal input and output must never enter an authority or receipt. */
export function managedTerminalOperation(value: { workId: string; ownerId: string; host: string }): string {
  return JSON.stringify({ domain: 'magnus.managed-terminal-operation.v1', workId: value.workId,
    ownerId: value.ownerId, host: value.host.toLowerCase(), kind: 'terminal-http' });
}
export const managedTerminalSizeSchema = z.object({ cols: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(200) }).strict();
export type ManagedTerminalSize = z.infer<typeof managedTerminalSizeSchema>;
export const managedTerminalActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('open'), size: managedTerminalSizeSchema }).strict(),
  z.object({ action: z.literal('read') }).strict(),
  z.object({ action: z.literal('input'), data: z.string().max(32 * 1024) }).strict(),
  z.object({ action: z.literal('resize'), size: managedTerminalSizeSchema }).strict(),
  z.object({ action: z.literal('close') }).strict(),
]);
export type ManagedTerminalAction = z.infer<typeof managedTerminalActionSchema>;

/** Proves the restricted terminal's process lifetime ended, never reversal of its side effects. */
export const managedTerminalReceiptSchema = managedTerminalAuthoritySchema.extend({
  version: z.literal(1), boundary: z.literal('restricted-terminal-process-v1'),
  bootId: z.string().guid(), unit: z.string().regex(/^magnus-terminal-[a-f0-9]{64}\.service$/),
  invocationId: z.string().regex(/^[a-f0-9]{32}$/),
  cgroup: z.string().regex(/^\/system\.slice\/magnus-terminal-[a-f0-9]{64}\.service$/),
  startedAt: z.number().int().positive(), terminalAt: z.number().int().positive(),
  groupEmpty: z.literal(true), signature: digest,
}).strict().refine(value => value.cgroup.endsWith('/' + value.unit)
  && value.startedAt <= value.deadline && value.startedAt <= value.terminalAt);
export type ManagedTerminalReceipt = z.infer<typeof managedTerminalReceiptSchema>;
export function managedTerminalReceiptPayload(value: Omit<ManagedTerminalReceipt, 'signature'>): string {
  // Fixed order regardless of the JSON transport's property order.
  const authority = managedTerminalAuthoritySchema.parse(Object.fromEntries(
    Object.keys(managedTerminalAuthoritySchema.shape).map(key => [key, value[key as keyof typeof value]])));
  return JSON.stringify({ domain: 'magnus.managed-terminal-completion.v1', ...authority, version: value.version,
    boundary: value.boundary, bootId: value.bootId, unit: value.unit, invocationId: value.invocationId,
    cgroup: value.cgroup, startedAt: value.startedAt, terminalAt: value.terminalAt, groupEmpty: value.groupEmpty });
}
