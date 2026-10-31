import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, rename } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { getDb } from '../db/index.js';
import { setMetricGauge } from '../routes/metrics.js';

type EvidenceRow = {
  id: string;
  caseId: string;
  sha256: string;
  storagePath: string;
  byteSize: number;
  integrityStatus: string;
};

function evidenceBase(): string {
  return resolve(process.env['SECURITY_FUSION_EVIDENCE_DIR'] ?? './state/security-fusion/evidence');
}

function pathInside(base: string, candidate: string): boolean {
  const rel = relative(base, resolve(candidate));
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

export async function ensurePrivateEvidenceDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  const expectedUid = typeof process.geteuid === 'function' ? process.geteuid() : info.uid;
  if (!info.isDirectory() || info.isSymbolicLink()
    || info.uid !== expectedUid || (info.mode & 0o077) !== 0) {
    throw new Error(`Security Fusion evidence directory is unsafe: ${path}`);
  }
}

async function quarantineEvidence(
  row: EvidenceRow,
  status: string,
  reason: string,
  actualBytes: number,
): Promise<void> {
  const base = evidenceBase();
  let storagePath = row.storagePath;
  if (status === 'quarantined_hash_mismatch' && pathInside(base, row.storagePath)) {
    const quarantineDir = join(base, 'quarantine');
    await ensurePrivateEvidenceDirectory(quarantineDir);
    const target = join(quarantineDir, `${row.id}.${basename(row.storagePath)}`);
    await rename(row.storagePath, target);
    storagePath = target;
  }
  await getDb().securityFusionEvidence.update({
    where: { id: row.id },
    data: {
      byteSize: actualBytes,
      integrityStatus: status,
      quarantinedAt: new Date(),
      quarantineReason: reason,
      storagePath,
    },
  });
}

/**
 * Reconcile every retained artifact before byte admission and retention start.
 * Missing, unsafe, non-regular, and hash-mismatched evidence remains recorded
 * but is quarantined from normal evidence use.
 */
export async function reconcileSecurityFusionEvidence(): Promise<{
  checked: number;
  updated: number;
  quarantined: number;
  mismatchedCases: number;
}> {
  const base = evidenceBase();
  await ensurePrivateEvidenceDirectory(base);
  const mismatchedCases = new Set<string>();
  let checked = 0;
  let updated = 0;
  let quarantined = 0;
  let cursor: string | undefined;
  while (true) {
    const rows = await getDb().securityFusionEvidence.findMany({
      select: {
        id: true,
        caseId: true,
        sha256: true,
        storagePath: true,
        byteSize: true,
        integrityStatus: true,
      },
      orderBy: { id: 'asc' },
      take: 250,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const row of rows) {
      checked += 1;
      if (row.integrityStatus.startsWith('quarantined_')) {
        mismatchedCases.add(row.caseId);
        quarantined += 1;
        continue;
      }
      if (!pathInside(base, row.storagePath)) {
        mismatchedCases.add(row.caseId);
        quarantined += 1;
        await quarantineEvidence(row, 'quarantined_unsafe_path', 'storage path is outside the evidence root', row.byteSize);
        continue;
      }
      let info;
      try {
        info = await lstat(row.storagePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        mismatchedCases.add(row.caseId);
        quarantined += 1;
        await quarantineEvidence(row, 'quarantined_missing', 'retained evidence file is missing', 0);
        continue;
      }
      if (!info.isFile() || info.isSymbolicLink()) {
        mismatchedCases.add(row.caseId);
        quarantined += 1;
        await quarantineEvidence(row, 'quarantined_unsafe_file', 'retained evidence is not a regular file', row.byteSize);
        continue;
      }
      const actualBytes = info.size;
      const actualSha256 = await hashFile(row.storagePath);
      if (actualBytes !== row.byteSize) mismatchedCases.add(row.caseId);
      if (actualSha256 !== row.sha256) {
        mismatchedCases.add(row.caseId);
        quarantined += 1;
        await quarantineEvidence(row, 'quarantined_hash_mismatch', 'retained evidence hash does not match its manifest', actualBytes);
        continue;
      }
      if (actualBytes !== row.byteSize) updated += 1;
      await getDb().securityFusionEvidence.update({
        where: { id: row.id },
        data: {
          byteSize: actualBytes,
          integrityStatus: 'verified',
          quarantinedAt: null,
          quarantineReason: null,
        },
      });
    }
    if (rows.length < 250) break;
    cursor = rows.at(-1)?.id;
    if (!cursor) break;
  }

  setMetricGauge('securityFusionEvidenceReconciliationMismatchedCases', mismatchedCases.size);
  setMetricGauge('securityFusionEvidenceQuarantinedArtifacts', quarantined);
  return { checked, updated, quarantined, mismatchedCases: mismatchedCases.size };
}
