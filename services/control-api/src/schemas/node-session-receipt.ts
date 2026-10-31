import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { participantWorkKindSchema } from './resource-participant-reconciliation.js';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const millis = z.number().int().positive().max(8_640_000_000_000_000);

/** A terminal receipt exists only for a node-supervised bounded process group. */
const nodeSessionReceiptBaseSchema = z.object({
  version: z.literal(1),
  workId: z.string().guid(),
  nodeId: z.string().min(1).max(128),
  nodeFqdn: z.string().min(1).max(253),
  participant: z.enum(['api', 'dashboard']),
  ownerId: z.string().guid(),
  kind: participantWorkKindSchema,
  operationSha256: sha256,
  requestSha256: sha256,
  fence: z.string().regex(/^[1-9][0-9]{0,19}$/),
  deadline: millis,
  bootId: z.string().guid(),
  unit: z.string().regex(/^magnus-exec-[a-f0-9]{64}\.service$/),
  invocationId: z.string().regex(/^[a-f0-9]{32}$/),
  cgroup: z.string().min(1).max(1024).regex(/^\/[a-zA-Z0-9_/.@:\\-]+$/),
  startedAt: millis,
  terminalAt: millis,
  disposition: z.enum(['succeeded', 'failed', 'no_effect']),
  resultSha256: sha256,
  completionRegistrySha256: sha256,
  completionDescriptorId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  groupEmpty: z.literal(true),
  effectBoundary: z.literal('bounded-node-process'),
}).strict();
function refineReceipt(value: { cgroup: string; unit: string; startedAt: number; terminalAt: number; deadline: number }, ctx: z.RefinementCtx): void {
  if (!value.cgroup.endsWith(`/${value.unit}`)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cgroup'], message: 'cgroup must bind the exact unit' });
  if (value.startedAt > value.terminalAt) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['terminalAt'], message: 'terminal time precedes start' });
  if (value.startedAt > value.deadline) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['startedAt'], message: 'session started after its authority expired' });
}
export const nodeSessionReceiptUnsignedSchema = nodeSessionReceiptBaseSchema.superRefine(refineReceipt);
export const nodeSessionReceiptSchema = nodeSessionReceiptBaseSchema.extend({ signature: sha256 }).superRefine(refineReceipt);

export type NodeSessionReceipt = z.infer<typeof nodeSessionReceiptSchema>;

export function nodeSessionReceiptSigningPayload(value: Omit<NodeSessionReceipt, 'signature'>): string {
  return JSON.stringify({
    domain: 'magnus.node-session-terminal.v1',
    version: value.version,
    workId: value.workId,
    nodeId: value.nodeId,
    nodeFqdn: value.nodeFqdn,
    participant: value.participant,
    ownerId: value.ownerId,
    kind: value.kind,
    operationSha256: value.operationSha256,
    requestSha256: value.requestSha256,
    fence: value.fence,
    deadline: value.deadline,
    bootId: value.bootId,
    unit: value.unit,
    invocationId: value.invocationId,
    cgroup: value.cgroup,
    startedAt: value.startedAt,
    terminalAt: value.terminalAt,
    disposition: value.disposition,
    resultSha256: value.resultSha256,
    completionRegistrySha256: value.completionRegistrySha256,
    completionDescriptorId: value.completionDescriptorId,
    groupEmpty: value.groupEmpty,
    effectBoundary: value.effectBoundary,
  });
}

export function canonicalNodeSessionReceipt(value: NodeSessionReceipt): string {
  return JSON.stringify({ payload: JSON.parse(nodeSessionReceiptSigningPayload(value)) as unknown, signature: value.signature });
}

export function verifyNodeSessionReceiptSignature(value: NodeSessionReceipt, activeSecret: string, previousSecret = ''): boolean {
  if (activeSecret.length < 32) return false;
  const actual = Buffer.from(value.signature, 'hex');
  let matched = false;
  for (const secret of [activeSecret, ...(previousSecret.length >= 32 ? [previousSecret] : [])]) {
    const expected = createHmac('sha256', secret).update(nodeSessionReceiptSigningPayload(value)).digest();
    matched = (actual.length === expected.length && timingSafeEqual(actual, expected)) || matched;
  }
  return matched;
}
