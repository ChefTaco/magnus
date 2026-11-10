import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { embermendOperationSchema, embermendCanonical } from '@hivemagnus/magnus-contracts/embermend';
import { CONTROL_API_VERSION } from '../config/index.js';
import type { AppVariables } from '../types/index.js';
import { getDb } from '../db/index.js';
import { NodeApiClient } from '../sdk/node-api-client.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { getNodeManagerSecret } from '../utils/env.js';
import { safeEqual } from '../utils/safe-equal.js';
import { HttpError } from '../middleware/error-handler.js';
import { logAuditEvent } from '../services/audit-service.js';
import { httpReceiptBody } from '../security/managed-http.js';

const slug = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
export const embermendGrantsSchema = z.record(slug, z.object({ tokenSha256: z.string().regex(/^[a-f0-9]{64}$/), installationId: slug, productInstallationId: slug, applicationIds: z.array(slug), targets: z.record(slug, z.object({ nodeId: z.string().min(1).max(200), environment: slug.default('unknown'), actions: z.array(z.string().min(1).max(100)) }).strict()) }).strict()).superRefine((grants, context) => {
  const tokens = new Set<string>();
  for (const [id, grant] of Object.entries(grants)) {
    if (tokens.has(grant.tokenSha256)) context.addIssue({ code: 'custom', path: [id], message: 'Each integration credential must identify exactly one grant' });
    tokens.add(grant.tokenSha256);
    if (new Set(Object.values(grant.targets).map(target => target.nodeId)).size !== Object.keys(grant.targets).length) context.addIssue({ code: 'custom', path: [id], message: 'A physical target needs one stable logical identity within a grant' });
  }
});
const hash = (value: unknown): string => createHash('sha256').update(embermendCanonical(value)).digest('hex');
function authorize(header: string | undefined) {
  const raw: unknown = JSON.parse(process.env['MAGNUS_EMBERMEND_GRANTS_JSON'] ?? '{}'); const grants = embermendGrantsSchema.parse(raw);
  if (!header?.startsWith('Bearer ') || header.length < 39) throw new HttpError(401, 'UNAUTHORIZED', 'Endpoint-scoped Embermend credential required');
  const tokenSha256 = createHash('sha256').update(header.slice(7)).digest('hex');
  for (const [integrationId, grant] of Object.entries(grants)) if (safeEqual(grant.tokenSha256, tokenSha256)) return { integrationId, ...grant };
  throw new HttpError(401, 'UNAUTHORIZED', 'Endpoint-scoped Embermend credential required');
}
type Grant = ReturnType<typeof authorize>;
async function target(grant: Grant, logicalId: string) {
  const binding = grant.targets[logicalId]; if (!binding) throw new HttpError(403, 'FORBIDDEN', 'Target outside product grant');
  const node = await getDb().node.findUnique({ where: { id: binding.nodeId }, include: { agent: true } }); if (!node || node.status === 'DECOMMISSIONED') throw new HttpError(409, 'TARGET_UNAVAILABLE', 'Target unavailable');
  const client = new NodeApiClient({ baseUrl: getNodeBaseUrl(node.ipAddress, node.port), resourceNodeId: node.id, resourceActorId: 'service:embermend:' + grant.integrationId, nodeToken: getNodeManagerSecret() });
  return { binding, node, client };
}
const operationRecordSchema = z.object({ id: z.string(), operationId: z.string(), nodeId: z.string(), commandId: z.string(), requestDigest: z.string(), request: embermendOperationSchema });
async function observed(grant: Grant, operationId: string) {
  const db = getDb(); const stored = await db.embermendOperation.findUnique({ where: { integrationId_operationId: { integrationId: grant.integrationId, operationId } } });
  if (!stored) throw new HttpError(404, 'NOT_FOUND', 'Operation has not been reserved'); const operation = operationRecordSchema.parse(stored);
  const { node, client } = await target(grant, operation.request.action.targetId);
  if (node.id !== operation.nodeId) throw new HttpError(409, 'TARGET_BINDING_CHANGED', 'Reconcile original target before changing its grant');
  const evidenceIds: string[] = []; const result: Record<string, z.infer<ReturnType<typeof z.json>>> = {};
  const base = { operationId, requestDigest: operation.requestDigest, targetId: operation.request.action.targetId, evidenceIds, result, ownershipReleased: false, observedAt: new Date().toISOString() };
  if (stored.state === 'queued') return { ...base, state: 'queued' };
  const refusal = z.object({ notDispatched: z.literal(true), reason: z.string() }).safeParse(stored.result);
  if (stored.state === 'failed' && refusal.success) return { ...base, state: 'failed', result: refusal.data, ownershipReleased: true };
  const lease = await db.commandResourceLease.findUnique({ where: { commandId: operation.commandId } });
  if (!lease) return { ...base, state: 'unknown' };
  try {
    const receipt = await client.getCommandReceipt(operation.commandId, { nodeFqdn: node.hostname, requestSha256: lease.requestSha256 });
    if (receipt.state !== 'completed') return { ...base, state: receipt.state === 'running' ? 'running' : 'unknown', ownershipReleased: lease.state === 'released' };
    const currentLease = await db.commandResourceLease.findUnique({ where: { commandId: operation.commandId } });
    if (receipt.result.exitCode !== 0) return { ...base, state: 'failed', result: { exitCode: receipt.result.exitCode }, ownershipReleased: currentLease?.state === 'released' };
    const resultKey = createHash('sha256').update(operationId + ':' + operation.requestDigest).digest('hex');
    const result = await client.embermendResult(operationId, resultKey);
    const pointer = { success: true, data: { resultKey, resultDigest: hash(result) } };
    if (receipt.result.stdout !== httpReceiptBody('POST', '/embermend/action', 200, JSON.stringify(pointer))) throw new Error('Result does not match original signed receipt');
    await db.embermendOperation.update({ where: { id: operation.id }, data: { state: 'completed', result: result.data } });
    return { ...base, state: 'completed', result: result.data, evidenceIds: [operation.commandId], ownershipReleased: currentLease?.state === 'released' };
  } catch { return { ...base, state: 'unknown' }; }
}
export const embermendRouter = new Hono<AppVariables>();
embermendRouter.get('/capabilities', async c => {
  const grant = authorize(c.req.header('authorization')); const targets = []; const agents = []; const actions = new Set<string>();
  for (const logicalId of Object.keys(grant.targets)) {
    const { binding, node, client } = await target(grant, logicalId); const enrollment = await getDb().resourceEnrollment.findUnique({ where: { nodeId: node.id } });
    const capability = await client.embermendCapabilities().catch(() => null);
    const supported = capability?.data.actions.filter(action => binding.actions.includes(action)) ?? []; supported.forEach(action => actions.add(action));
    const agentId = 'agent-' + hash([grant.installationId, node.agent?.id ?? node.id]);
    if (node.agent) agents.push({ id: agentId, kind: 'management-agent', label: 'Magnus management agent', scope: { installationId: grant.productInstallationId, applicationIds: [], targetIds: [logicalId] }, provenance: { source: 'magnus', assurance: 'established', evidenceIds: [], observedAt: new Date().toISOString() }, magnusInstallationId: grant.installationId, magnusAgentId: node.agent.id, targetIds: [logicalId], capabilities: supported.map(action => 'embermend:' + action), version: node.agent.version, lifecycle: node.status === 'ONLINE' ? 'active' : 'offline' });
    targets.push({ id: logicalId, kind: 'target', label: node.name, scope: { installationId: grant.productInstallationId, applicationIds: [], targetIds: [logicalId] }, provenance: { source: 'magnus', assurance: 'established', evidenceIds: [], observedAt: new Date().toISOString() }, magnusInstallationId: grant.installationId, magnusTargetId: node.id, agentId, environment: binding.environment, targetKind: capability?.data.targetKind ?? 'host', enrollment: enrollment?.state ?? 'legacy', platform: capability?.data.platform ?? 'unsupported', capabilities: supported.map(action => 'embermend:' + action), lastSeenAt: node.lastHeartbeatAt?.toISOString() ?? new Date(0).toISOString(), parentHostId: null, workloadId: null, instanceId: null, executionNamespace: 'host', lifecycle: node.status === 'ONLINE' ? 'active' : 'offline' });
  }
  return c.json({ protocol: 1, installationId: grant.installationId, serviceVersion: CONTROL_API_VERSION, actions: [...actions], targets, agents, observedAt: new Date().toISOString() });
});
embermendRouter.get('/operations/:id', async c => new Response(JSON.stringify(await observed(authorize(c.req.header('authorization')), c.req.param('id'))), { headers: { 'content-type': 'application/json' } }));
embermendRouter.post('/operations', async c => {
  const grant = authorize(c.req.header('authorization')); const request = embermendOperationSchema.parse(await c.req.json());
  if (Buffer.byteLength(JSON.stringify({ requestJson: JSON.stringify(request) })) > 96 * 1024) throw new HttpError(413, 'REQUEST_TOO_LARGE', 'Operation exceeds the declared managed request budget');
  if (request.installationId !== grant.installationId || Date.parse(request.expiresAt) <= Date.now()) throw new HttpError(409, 'EXPIRED_OR_WRONG_INSTALLATION', 'Current installation-bound request required');
  const { binding, node, client } = await target(grant, request.action.targetId);
  if (!['assess', 'prepare'].includes(request.action.class) && request.action.preconditions['environment'] !== binding.environment) throw new HttpError(409, 'ENVIRONMENT_MISMATCH', 'Target environment differs from the authorized plan');
  if (!binding.actions.includes(request.action.version) || !request.action.requiredCapabilities.includes('embermend:' + request.action.version)) throw new HttpError(403, 'FORBIDDEN', 'Action outside product capability grant');
  const enrollment = await getDb().resourceEnrollment.findUnique({ where: { nodeId: node.id } });
  const capability = await client.embermendCapabilities();
  if (enrollment?.state !== 'enrolled' || node.status !== 'ONLINE' || !node.lastHeartbeatAt || Date.now() - node.lastHeartbeatAt.getTime() > 120000 || !capability.data.actions.includes(request.action.version) || !(capability.data.targetKind === request.action.targetKind || capability.data.targetKind === 'host' && request.action.targetKind === 'worker')) throw new HttpError(409, 'CAPABILITY_UNAVAILABLE', 'Enrolled compatible target required');
  const commandId = 'embermend-' + hash([grant.integrationId, request.operationId]);
  const inserted = await getDb().$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${commandId}, 0))`;
    const prior = await tx.embermendOperation.findUnique({ where: { integrationId_operationId: { integrationId: grant.integrationId, operationId: request.operationId } } });
    if (prior) { if (prior.requestDigest !== hash(request) || prior.nodeId !== node.id) throw new HttpError(409, 'OPERATION_IDENTITY_CONFLICT', 'Original operation differs'); return false; }
    await tx.embermendOperation.create({ data: { id: randomUUID(), integrationId: grant.integrationId, operationId: request.operationId, nodeId: node.id, commandId, requestDigest: hash(request), request, state: 'queued' } }); return true;
  });
  if (!inserted) return new Response(JSON.stringify(await observed(grant, request.operationId)), { headers: { 'content-type': 'application/json' } });
  await logAuditEvent({ action: 'embermend.dispatch', actorId: 'service:embermend:' + grant.integrationId, targetType: 'node', targetId: node.id, details: { commandId, planId: request.planId, planRevision: request.planRevision, planDigest: request.planDigest, actionVersion: request.action.version, authorizationRef: request.authorizationRef } });
  return c.json({ operationId: request.operationId, requestDigest: hash(request), targetId: request.action.targetId, evidenceIds: [], result: {}, ownershipReleased: false, observedAt: new Date().toISOString(), state: 'queued' }, 202);
});

let dispatchTimer: ReturnType<typeof setInterval> | undefined;
const active = new Set<string>();
/** Claims are committed before native dispatch. A crashed or lost dispatch is
 * reconciled by commandId and is never selected for another launch. */
export async function dispatchQueuedEmbermend(): Promise<void> {
  const db = getDb();
  const pending = await db.embermendOperation.findMany({ where: { state: 'queued' }, orderBy: { createdAt: 'asc' }, take: Math.max(0, 4 - active.size) });
  for (const row of pending) {
    if (active.has(row.id)) continue;
    const claimed = await db.embermendOperation.updateMany({ where: { id: row.id, state: 'queued' }, data: { state: 'unknown' } });
    if (!claimed.count) continue;
    active.add(row.id);
    void (async () => {
      let started = false;
      try {
        const request = embermendOperationSchema.parse(row.request);
        const grants = embermendGrantsSchema.parse(JSON.parse(process.env['MAGNUS_EMBERMEND_GRANTS_JSON'] ?? '{}'));
        const configured = grants[row.integrationId];
        if (!configured || request.installationId !== configured.installationId || Date.parse(request.expiresAt) <= Date.now()) throw new Error('GRANT_REVOKED_OR_REQUEST_EXPIRED');
        const grant = { integrationId: row.integrationId, ...configured };
        const { binding, node, client } = await target(grant, request.action.targetId);
        const enrollment = await db.resourceEnrollment.findUnique({ where: { nodeId: node.id } });
        const capability = await client.embermendCapabilities();
        if (!['assess', 'prepare'].includes(request.action.class) && request.action.preconditions['environment'] !== binding.environment) throw new Error('TARGET_ENVIRONMENT_CHANGED');
        if (node.id !== row.nodeId || !binding.actions.includes(request.action.version) || !capability.data.actions.includes(request.action.version) || enrollment?.state !== 'enrolled' || node.status !== 'ONLINE' || !node.lastHeartbeatAt || Date.now() - node.lastHeartbeatAt.getTime() > 120000) throw new Error('TARGET_NO_LONGER_ELIGIBLE');
        started = true;
        await client.embermendExecute(request, row.commandId);
        await observed(grant, request.operationId);
      } catch {
        if (!started) await db.embermendOperation.update({ where: { id: row.id }, data: { state: 'failed', result: { notDispatched: true, reason: 'PRE_DISPATCH_CAPABILITY_OR_AUTHORITY_CHANGED' } } });
        // Once native admission may have begun, retain the original command and
        // lease for signed reconciliation; no blind retry or inferred completion.
      } finally { active.delete(row.id); }
    })().catch(() => { console.warn('[embermend] Dispatch state persistence failed; original operation requires reconciliation'); });
  }
}
export function startEmbermendDispatcher(): void {
  if (dispatchTimer || !process.env['MAGNUS_EMBERMEND_GRANTS_JSON']) return;
  embermendGrantsSchema.parse(JSON.parse(process.env['MAGNUS_EMBERMEND_GRANTS_JSON']));
  dispatchTimer = setInterval(() => { void dispatchQueuedEmbermend().catch(() => console.warn('[embermend] Durable queue read failed')); }, 1000);
  dispatchTimer.unref();
}
export function stopEmbermendDispatcher(): void { if (dispatchTimer) clearInterval(dispatchTimer); dispatchTimer = undefined; }
