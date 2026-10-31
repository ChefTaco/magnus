/** Signed terminal evidence for centrally reserved participant work.
 * This module never starts work. Normal completion and recovery both consume
 * the same durable ExecutionSupervisor observation, so recovery cannot replay
 * a command or mint evidence from a socket/shell close.
 */
import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import { CONTROL_API_URL, NODE_MANAGER_SECRET, RESULT_SIGNING_SECRET } from '../env.js';
import type { ExecutionSupervisor, SupervisorStatus } from '../executors/execution-supervisor.js';
import { controlApiFetch } from '../tls.js';
import { COMMAND_COMPLETION_REGISTRY, COMMAND_COMPLETION_REGISTRY_SHA256 } from './command-completion-registry.js';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const kind = z.enum(['ssh-command', 'agent-deploy', 'agent-upgrade', 'control-deploy', 'agent-migrate',
  'self-update-check', 'self-update-apply', 'self-update-restart', 'terminal-http', 'terminal-ws', 'hermes-http', 'hermes-ws']);
export const nodeSessionAuthoritySchema = z.object({
  workId: z.string().guid(), nodeId: z.string().min(1).max(128), nodeFqdn: z.string().min(1).max(253),
  participant: z.enum(['api', 'dashboard']), ownerId: z.string().guid(), kind,
  operationSha256: sha256, requestSha256: sha256, fence: z.string().regex(/^[1-9][0-9]{0,19}$/),
  deadline: z.number().int().positive().max(8_640_000_000_000_000),
}).strict();
export type NodeSessionAuthority = z.infer<typeof nodeSessionAuthoritySchema>;

const terminalEvidenceSchema = z.object({
  version: z.literal(1), commandId: z.string().min(1).max(128), requestSha256: sha256,
  unit: z.string().regex(/^magnus-exec-[a-f0-9]{64}\.service$/), bootId: z.string().guid(),
  deadline: z.number().int().positive(), invocationId: z.string().regex(/^[a-f0-9]{32}$/),
  cgroup: z.string().min(1).max(1024).regex(/^\/[a-zA-Z0-9_/.@:\\-]+$/),
  startedAt: z.number().int().positive(), terminalAt: z.number().int().positive(), groupEmpty: z.literal(true),
  completionOwner: z.object({ version: z.literal(1), registrySha256: sha256,
    descriptorId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/) }).strict(),
}).passthrough().superRefine((value, ctx) => {
  if (!value.cgroup.endsWith(`/${value.unit}`)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cgroup'], message: 'cgroup differs from unit' });
  if (value.startedAt > value.terminalAt) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['terminalAt'], message: 'terminal precedes start' });
});

export interface NodeSessionReceipt extends NodeSessionAuthority {
  version: 1; bootId: string; unit: string; invocationId: string; cgroup: string;
  startedAt: number; terminalAt: number; disposition: 'succeeded' | 'failed'; resultSha256: string;
  completionRegistrySha256: string; completionDescriptorId: string;
  groupEmpty: true; effectBoundary: 'bounded-node-process'; signature: string;
}

export function nodeSessionReceiptSigningPayload(value: Omit<NodeSessionReceipt, 'signature'>): string {
  return JSON.stringify({ domain: 'magnus.node-session-terminal.v1', version: value.version, workId: value.workId,
    nodeId: value.nodeId, nodeFqdn: value.nodeFqdn, participant: value.participant, ownerId: value.ownerId, kind: value.kind,
    operationSha256: value.operationSha256, requestSha256: value.requestSha256, fence: value.fence, deadline: value.deadline,
    bootId: value.bootId, unit: value.unit, invocationId: value.invocationId, cgroup: value.cgroup,
    startedAt: value.startedAt, terminalAt: value.terminalAt, disposition: value.disposition,
    resultSha256: value.resultSha256, completionRegistrySha256: value.completionRegistrySha256,
    completionDescriptorId: value.completionDescriptorId, groupEmpty: value.groupEmpty, effectBoundary: value.effectBoundary });
}

function resultDigest(result: NonNullable<SupervisorStatus['result']>): string {
  return createHash('sha256').update(JSON.stringify({ exitCode: result.exitCode, durationMs: result.durationMs,
    stdoutSha256: createHash('sha256').update(result.stdout).digest('hex'),
    stderrSha256: createHash('sha256').update(result.stderr).digest('hex'), truncated: result.truncated })).digest('hex');
}

/** Convert only an exact durable, group-empty supervisor completion to a receipt. */
export function issueNodeSessionReceipt(rawAuthority: unknown, status: SupervisorStatus): NodeSessionReceipt {
  const authority = nodeSessionAuthoritySchema.parse(rawAuthority);
  if (status.state !== 'completed' || !status.result) throw new Error('Terminal supervisor evidence is unavailable');
  const evidence = terminalEvidenceSchema.parse(status.evidence);
  if (evidence.requestSha256 !== authority.operationSha256 || evidence.deadline !== authority.deadline)
    throw new Error('Supervisor evidence differs from participant authority');
  const descriptor = COMMAND_COMPLETION_REGISTRY.descriptors.find(value => value.id === evidence.completionOwner.descriptorId);
  if (evidence.completionOwner.registrySha256 !== COMMAND_COMPLETION_REGISTRY_SHA256 || !descriptor
    || !descriptor.participantAuthority.allowedKinds.some(kind => kind === authority.kind)
    || descriptor.participantAuthority.effectSemantics !== 'read-only-node-diagnostic'
    || descriptor.participantAuthority.effectBoundary !== 'bounded-node-process')
    throw new Error('Supervisor evidence lacks an approved bounded completion owner');
  if (RESULT_SIGNING_SECRET.length < 32 || RESULT_SIGNING_SECRET === NODE_MANAGER_SECRET) throw new Error('Dedicated node receipt signer is unavailable');
  const unsigned: Omit<NodeSessionReceipt, 'signature'> = { version: 1, ...authority, bootId: evidence.bootId,
    unit: evidence.unit, invocationId: evidence.invocationId, cgroup: evidence.cgroup, startedAt: evidence.startedAt,
    terminalAt: evidence.terminalAt, disposition: status.result.exitCode === 0 ? 'succeeded' : 'failed',
    resultSha256: resultDigest(status.result), completionRegistrySha256: evidence.completionOwner.registrySha256,
    completionDescriptorId: evidence.completionOwner.descriptorId, groupEmpty: true,
    effectBoundary: descriptor.participantAuthority.effectBoundary };
  return { ...unsigned, signature: createHmac('sha256', RESULT_SIGNING_SECRET).update(nodeSessionReceiptSigningPayload(unsigned)).digest('hex') };
}

export async function publishNodeSessionReceipt(authority: unknown, status: SupervisorStatus): Promise<NodeSessionReceipt> {
  const receipt = issueNodeSessionReceipt(authority, status);
  const response = await controlApiFetch(`${CONTROL_API_URL.replace(/\/+$/, '')}/api/v1/resource-leases/enrollment/work/${receipt.workId}/node-receipt`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-node-token': NODE_MANAGER_SECRET }, body: JSON.stringify(receipt),
  });
  if (!response.ok) throw new Error(`Node session receipt was not accepted (${response.status})`);
  const value = await response.json() as { success?: boolean; data?: { workId?: string; state?: string } };
  if (value.success !== true || value.data?.workId !== receipt.workId || value.data.state !== 'released')
    throw new Error('Node session receipt acknowledgment differs');
  return receipt;
}

/** Recovery observes the original supervisor identity and never calls run(). */
export async function recoverAndPublishNodeSessionReceipt(authority: unknown, commandId: string, supervisor: ExecutionSupervisor): Promise<NodeSessionReceipt> {
  const exact = nodeSessionAuthoritySchema.parse(authority);
  return publishNodeSessionReceipt(exact, await supervisor.status(commandId, exact.operationSha256));
}
