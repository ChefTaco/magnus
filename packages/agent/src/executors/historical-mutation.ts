/** Root-operated historical process quiescence. Never a completion receipt. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const historicalDrainSchema = z.object({ nodeId: z.string().min(1).max(128),
  nodeFqdn: z.string().min(1).max(253), epoch: z.number().int().positive(), barrierId: z.string().guid() }).strict();
export const bootSchema = z.object({ id: z.string().guid(), startedAt: z.number().int().positive() }).strict();
const record = z.object({ id: z.string().guid(), recordSha256: sha, acceptedAt: z.number().int().nonnegative(),
  routeSha256: sha }).strict();
const observationUnsigned = z.object({ version: z.literal(1), drain: historicalDrainSchema,
  boot: bootSchema, observedAt: z.number().int().positive(), records: z.array(record).min(1).max(16) }).strict();
export const historicalObservationSchema = observationUnsigned.extend({ signature: sha }).strict();
const assertionUnsigned = z.object({ version: z.literal(1), before: historicalObservationSchema,
  boot: bootSchema, records: z.array(record).min(1).max(16),
  disposition: z.literal('post_boot_quiescence_outcome_unknown'),
  approvalRef: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,199}$/),
  decisionId: z.string().guid(), expiresAt: z.number().int().positive() }).strict();
export const historicalAssertionSchema = assertionUnsigned.extend({ signature: sha }).strict();
const receiptUnsigned = z.object({ version: z.literal(1), assertion: historicalAssertionSchema,
  boot: bootSchema, recordedAt: z.number().int().positive(), replayPermitted: z.literal(false),
  originalOutcome: z.literal('unknown') }).strict();
export const historicalReceiptSchema = receiptUnsigned.extend({ signature: sha }).strict();
export type HistoricalObservation = z.infer<typeof historicalObservationSchema>;
export type HistoricalAssertion = z.infer<typeof historicalAssertionSchema>;
export type HistoricalReceipt = z.infer<typeof historicalReceiptSchema>;
export type HostBoot = z.infer<typeof bootSchema>;
export interface HistoricalKeys { result: string; reconciliation: string }
export type ReviewedHistoricalRecords = Readonly<Record<string, { nodeFqdn: string; recordSha256: string }>>;
/** Records an operator has independently inspected and approved for historical
 * settlement. Empty by default: each entry needs its own reviewed source change. */
export const reviewedHistoricalRecords: ReviewedHistoricalRecords = Object.freeze({});
export const historicalHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function validateHistoricalKeys(keys: HistoricalKeys): void {
  if (keys.result.length < 32 || keys.reconciliation.length < 32 || keys.result === keys.reconciliation)
    throw new Error('Independent owner result and reconciliation keys required');
}
function mac(domain: string, value: unknown, key: string): string {
  if (key.length < 32) throw new Error('Historical signing key unavailable');
  return createHmac('sha256', key).update(domain + '\n' + JSON.stringify(value)).digest('hex');
}
function verify(domain: string, value: unknown, signature: string, key: string): void {
  if (!sha.safeParse(signature).success || !timingSafeEqual(Buffer.from(mac(domain, value, key), 'hex'), Buffer.from(signature, 'hex')))
    throw new Error('Historical signature differs');
}
export function signHistoricalObservation(raw: z.input<typeof observationUnsigned>, key: string): HistoricalObservation {
  const value = observationUnsigned.parse(raw);
  return { ...value, signature: mac('magnus.historical-mutation-observation.v1', value, key) };
}
export function signHistoricalAssertion(raw: z.input<typeof assertionUnsigned>, key: string): HistoricalAssertion {
  const value = assertionUnsigned.parse(raw);
  return { ...value, signature: mac('magnus.historical-mutation-decision.v1', value, key) };
}
export function signHistoricalReceipt(raw: z.input<typeof receiptUnsigned>, key: string): HistoricalReceipt {
  const value = receiptUnsigned.parse(raw);
  return { ...value, signature: mac('magnus.historical-mutation-receipt.v1', value, key) };
}
export function verifyHistoricalObservation(raw: unknown, key: string): HistoricalObservation {
  const value = historicalObservationSchema.parse(raw);
  const { signature, ...unsigned } = value;
  verify('magnus.historical-mutation-observation.v1', unsigned, signature, key);
  if (new Set(value.records.map(r => r.id)).size !== value.records.length || value.boot.startedAt > value.observedAt)
    throw new Error('Historical observation identity differs');
  return value;
}
export function verifyHistoricalAssertion(raw: unknown, keys: HistoricalKeys): HistoricalAssertion {
  validateHistoricalKeys(keys);
  const value = historicalAssertionSchema.parse(raw);
  const { signature, ...unsigned } = value;
  verify('magnus.historical-mutation-decision.v1', unsigned, signature, keys.reconciliation);
  const before = verifyHistoricalObservation(value.before, keys.result);
  if (value.boot.id === before.boot.id || value.boot.startedAt <= before.observedAt ||
      new Set(value.records.map(r => r.id)).size !== value.records.length ||
      value.records.some(r => !before.records.some(prior => historicalHash(prior) === historicalHash(r)) || r.acceptedAt >= value.boot.startedAt))
    throw new Error('Post-effect whole-host boot proof required');
  return value;
}
export function verifyHistoricalReceipt(raw: unknown, keys: HistoricalKeys): HistoricalReceipt {
  const value = historicalReceiptSchema.parse(raw);
  const { signature, ...unsigned } = value;
  verify('magnus.historical-mutation-receipt.v1', unsigned, signature, keys.result);
  const assertion = verifyHistoricalAssertion(value.assertion, keys);
  if (historicalHash(value.boot) !== historicalHash(assertion.boot) || value.recordedAt >= assertion.expiresAt ||
      assertion.expiresAt > value.recordedAt + 300_000 || value.recordedAt < value.boot.startedAt)
    throw new Error('Historical receipt timing differs');
  return value; // Accepted receipts remain durable after the decision's expiry.
}
export async function readHostBoot(): Promise<HostBoot> {
  const id = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const stat = await readFile('/proc/stat', 'utf8');
  const startedAt = Number(/^btime (\d+)$/m.exec(stat)?.[1]) * 1000;
  return bootSchema.parse({ id, startedAt });
}
