/** Fresh, owner-signed proof of the node agent's one-way mutation drain.
 * A proof is only one independent writer class; it cannot transfer release
 * traffic or settle a retained unknown claim. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonical } from './resource-enrollment.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { getNodeManagerSecret, RESULT_SIGNING_SECRET } from '../utils/env.js';

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const proofSchema = z.object({ version: z.literal(1), sourceClass: z.literal('host-local-mutations'),
  nodeId: z.string().min(1).max(128), nodeFqdn: z.string().min(1).max(253),
  epoch: z.number().int().positive(), barrierId: z.string().guid(), nonce: z.string().guid(),
  observedAt: z.number().int().positive(), active: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(), mutationInventorySha256: hex,
  admissionFenceSha256: hex, signature: hex }).strict();
export type HostLocalWriterProof = z.infer<typeof proofSchema>;
const DOMAIN = 'magnus.host-local-writer.v1\n';

export function verifyHostLocalWriterProof(raw: unknown, expected: {
  nodeId: string; nodeFqdn: string; nonce: string; epoch: number; barrierId: string | null;
}, now = Date.now()): { ownerReceiptSha256: string; admissionFenceSha256: string;
  mutationInventorySha256: string } | null {
  const parsed = proofSchema.safeParse(raw);
  if (!parsed.success || RESULT_SIGNING_SECRET.length < 32) return null;
  const { signature, ...receipt } = parsed.data;
  if (receipt.nodeId !== expected.nodeId || receipt.nodeFqdn !== expected.nodeFqdn
    || receipt.nonce !== expected.nonce || receipt.epoch !== expected.epoch
    || receipt.barrierId !== expected.barrierId || receipt.active !== 0 || receipt.unknown !== 0
    || now - receipt.observedAt < -1000 || now - receipt.observedAt > 20_000) return null;
  const exactFence = createHash('sha256').update(canonical({ nodeId: expected.nodeId,
    nodeFqdn: expected.nodeFqdn, epoch: expected.epoch, barrierId: expected.barrierId })).digest('hex');
  if (receipt.admissionFenceSha256 !== exactFence) return null;
  const signed = createHmac('sha256', RESULT_SIGNING_SECRET).update(DOMAIN + canonical(receipt)).digest();
  if (!timingSafeEqual(signed, Buffer.from(signature, 'hex'))) return null;
  return { ownerReceiptSha256: createHash('sha256').update(canonical(parsed.data)).digest('hex'),
    admissionFenceSha256: receipt.admissionFenceSha256,
    mutationInventorySha256: receipt.mutationInventorySha256 };
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('Owner proof unavailable');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 4096) throw new Error('Owner proof exceeded bound');
      parts.push(value);
    }
    const envelope = JSON.parse(Buffer.concat(parts).toString('utf8')) as { success?: unknown; data?: unknown };
    if (envelope.success !== true) throw new Error('Owner proof rejected');
    return envelope.data;
  } finally { await reader.cancel().catch(() => undefined); }
}

export async function fetchHostLocalWriterProof(node: { ipAddress: string; port: number },
  nodeFqdn: string, nonce: string): Promise<unknown | null> {
  try {
    if (RESULT_SIGNING_SECRET.length < 32) return null;
    const base = getNodeBaseUrl(node.ipAddress, node.port);
    if (new URL(base).protocol !== 'https:') return null;
    const url = new URL(base + '/api/v1/commands/host-local-writer-proof');
    url.search = new URLSearchParams({ nodeFqdn, nonce }).toString();
    const response = await fetch(url, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'x-node-token': getNodeManagerSecret(), 'cache-control': 'no-store' },
    });
    return await boundedJson(response);
  } catch { return null; }
}
