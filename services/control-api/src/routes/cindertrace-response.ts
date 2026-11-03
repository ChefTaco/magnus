import { bridgeSignature, equalSignature } from '../security/cindertrace-response.js';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { responseRequestSchema, type ResponseRequest } from '@hivemagnus/magnus-contracts';
import { getDb } from '../db/index.js';
import { NodeApiClient } from '../sdk/node-api-client.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { getNodeManagerSecret } from '../utils/env.js';
import { HttpError } from '../middleware/error-handler.js';
import { logAuditEvent } from '../services/audit-service.js';
import type { AppVariables } from '../types/index.js';
export const cindertraceResponseRouter = new Hono<AppVariables>();
function secret() {
  const value = process.env['CINDERTRACE_RESPONSE_SECRET'] ?? '';
  if (
    value.length < 32 ||
    value === process.env['API_SECRET'] ||
    value === process.env['NODE_MANAGER_SECRET']
  )
    throw new HttpError(
      503,
      'RESPONSE_DISABLED',
      'Dedicated Cindertrace response credential is required',
    );
  return value;
}
cindertraceResponseRouter.use('*', async (c, next) => {
  const timestamp = c.req.header('x-cindertrace-time') ?? '',
    nonce = c.req.header('x-cindertrace-nonce') ?? '';
  if (
    !/^\d{13}$/.test(timestamp) ||
    Math.abs(Date.now() - Number(timestamp)) > 60000 ||
    !/^[a-f0-9]{32}$/.test(nonce)
  )
    throw new HttpError(401, 'UNAUTHORIZED', 'Invalid response request');
  const raw = c.req.method === 'GET' ? '' : await c.req.text();
  if (
    Buffer.byteLength(raw) > 16384 ||
    !equalSignature(
      c.req.header('x-cindertrace-signature') ?? '',
      bridgeSignature(secret(), c.req.method, c.req.path, timestamp, nonce, raw),
    )
  )
    throw new HttpError(401, 'UNAUTHORIZED', 'Invalid response request');
  await next();
  // Sign the exact response body and bind it to this request; no source output or credentials are returned.
  const text = await c.res.clone().text();
  c.header(
    'x-cindertrace-signature',
    bridgeSignature(secret(), 'RESPONSE', c.req.path, timestamp, nonce, text),
  );
  c.header('Cache-Control', 'no-store');
});
async function client(nodeId: string) {
  const node = await getDb().node.findUnique({ where: { id: nodeId } });
  if (!node) throw new HttpError(404, 'TARGET_NOT_FOUND', 'Target is unavailable');
  return {
    node,
    api: new NodeApiClient({
      baseUrl: getNodeBaseUrl(node.ipAddress, node.port),
      nodeToken: getNodeManagerSecret(),
      resourceNodeId: node.id,
      resourceActorId: 'service:cindertrace',
    }),
  };
}
cindertraceResponseRouter.get('/targets/:id/health', async (c) => {
  const { api } = await client(c.req.param('id'));
  const health = await api.collectHealth();
  return c.json({
    data: {
      services: health.data?.services ?? [],
      wazuh: health.data?.wazuh,
      responseCapable: await api.securityResponseCapable(),
    },
  });
});
export function validateResponsePolicy(
  p: ResponseRequest,
  node: {
    id: string;
    status: string;
    lastHeartbeatAt: Date | null;
    tags: string;
    metadata: string;
  },
) {
  if (p.operation === 'release') return;
  if (
    node.status !== 'ONLINE' ||
    !node.lastHeartbeatAt ||
    Date.now() - node.lastHeartbeatAt.getTime() > 120000
  )
    throw new HttpError(409, 'TARGET_STALE', 'A fresh online target is required');
  if (p.kind === 'service_restart') {
    const allowed = (process.env['CINDERTRACE_RESTART_ALLOWLIST'] ?? '')
      .split(',')
      .map((x) => x.trim());
    if (!p.serviceName || !allowed.includes(p.serviceName))
      throw new HttpError(403, 'RESTART_BLOCKED', 'Service must be explicitly allowlisted');
  } else {
    const tags = JSON.parse(node.tags) as string[],
      metadata = JSON.parse(node.metadata) as Record<string, unknown>;
    const protectedIds = (process.env['CINDERTRACE_PROTECTED_TARGET_IDS'] ?? '').split(',');
    if (
      protectedIds.includes(node.id) ||
      tags.some((x) => ['control-plane', 'network-infrastructure'].includes(x)) ||
      metadata['securityIsolationPolicy'] !== 'allow' ||
      metadata['securityIsolationCapable'] !== true ||
      metadata['securityAegisChannelVerified'] !== true
    )
      throw new HttpError(
        403,
        'ISOLATION_BLOCKED',
        'Explicit isolation policy, capability, and verified recovery channel are required',
      );
  }
}
cindertraceResponseRouter.post('/execute', async (c) => {
  const parsed = responseRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) throw new HttpError(400, 'INVALID_RESPONSE', 'Malformed response plan');
  const p = parsed.data,
    raw = JSON.stringify(p),
    hash = createHash('sha256').update(raw).digest('hex');
  const db = getDb();
  const prior = await db.cindertraceResponse.findUnique({ where: { id: p.executionId } });
  if (prior) {
    if (prior.requestSha256 !== hash)
      throw new HttpError(409, 'RESPONSE_CONFLICT', 'Execution identity is bound to another plan');
    if (prior.status !== 'completed' || !prior.responseJson)
      throw new HttpError(
        409,
        'RESPONSE_UNKNOWN',
        'Inspect the original execution; do not replay it',
      );
    return c.json(JSON.parse(prior.responseJson) as Record<string, unknown>);
  }
  if (p.expiresAt <= Date.now() || p.expiresAt > Date.now() + 600000)
    throw new HttpError(
      409,
      'APPROVAL_EXPIRED',
      'Approval is expired or outside its maximum lifetime',
    );
  const { node, api } = await client(p.nodeId);
  validateResponsePolicy(p, node);
  if (p.operation === 'release') {
    const original = await db.cindertraceResponse.findUnique({
      where: { actionOperation: `${p.actionId}:execute` },
    });
    if (
      !original ||
      original.nodeId !== p.nodeId ||
      (JSON.parse(original.requestJson) as ResponseRequest).kind !== 'host_isolation'
    )
      throw new HttpError(
        409,
        'RELEASE_UNBOUND',
        'Release requires an existing isolation execution on this target',
      );
  }
  try {
    await db.cindertraceResponse.create({
      data: {
        id: p.executionId,
        actionOperation: `${p.actionId}:${p.operation}`,
        nodeId: p.nodeId,
        requestSha256: hash,
        requestJson: raw,
      },
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002')
      throw new HttpError(409, 'RESPONSE_ALREADY_CLAIMED', 'Action operation already has an owner');
    throw error;
  }
  await logAuditEvent({
    action: 'cindertrace.response_claimed',
    actorId: p.approvedBy,
    targetType: 'node',
    targetId: p.nodeId,
    details: {
      actionId: p.actionId,
      executionId: p.executionId,
      planSha256: p.planSha256,
      operation: p.operation,
    },
  });
  try {
    const result = await api.securityResponse(
      {
        operation: p.operation,
        kind: p.kind,
        serviceName: p.serviceName,
        isolationMinutes: p.isolationMinutes,
      },
      p.executionId,
    );
    if (!result.response.success || !Number.isInteger(result.response.data?.exitCode))
      throw new Error('Response failed');
    const reply = {
      commandId: p.executionId,
      actionId: p.actionId,
      nodeId: p.nodeId,
      operation: p.operation,
      planSha256: p.planSha256,
      exitCode: result.response.data.exitCode,
      receiptSha256: result.evidence.receiptSha256,
    };
    await db.cindertraceResponse.update({
      where: { id: p.executionId },
      data: { status: 'completed', responseJson: JSON.stringify(reply) },
    });
    return c.json(reply);
  } catch {
    await db.cindertraceResponse.update({
      where: { id: p.executionId },
      data: { status: 'unknown' },
    });
    throw new HttpError(
      409,
      'RESPONSE_UNKNOWN',
      'No verified completion; inspect the original execution',
    );
  }
});
cindertraceResponseRouter.get('/:id', async (c) => {
  const row = await getDb().cindertraceResponse.findUnique({ where: { id: c.req.param('id') } });
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Execution is unavailable');
  return c.json({
    executionId: row.id,
    status: row.status,
    result: row.responseJson ? (JSON.parse(row.responseJson) as unknown) : null,
  });
});
