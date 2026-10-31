/** Node proof for an authority-created enrollment barrier; never action approval. */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { CONTROL_API_URL, HOST_FQDN, NODE_MANAGER_SECRET, RESULT_SIGNING_SECRET, MAGNUS_EXECUTION_SUPERVISOR_ENABLED } from '../env.js';
import { controlApiFetch } from '../tls.js';
import { commandLedger, executionSupervisor } from './command-executor.js';
import { mutationBarrier } from './mutation-barrier.js';

const descriptorSchema = z.object({ version: z.literal(1), participant: z.literal('agent'),
  nodeId: z.string().min(1).max(128), nodeFqdn: z.string().min(1).max(253), epoch: z.number().int().positive(),
  barrierId: z.string().guid(), challengeId: z.string().guid(), expiresAt: z.number().int().positive() }).strict();
const statusSchema = z.object({ version: z.literal(1), nodeId: z.string().min(1).max(128),
  nodeFqdn: z.string().min(1).max(253), nonce: z.string().guid(), state: z.enum(['legacy', 'draining', 'enrolled']),
  epoch: z.number().int().nonnegative(), barrierId: z.string().guid().nullable(),
  agentChallenge: z.object({ challengeId: z.string().guid(), expiresAt: z.number().int().positive() }).strict().nullable() }).strict();
const writerProofRequest = z.object({ nodeFqdn: z.string().min(1).max(253), nonce: z.string().guid() }).strict();
export const HOST_LOCAL_WRITER_DOMAIN = 'magnus.host-local-writer.v1\n';

export function canonicalDrainJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalDrainJson).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => JSON.stringify(key) + ':' + canonicalDrainJson(item)).join(',') + '}';
  return JSON.stringify(value);
}

export const enrollmentDrainRoutes = new Hono();
enrollmentDrainRoutes.get('/host-local-writer-proof', async c => {
  const request = writerProofRequest.safeParse(c.req.query());
  if (!request.success || request.data.nodeFqdn !== HOST_FQDN || RESULT_SIGNING_SECRET.length < 32
    || RESULT_SIGNING_SECRET === NODE_MANAGER_SECRET)
    return c.json({ success: false, error: { code: 'WRITER_PROOF_INVALID' } }, 409);
  try {
    // The owner reads its durable one-way drain and retained claims under the
    // same filesystem lock. No caller-provided status can become evidence.
    const inventory = await mutationBarrier.unknownInventory();
    const drain = inventory.drain;
    if (!drain || drain.nodeFqdn !== HOST_FQDN || inventory.nodeFqdn !== HOST_FQDN)
      throw new Error('Node mutation admission is not drained');
    const receipt = { version: 1 as const, sourceClass: 'host-local-mutations' as const,
      nodeId: drain.nodeId, nodeFqdn: HOST_FQDN, epoch: drain.epoch, barrierId: drain.barrierId,
      nonce: request.data.nonce, observedAt: inventory.observedAt,
      active: inventory.unsettledCounts.active,
      unknown: inventory.unsettledCounts.unknown,
      mutationInventorySha256: inventory.inventorySha256,
      admissionFenceSha256: createHash('sha256').update(canonicalDrainJson(drain)).digest('hex') };
    const signature = createHmac('sha256', RESULT_SIGNING_SECRET)
      .update(HOST_LOCAL_WRITER_DOMAIN + canonicalDrainJson(receipt)).digest('hex');
    c.header('Cache-Control', 'no-store');
    return c.json({ success: true, data: { ...receipt, signature } });
  } catch {
    return c.json({ success: false, error: { code: 'WRITER_PROOF_UNAVAILABLE' } }, 409);
  }
});
enrollmentDrainRoutes.get('/mutation-inventory', async c => {
  try {
    const inventory = await mutationBarrier.unknownInventory();
    c.header('Cache-Control', 'no-store');
    return c.json({ success: true, data: inventory });
  } catch {
    return c.json({ success: false, error: { code: 'MUTATION_INVENTORY_UNAVAILABLE',
      message: 'Retained mutation inventory cannot be validated' } }, 409);
  }
});
enrollmentDrainRoutes.post('/enrollment-drain', async c => {
  const parsed = descriptorSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: { code: 'INVALID_DRAIN_CHALLENGE' } }, 400);
  const descriptor = parsed.data;
  if (descriptor.nodeFqdn !== HOST_FQDN || descriptor.expiresAt <= Date.now()
    || descriptor.expiresAt > Date.now() + 300_000 || RESULT_SIGNING_SECRET.length < 32
    || RESULT_SIGNING_SECRET === NODE_MANAGER_SECRET) return c.json({ success: false, error: { code: 'INVALID_DRAIN_CHALLENGE' } }, 409);
  try {
    const request = { nodeFqdn: HOST_FQDN, nonce: randomUUID() };
    const response = await controlApiFetch(CONTROL_API_URL.replace(/\/+$/, '') + '/api/v1/resource-leases/enrollment/node-status', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', 'x-node-token': NODE_MANAGER_SECRET, 'cache-control': 'no-store' },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error('Drain authority unavailable');
    const envelope = await response.json() as { success?: boolean; data?: unknown };
    const status = statusSchema.parse(envelope.data);
    if (envelope.success !== true || status.nonce !== request.nonce || status.nodeFqdn !== descriptor.nodeFqdn
      || status.nodeId !== descriptor.nodeId || status.state !== 'draining' || status.epoch !== descriptor.epoch
      || status.barrierId !== descriptor.barrierId || status.agentChallenge?.challengeId !== descriptor.challengeId
      || status.agentChallenge.expiresAt !== descriptor.expiresAt) throw new Error('Drain authority binding differs');
    const identity = { nodeId: descriptor.nodeId, nodeFqdn: descriptor.nodeFqdn, epoch: descriptor.epoch, barrierId: descriptor.barrierId };
    await mutationBarrier.drain(identity);
    if (!MAGNUS_EXECUTION_SUPERVISOR_ENABLED) throw new Error('Supervised execution is required for enrollment proof');
    const supervisor = await executionSupervisor.inventory();
    if (!supervisor.supported || !supervisor.quiescent) throw new Error('Supervisor work remains unverified');
    const mutations = await mutationBarrier.snapshot(identity);
    const commands = await commandLedger.drainSnapshot();
    if (descriptor.expiresAt <= Date.now()) throw new Error('Drain challenge expired while collecting evidence');
    const activeCount = mutations.activeCount + commands.activeCount;
    const unknownCount = mutations.unknownCount + commands.unknownCount;
    const receipt = { ...descriptor, status: activeCount || unknownCount ? 'pending' : 'drained', activeCount, unknownCount,
      evidenceSha256: createHash('sha256').update(canonicalDrainJson({ mutations, commands, supervisor })).digest('hex') };
    const signature = createHmac('sha256', RESULT_SIGNING_SECRET).update('magnus.resource-enrollment.v1\n' + canonicalDrainJson(receipt)).digest('hex');
    c.header('Cache-Control', 'no-store');
    return c.json({ ...receipt, signature });
  } catch {
    return c.json({ success: false, error: { code: 'DRAIN_EVIDENCE_UNAVAILABLE',
      message: 'Drain evidence is incomplete; no enrollment acknowledgment issued' } }, 409);
  }
});
