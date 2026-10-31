/** Fixed authenticated scheduler-state observation; callers cannot supply enrollment evidence. */
import { z } from 'zod';
import { CONTROL_API_URL, NODE_MANAGER_SECRET } from '../env.js';
import { controlApiFetch } from '../tls.js';
export const schedulerStatusSchema = z.object({ version: z.literal(1), nodeId: z.string().min(1).max(128),
  nodeFqdn: z.string().min(1).max(253), nonce: z.string().guid(), state: z.enum(['legacy', 'draining', 'enrolled']),
  epoch: z.number().int().nonnegative(), barrierId: z.string().guid().nullable(),
  schedulerChallenge: z.object({ challengeId: z.string().guid(), expiresAt: z.number().int().positive() }).strict().nullable() }).strict();
export async function freshSchedulerStatus(input: { nodeFqdn: string; nonce: string }) {
  const response = await controlApiFetch(CONTROL_API_URL.replace(/\/+$/, '') + '/api/v1/resource-leases/enrollment/scheduler-status', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: {
      'content-type': 'application/json', 'x-node-token': NODE_MANAGER_SECRET, 'cache-control': 'no-store' }, body: JSON.stringify(input),
  });
  if (!response.ok || !response.body) throw new Error('Scheduler authority unavailable');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length;
    if (bytes > 16_384) throw new Error('Scheduler authority exceeded bound'); chunks.push(chunk.value); }
  } finally { await reader.cancel().catch(() => undefined); }
  const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { success?: boolean; data?: unknown };
  if (envelope.success !== true) throw new Error('Scheduler authority rejected'); return schedulerStatusSchema.parse(envelope.data);
}
