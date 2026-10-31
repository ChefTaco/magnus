/** Exact node scheduler wire schema; cross-package tests guard canonical digest parity. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
export const managedCronSchema = z.object({
  nodeFqdn: z.string().min(1).max(253),
  name: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  revision: z.number().int().positive().max(2147483647),
  schedule: z.string().min(9).max(64),
  timezone: z.literal('UTC'),
  workingDirectory: z.string().max(4096).startsWith('/').optional(),
  environment: z.record(z.string(), z.string().max(4096)).default({}),
  command: z.string().min(1).max(16384).regex(/^[^\n\r\x00]+$/),
  args: z.array(z.string().max(4096).regex(/^[^\x00]*$/)).max(64).default([]),
  timeoutSeconds: z.number().int().min(1).max(3600),
  expiresAt: z.number().int().positive().max(8_640_000_000_000_000),
}).strict().superRefine((value, ctx) => {
  try { scheduleFields(value.schedule); } catch { ctx.addIssue({ code: 'custom', message: 'Unsupported numeric five-field cron schedule' }); }
});
export type ManagedCronSpec = z.infer<typeof managedCronSchema>;

export const cronEnrollmentStageSchema = z.object({
  version: z.literal(1), nodeId: z.string().min(1).max(128), nodeFqdn: z.string().min(1).max(253),
  spec: managedCronSchema, operationId: z.string().guid(), expiresAt: z.number().int().positive(),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type CronEnrollmentStage = z.infer<typeof cronEnrollmentStageSchema>;
export function cronEnrollmentStageSigningPayload(value: Omit<CronEnrollmentStage, 'signature'>): string {
  return JSON.stringify({ domain: 'magnus.cron-enrollment-stage.v1', version: value.version, nodeId: value.nodeId,
    nodeFqdn: value.nodeFqdn, specSha256: createHash('sha256').update(JSON.stringify(value.spec)).digest('hex'),
    operationId: value.operationId, expiresAt: value.expiresAt });
}
export const managedCronRegistrationSchema = z.object({
  revision: z.number().int().positive().max(2147483647),
  timezone: z.literal('UTC'),
  timeoutSeconds: z.number().int().min(1).max(3600),
  expiresAt: z.number().int().positive().max(8_640_000_000_000_000),
}).strict();
export type ManagedCronRegistration = z.infer<typeof managedCronRegistrationSchema>;

export const managedCronIdentitySchema = z.object({
  nodeFqdn: z.string().min(1).max(253),
  name: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  jobId: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().positive().max(2147483647),
  specSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ManagedCronIdentity = z.infer<typeof managedCronIdentitySchema>;
export const cronEnrollmentStageReceiptSchema = managedCronIdentitySchema.extend({
  operationId: z.string().guid(), staged: z.literal(true), enabled: z.literal(false),
  receiptSignature: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export function cronEnrollmentStageReceiptPayload(value: Omit<z.infer<typeof cronEnrollmentStageReceiptSchema>, 'receiptSignature'>): string {
  return JSON.stringify({ domain: 'magnus.cron-enrollment-stage-receipt.v1', ...value });
}

export const managedCronStageAckSchema = managedCronIdentitySchema.extend({
  staged: z.literal(true), enabled: z.literal(false),
}).strict();
export const managedCronActivationAckSchema = managedCronIdentitySchema.extend({
  activated: z.literal(true), enabled: z.literal(true),
}).strict();
export const managedCronRevocationAckSchema = managedCronIdentitySchema.extend({
  revoked: z.literal(true), enabled: z.literal(false),
}).strict();

export const schedulerSourceSettlementSchema = z.object({
  version: z.literal(1),
  sourceIdentityVersion: z.literal(2),
  nodeId: z.string().min(1).max(128),
  nodeFqdn: z.string().min(1).max(253),
  epoch: z.number().int().positive(),
  barrierId: z.string().guid(),
  kind: z.string().regex(/^[A-Z_]{1,80}$/),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  count: z.number().int().positive().max(1_000_000),
  disposition: z.enum(['effects_verified', 'no_effect_verified']),
  evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  approvalRef: z.string().min(1).max(512),
  decisionId: z.string().guid(),
  expiresAt: z.number().int().positive(),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type SchedulerSourceSettlement = z.infer<typeof schedulerSourceSettlementSchema>;
export const schedulerSourceSettlementAckSchema = schedulerSourceSettlementSchema.omit({ signature: true }).extend({
  settled: z.literal(true), replayed: z.boolean(), receiptSignature: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export function schedulerSourceSettlementSigningPayload(value: Omit<SchedulerSourceSettlement, 'signature'>): string {
  return JSON.stringify({ domain: 'magnus.scheduler-source-reconciliation.v2', version: value.version,
    sourceIdentityVersion: value.sourceIdentityVersion,
    nodeId: value.nodeId, nodeFqdn: value.nodeFqdn, epoch: value.epoch, barrierId: value.barrierId,
    kind: value.kind, sourceSha256: value.sourceSha256, count: value.count, disposition: value.disposition,
    evidenceSha256: value.evidenceSha256, approvalRef: value.approvalRef, decisionId: value.decisionId,
    expiresAt: value.expiresAt });
}
export function schedulerSourceSettlementReceiptPayload(value: Omit<z.infer<typeof schedulerSourceSettlementAckSchema>, 'receiptSignature'>): string {
  return JSON.stringify({ domain: 'magnus.scheduler-source-reconciliation-receipt.v2', ...value });
}

function scheduleFields(schedule: string): Array<Set<number>> {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Five cron fields required');
  return fields.map((field, index) => {
    const lower = [0, 0, 1, 1, 0][index]!; const upper = [59, 23, 31, 12, 7][index]!;
    const values = new Set<number>();
    for (const part of field.split(',')) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
      if (!match || (match[2] && match[1] !== '*' && !match[1]!.includes('-'))) throw new Error('Unsupported cron field');
      const step = Number(match[2] ?? 1);
      const range = match[1] === '*' ? [lower, upper] : match[1]!.split('-').map(Number);
      const start = range[0]!; const end = range[1] ?? start;
      if (!Number.isInteger(step) || step < 1 || step > upper + 1 || start < lower || end > upper || start > end) throw new Error('Cron field out of range');
      for (let value = start; value <= end; value += step) values.add(index === 4 && value === 7 ? 0 : value);
    }
    return values;
  });
}
export function cronDue(schedule: string, at: number): boolean {
  const fields = scheduleFields(schedule); const date = new Date(at);
  const parts = schedule.trim().split(/\s+/);
  const dom = fields[2]!.has(date.getUTCDate()); const dow = fields[4]!.has(date.getUTCDay());
  const day = parts[2]!.startsWith('*') || parts[4]!.startsWith('*') ? dom && dow : dom || dow;
  return fields[0]!.has(date.getUTCMinutes()) && fields[1]!.has(date.getUTCHours()) && fields[3]!.has(date.getUTCMonth() + 1) && day;
}
