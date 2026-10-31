import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updates: Array<Record<string, unknown>> = [];
let evidenceRows: Array<Record<string, unknown>> = [];
const db = {
  securityFusionEvidence: {
    findMany: vi.fn(async () => evidenceRows),
    update: vi.fn(async (query: Record<string, unknown>) => {
      updates.push(query);
      return query;
    }),
  },
};
vi.mock('../db/index.js', () => ({ getDb: () => db }));

const { reconcileSecurityFusionEvidence } = await import('./security-fusion-evidence-integrity.js');

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'fusion-evidence-'));
  process.env['SECURITY_FUSION_EVIDENCE_DIR'] = directory;
  evidenceRows = [];
  updates.length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env['SECURITY_FUSION_EVIDENCE_DIR'];
  rmSync(directory, { recursive: true, force: true });
});

describe('Security Fusion evidence reconciliation', () => {
  it('backfills actual sizes only after validating the retained hash', async () => {
    const path = join(directory, 'aa', 'artifact.json');
    mkdirSync(join(directory, 'aa'));
    writeFileSync(path, 'retained-evidence', { mode: 0o600 });
    evidenceRows = [{
      id: 'evidence-1',
      caseId: 'case-1',
      sha256: createHash('sha256').update('retained-evidence').digest('hex'),
      storagePath: path,
      byteSize: 0,
      integrityStatus: 'pending',
    }];
    await expect(reconcileSecurityFusionEvidence()).resolves.toEqual({
      checked: 1,
      updated: 1,
      quarantined: 0,
      mismatchedCases: 1,
    });
    expect(updates[0]).toMatchObject({
      data: { byteSize: 17, integrityStatus: 'verified', quarantinedAt: null },
    });
  });

  it('quarantines missing and hash-mismatched retained artifacts', async () => {
    const mismatchedPath = join(directory, 'bb', 'mismatched.json');
    mkdirSync(join(directory, 'bb'));
    writeFileSync(mismatchedPath, 'tampered', { mode: 0o600 });
    evidenceRows = [
      {
        id: 'missing',
        caseId: 'case-1',
        sha256: 'a'.repeat(64),
        storagePath: join(directory, 'aa', 'missing.json'),
        byteSize: 99,
        integrityStatus: 'pending',
      },
      {
        id: 'mismatched',
        caseId: 'case-2',
        sha256: 'b'.repeat(64),
        storagePath: mismatchedPath,
        byteSize: 0,
        integrityStatus: 'pending',
      },
    ];
    await expect(reconcileSecurityFusionEvidence()).resolves.toEqual({
      checked: 2,
      updated: 0,
      quarantined: 2,
      mismatchedCases: 2,
    });
    expect(updates.map((update) => (update['data'] as Record<string, unknown>)['integrityStatus']))
      .toEqual(['quarantined_missing', 'quarantined_hash_mismatch']);
    expect(updates[1]).toMatchObject({
      data: { byteSize: 8, quarantineReason: expect.stringContaining('hash') },
    });
  });
});
