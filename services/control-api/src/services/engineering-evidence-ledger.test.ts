import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { engineeringEvidenceReceiptSha256, loadEngineeringEvidenceLedger } from './engineering-evidence-ledger.js';

const d = (value: string) => value.repeat(64).slice(0, 64);
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

describe('engineering evidence ledger', () => {
  it('accepts only a safe ledger whose complete hash chain matches the configured head', () => {
    const directory = mkdtempSync(join(tmpdir(), 'magnus-evidence-')); directories.push(directory);
    const path = join(directory, 'ledger.json');
    const revision = 'a'.repeat(40);
    const record = {
      kind: 'delivery' as const, sequence: 1, previousReceiptSha256: null, receiptSha256: d('0'),
      recordedAt: '2026-09-20T12:00:00.000Z', requestId: 'task-1', applicationId: 'api',
      deploySource: 'repo:magnus',
      documentationOnly: true, establishedProductionWorkflow: false,
      source: { workingRevision: revision, mainRevision: revision, remoteRevision: revision, sourceTreeSha256: d('b') },
      tests: [{ name: 'unit', revision, status: 'passed' as const, evidenceSha256: d('1'), observedAt: '2026-09-20T11:55:00.000Z', source: 'ci' }],
      review: { revision, evidenceSha256: d('2'), observedAt: '2026-09-20T11:56:00.000Z', source: 'review' },
      ci: { revision, status: 'passed' as const, evidenceSha256: d('3'), observedAt: '2026-09-20T11:57:00.000Z', source: 'ci' },
      limitations: [],
    };
    record.receiptSha256 = engineeringEvidenceReceiptSha256(record);
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, records: [record] }), { mode: 0o600 });
    expect(loadEngineeringEvidenceLedger(path, record.receiptSha256)).toMatchObject({ headSha256: record.receiptSha256 });
    expect(() => loadEngineeringEvidenceLedger(path, d('f'))).toThrow(/head/i);
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, records: [{ ...record,
      documentationOnly: false, establishedProductionWorkflow: true }] }), { mode: 0o600 });
    expect(() => loadEngineeringEvidenceLedger(path, record.receiptSha256)).toThrow(/deployment receipt/i);
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, records: [{ ...record, requestId: 'tampered' }] }), { mode: 0o600 });
    expect(() => loadEngineeringEvidenceLedger(path, record.receiptSha256)).toThrow(/chain/i);
  });
});
