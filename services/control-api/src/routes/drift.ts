import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import ky from 'ky';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, requireRole, getUser } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';
import { getNodeManagerSecret } from '../utils/env.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { logAuditEvent } from '../services/audit-service.js';

export const driftRouter = new Hono<AppVariables>();
driftRouter.use('*', authMiddleware);

interface DriftCheckDef {
  type: 'package' | 'file' | 'service' | 'sysctl' | 'user';
  name: string;
  expected: string;
}

/**
 * POST /drift/scan
 * Trigger a drift scan on a specific node.
 * Body: { nodeId: string, checks: [...] }
 */
driftRouter.post('/scan', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const user = getUser(c);
  const body = await c.req.json() as { nodeId: string; checks: DriftCheckDef[] };

  if (!body.nodeId) throw new HttpError(400, 'VALIDATION_ERROR', 'nodeId is required');
  if (!body.checks?.length) throw new HttpError(400, 'VALIDATION_ERROR', 'checks array is required');

  const db = getDb();
  const node = await db.node.findUnique({ where: { id: body.nodeId } });
  if (!node) throw new HttpError(404, 'NOT_FOUND', 'Node not found');

  // Use the node's recorded endpoint, like every other agent call.
  const agentUrl = `${getNodeBaseUrl(node.ipAddress, node.port)}/api/v1/drift/scan`;

  let agentResponse: { status: string; findings: unknown[]; driftCount: number };

  try {
    const res = await ky.post(agentUrl, {
      json: { checks: body.checks },
      headers: { 'x-node-token': getNodeManagerSecret() },
      timeout: 30_000,
    }).json() as { data: typeof agentResponse };

    agentResponse = res.data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Store error scan
    const scan = await db.driftScan.create({
      data: {
        id: nanoid(),
        nodeId: body.nodeId,
        status: 'error',
        findings: JSON.stringify([{ error: msg }]),
      },
    });

    return c.json({ success: true, data: { scan, error: msg } });
  }

  // Store scan results
  const scan = await db.driftScan.create({
    data: {
      id: nanoid(),
      nodeId: body.nodeId,
      status: agentResponse.status,
      findings: JSON.stringify(agentResponse.findings),
    },
  });

  await logAuditEvent({
    action: 'drift.scan',
    actorId: user.userId,
    targetType: 'node',
    targetId: body.nodeId,
    details: { status: agentResponse.status, driftCount: agentResponse.driftCount },
  });

  return c.json({
    success: true,
    data: {
      id: scan.id,
      nodeId: scan.nodeId,
      status: scan.status,
      findings: agentResponse.findings,
      scannedAt: scan.scannedAt,
    },
  });
});

/**
 * GET /drift/:nodeId
 * Get drift scan history for a node.
 */
driftRouter.get('/:nodeId', async (c) => {
  const db = getDb();
  const nodeId = c.req.param('nodeId');

  const scans = await db.driftScan.findMany({
    where: { nodeId },
    orderBy: { scannedAt: 'desc' },
    take: 20,
  });

  return c.json({
    success: true,
    data: scans.map((s) => ({
      id: s.id,
      nodeId: s.nodeId,
      status: s.status,
      findings: JSON.parse(s.findings),
      scannedAt: s.scannedAt,
    })),
  });
});

/**
 * GET /drift/:nodeId/latest
 * Get the latest drift scan for a node.
 */
driftRouter.get('/:nodeId/latest', async (c) => {
  const db = getDb();
  const nodeId = c.req.param('nodeId');

  const scan = await db.driftScan.findFirst({
    where: { nodeId },
    orderBy: { scannedAt: 'desc' },
  });

  if (!scan) throw new HttpError(404, 'NOT_FOUND', 'No drift scans found for this node');

  return c.json({
    success: true,
    data: {
      id: scan.id,
      nodeId: scan.nodeId,
      status: scan.status,
      findings: JSON.parse(scan.findings),
      scannedAt: scan.scannedAt,
    },
  });
});
