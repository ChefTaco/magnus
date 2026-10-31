import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '../db/index.js';
import {
  appendDeletionReceipts,
  deletionReceiptHash,
  type DeletionReceiptInput,
} from './security-fusion-receipt-chain.js';

const input: DeletionReceiptInput = {
  resourceType: 'evidence',
  resourceIdHash: 'resource-hash',
  reason: 'retention',
  outcome: 'deleted',
  bytesDeleted: 42,
  detailJson: '{"contentSha256":"content-hash"}',
  deletedAt: new Date('2026-07-29T00:00:00.000Z'),
};

describe('Security Fusion deletion receipt chain', () => {
  it('binds each receipt to the previous chain head and sequence', () => {
    const first = deletionReceiptHash(input, null, 1);
    const second = deletionReceiptHash(input, first, 2);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
    expect(deletionReceiptHash(input, 'different-head', 2)).not.toBe(second);
    expect(deletionReceiptHash(input, first, 3)).not.toBe(second);
  });

  it('detects receipt field tampering', () => {
    const expected = deletionReceiptHash(input, null, 1);
    expect(deletionReceiptHash({ ...input, bytesDeleted: 43 }, null, 1)).not.toBe(expected);
    expect(deletionReceiptHash({ ...input, outcome: 'already_missing' }, null, 1)).not.toBe(expected);
  });

  it('serializes a batch through the locked singleton chain head', async () => {
    const creates: Array<Record<string, unknown>> = [];
    const tx = {
      $queryRaw: vi.fn(async () => [{ headSha256: 'prior-head', chainSequence: 7 }]),
      securityFusionDeletionReceipt: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          creates.push(data);
          return data;
        }),
      },
      securityFusionReceiptChainHead: {
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      },
    } as unknown as Prisma.TransactionClient;
    const head = await appendDeletionReceipts(tx, [input, { ...input, resourceIdHash: 'second' }]);
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(creates).toHaveLength(2);
    expect(creates[0]).toMatchObject({
      previousReceiptSha256: 'prior-head',
      chainSequence: 8,
      chainVersion: 2,
    });
    expect(creates[1]).toMatchObject({
      previousReceiptSha256: creates[0]?.['receiptSha256'],
      chainSequence: 9,
    });
    expect(head).toEqual({ headSha256: creates[1]?.['receiptSha256'], chainSequence: 9 });
  });
});
