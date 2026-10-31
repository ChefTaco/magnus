import { createHmac, createHash } from 'node:crypto';
import { appendFile, chmod, lstat, mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Prisma } from '../db/index.js';
import { getDb } from '../db/index.js';

export type DeletionReceiptInput = {
  resourceType: string;
  resourceIdHash: string;
  reason: string;
  outcome: string;
  bytesDeleted: number;
  detailJson: string;
  deletedAt: Date;
};

type ChainHead = {
  headSha256: string | null;
  chainSequence: number;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function deletionReceiptHash(
  input: DeletionReceiptInput,
  previousReceiptSha256: string | null,
  chainSequence: number,
): string {
  return createHash('sha256').update(canonicalJson({
    resourceType: input.resourceType,
    resourceIdHash: input.resourceIdHash,
    reason: input.reason,
    outcome: input.outcome,
    bytesDeleted: input.bytesDeleted,
    detail: JSON.parse(input.detailJson) as unknown,
    deletedAt: input.deletedAt.toISOString(),
    previousReceiptSha256,
    chainSequence,
    chainVersion: 2,
  })).digest('hex');
}

/**
 * Append receipts while holding the singleton PostgreSQL chain-head row lock.
 * This serializes all writers across Control API processes.
 */
export async function appendDeletionReceipts(
  tx: Prisma.TransactionClient,
  inputs: DeletionReceiptInput[],
): Promise<ChainHead> {
  const [head] = await tx.$queryRaw<Array<ChainHead>>`
    SELECT "headSha256", "chainSequence"
    FROM "security_fusion_receipt_chain_heads"
    WHERE "id" = 'security-fusion'
    FOR UPDATE
  `;
  if (!head) throw new Error('Security Fusion receipt chain head is missing');

  let previousReceiptSha256 = head.headSha256;
  let chainSequence = head.chainSequence;
  for (const input of inputs) {
    chainSequence += 1;
    const receiptSha256 = deletionReceiptHash(input, previousReceiptSha256, chainSequence);
    await tx.securityFusionDeletionReceipt.create({
      data: {
        ...input,
        receiptSha256,
        previousReceiptSha256,
        chainSequence,
        chainVersion: 2,
      },
    });
    previousReceiptSha256 = receiptSha256;
  }
  if (inputs.length > 0) {
    await tx.securityFusionReceiptChainHead.update({
      where: { id: 'security-fusion' },
      data: { headSha256: previousReceiptSha256, chainSequence },
    });
  }
  return { headSha256: previousReceiptSha256, chainSequence };
}

function chainHeadExportPath(): string {
  return resolve(
    process.env['SECURITY_FUSION_RECEIPT_CHAIN_EXPORT']
      ?? './state/security-fusion/receipt-chain-heads.jsonl',
  );
}

/** Durably export the current chain head outside the mutable database. */
export async function exportReceiptChainHead(head?: ChainHead): Promise<void> {
  const current = head ?? await getDb().securityFusionReceiptChainHead.findUnique({
    where: { id: 'security-fusion' },
    select: { headSha256: true, chainSequence: true },
  });
  if (!current) throw new Error('Security Fusion receipt chain head is missing');
  const path = chainHeadExportPath();
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const expectedUid = typeof process.geteuid === 'function' ? process.geteuid() : null;
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
    || (expectedUid !== null && directoryInfo.uid !== expectedUid)) {
    throw new Error('Security Fusion receipt chain export directory is unsafe');
  }
  await chmod(directory, 0o700);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()
      || (expectedUid !== null && info.uid !== expectedUid)
      || (info.mode & 0o777) !== 0o600) {
      throw new Error('Security Fusion receipt chain export must be a mode-0600 regular file');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const exportedAt = new Date().toISOString();
  const signingKey = process.env['SECURITY_FUSION_RECEIPT_SIGNING_KEY'];
  if (!signingKey || signingKey.length < 32) {
    throw new Error('SECURITY_FUSION_RECEIPT_SIGNING_KEY must contain at least 32 characters');
  }
  const signedPayload = canonicalJson({
    chain: 'security-fusion',
    chainSequence: current.chainSequence,
    headSha256: current.headSha256,
    exportedAt,
  });
  const record = {
    chain: 'security-fusion',
    chainSequence: current.chainSequence,
    headSha256: current.headSha256,
    exportedAt,
    signatureHmacSha256: createHmac('sha256', signingKey).update(signedPayload).digest('hex'),
  };
  const handle = await open(path, 'a', 0o600);
  try {
    await appendFile(handle, `${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directoryHandle = await open(directory, 'r');
  try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
}
