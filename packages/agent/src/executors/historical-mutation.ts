import { optional } from '../utils/optional.js';
/** Root-operated historical process quiescence. Never a completion receipt. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { reconciliationSigningKey, reconciliationVerificationKeys, resultSigningKey, resultVerificationKeys } from '../security/local-evidence-keys.js';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { HOST_FQDN } from '../env.js';
import { logger } from '../utils/logger.js';
import { loadReviewedHistoricalRecords, type ReviewedHistoricalRecords } from './reviewed-historical-records.js';

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
/**
 * `result` and `reconciliation` sign; a record also verifies with an older key it may have been
 * signed with (`previousResult`, `previousReconciliation`: the shared keys of 2.10.x, see
 * security/local-evidence-keys.ts), so records written before the upgrade stay readable.
 */
export interface HistoricalKeys { result: string; reconciliation: string; previousResult?: readonly string[]; previousReconciliation?: readonly string[] }
export type { ReviewedHistoricalRecords };
/** Records an operator has independently inspected and approved for historical
 * settlement, from the root-controlled MAGNUS_AGENT_REVIEWED_HISTORICAL_RECORDS
 * file, read once at startup. Empty when the file is absent or refused. */
export const reviewedHistoricalRecordsLoad = loadReviewedHistoricalRecords({ ...optional("path", process.env['MAGNUS_AGENT_REVIEWED_HISTORICAL_RECORDS']?.trim() || undefined), hostname: HOST_FQDN });
if (reviewedHistoricalRecordsLoad.problem) {
  logger.warn(`Reviewed historical records refused; historical settlements are not honoured: ${reviewedHistoricalRecordsLoad.problem}`);
} else if (reviewedHistoricalRecordsLoad.count > 0) {
  logger.info(`Loaded ${reviewedHistoricalRecordsLoad.count} reviewed historical record(s) for ${HOST_FQDN} from ${reviewedHistoricalRecordsLoad.path}`);
}
export const reviewedHistoricalRecords: ReviewedHistoricalRecords = reviewedHistoricalRecordsLoad.records;
export const historicalHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * This host's historical keys (security/local-evidence-keys.ts): the shared keys when configured,
 * else node-local ones, with every key an older record may carry.
 */
export function hostHistoricalKeys(): HistoricalKeys {
  const result = resultSigningKey(); const reconciliation = reconciliationSigningKey();
  return { result, reconciliation, previousResult: resultVerificationKeys().filter(key => key !== result),
    previousReconciliation: reconciliationVerificationKeys().filter(key => key !== reconciliation) };
}

export function validateHistoricalKeys(keys: HistoricalKeys): void {
  if (keys.result.length < 32 || keys.reconciliation.length < 32 || keys.result === keys.reconciliation)
    throw new Error('Independent owner result and reconciliation keys required');
}
function mac(domain: string, value: unknown, key: string): string {
  if (key.length < 32) throw new Error('Historical signing key unavailable');
  return createHmac('sha256', key).update(domain + '\n' + JSON.stringify(value)).digest('hex');
}
function verify(domain: string, value: unknown, signature: string, key: string, previous: readonly string[] = []): void {
  const keys = [key, ...previous].filter(candidate => candidate.length >= 32);
  if (!sha.safeParse(signature).success || keys.length === 0
    || !keys.some(candidate => timingSafeEqual(Buffer.from(mac(domain, value, candidate), 'hex'), Buffer.from(signature, 'hex'))))
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
export function verifyHistoricalObservation(raw: unknown, key: string, previous: readonly string[] = []): HistoricalObservation {
  const value = historicalObservationSchema.parse(raw);
  const { signature, ...unsigned } = value;
  verify('magnus.historical-mutation-observation.v1', unsigned, signature, key, previous);
  if (new Set(value.records.map(r => r.id)).size !== value.records.length || value.boot.startedAt > value.observedAt)
    throw new Error('Historical observation identity differs');
  return value;
}
export function verifyHistoricalAssertion(raw: unknown, keys: HistoricalKeys): HistoricalAssertion {
  validateHistoricalKeys(keys);
  const value = historicalAssertionSchema.parse(raw);
  const { signature, ...unsigned } = value;
  verify('magnus.historical-mutation-decision.v1', unsigned, signature, keys.reconciliation, keys.previousReconciliation);
  const before = verifyHistoricalObservation(value.before, keys.result, keys.previousResult);
  if (value.boot.id === before.boot.id || value.boot.startedAt <= before.observedAt ||
      new Set(value.records.map(r => r.id)).size !== value.records.length ||
      value.records.some(r => !before.records.some(prior => historicalHash(prior) === historicalHash(r)) || r.acceptedAt >= value.boot.startedAt))
    throw new Error('Post-effect whole-host boot proof required');
  return value;
}
export function verifyHistoricalReceipt(raw: unknown, keys: HistoricalKeys): HistoricalReceipt {
  const value = historicalReceiptSchema.parse(raw);
  const { signature, ...unsigned } = value;
  verify('magnus.historical-mutation-receipt.v1', unsigned, signature, keys.result, keys.previousResult);
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
