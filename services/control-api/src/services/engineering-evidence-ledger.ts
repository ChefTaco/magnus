import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,159}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const isoDate = z.string().datetime({ offset: true });
const evidence = z.object({ evidenceSha256: digest, observedAt: isoDate, source: id }).strict();
const common = {
  sequence: z.number().int().positive(),
  previousReceiptSha256: digest.nullable(),
  receiptSha256: digest,
  recordedAt: isoDate,
};

export const deliveryEvidenceRecordSchema = z.object({
  ...common,
  kind: z.literal('delivery'),
  requestId: id,
  applicationId: id,
  deploySource: z.string().min(1).max(500),
  documentationOnly: z.boolean(),
  establishedProductionWorkflow: z.boolean(),
  source: z.object({ workingRevision: revision, mainRevision: revision, remoteRevision: revision,
    sourceTreeSha256: digest }).strict(),
  tests: z.array(z.object({ name: id, revision, status: z.literal('passed') }).merge(evidence)).min(1).max(100),
  review: evidence.extend({ revision }),
  ci: z.object({ revision, status: z.literal('passed') }).merge(evidence),
  deployment: z.object({ applicationId: id, deploySource: z.string().min(1).max(500), revision,
    sourceTreeSha256: digest, deployedAt: isoDate, evidenceSha256: digest, source: id }).strict().optional(),
  limitations: z.array(z.string().min(1).max(500)).max(50),
}).strict();

export const exerciseEvidenceRecordSchema = z.object({
  ...common,
  kind: z.literal('exercise'),
  exerciseId: id,
  environment: z.object({ isolated: z.literal(true), production: z.literal(false), targetId: id }).strict(),
  scenario: z.enum(['backup_restore', 'rollback', 'specialist_loss', 'coordinator_loss']),
  startedAt: isoDate,
  recoveredAt: isoDate,
  recoveryPointAt: isoDate,
  objectives: z.object({ rtoSeconds: z.number().int().positive(), rpoSeconds: z.number().int().nonnegative() }).strict(),
  before: z.object({ stateSha256: digest, taskReceiptsSha256: digest, artifactManifestSha256: digest }).strict(),
  after: z.object({ stateSha256: digest, taskReceiptsSha256: digest, artifactManifestSha256: digest }).strict(),
  directRecoveryEvidence: evidence,
}).strict();

export const engineeringEvidenceLedgerSchema = z.object({
  schemaVersion: z.literal(1),
  records: z.array(z.discriminatedUnion('kind', [deliveryEvidenceRecordSchema, exerciseEvidenceRecordSchema])).max(10_000),
}).strict().superRefine((value, ctx) => {
  value.records.forEach((record, index) => {
    if (record.kind === 'delivery' && record.establishedProductionWorkflow && !record.documentationOnly && !record.deployment)
      ctx.addIssue({ code: 'custom', message: 'Established production workflow requires an application-bound deployment receipt',
        path: ['records', index, 'deployment'] });
  });
});

export type DeliveryEvidenceRecord = z.infer<typeof deliveryEvidenceRecordSchema>;
export type ExerciseEvidenceRecord = z.infer<typeof exerciseEvidenceRecordSchema>;
export type EngineeringEvidenceLedger = z.infer<typeof engineeringEvidenceLedgerSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`).join(',')}}`;
  return JSON.stringify(value);
}
function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }

export function engineeringEvidenceReceiptSha256(record: DeliveryEvidenceRecord | ExerciseEvidenceRecord): string {
  const { receiptSha256: _receiptSha256, ...payload } = record;
  return hash(payload);
}

export function loadEngineeringEvidenceLedger(
  path = process.env['MAGNUS_ENGINEERING_EVIDENCE_FILE'],
  expectedHeadSha256 = process.env['MAGNUS_ENGINEERING_EVIDENCE_HEAD_SHA256'],
): EngineeringEvidenceLedger & { ledgerSha256: string; headSha256: string | null } {
  if (!path) throw new Error('MAGNUS_ENGINEERING_EVIDENCE_FILE is not configured');
  if (!expectedHeadSha256 || !digest.safeParse(expectedHeadSha256).success)
    throw new Error('MAGNUS_ENGINEERING_EVIDENCE_HEAD_SHA256 must pin the current ledger head');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000 || (stat.mode & 0o022))
    throw new Error('Unsafe engineering evidence ledger');
  const parsed = engineeringEvidenceLedgerSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  let previous: string | null = null;
  const unique = new Set<string>();
  parsed.records.forEach((record, index) => {
    if (record.sequence !== index + 1 || record.previousReceiptSha256 !== previous
      || engineeringEvidenceReceiptSha256(record) !== record.receiptSha256)
      throw new Error(`Invalid engineering evidence chain at sequence ${index + 1}`);
    const key = record.kind === 'delivery' ? `delivery:${record.requestId}` : `exercise:${record.exerciseId}`;
    if (unique.has(key)) throw new Error(`Duplicate engineering evidence record ${key}`);
    unique.add(key);
    previous = record.receiptSha256;
  });
  if (previous !== expectedHeadSha256) throw new Error('Engineering evidence ledger head does not match configured pin');
  return { ...parsed, ledgerSha256: hash(parsed), headSha256: previous };
}
