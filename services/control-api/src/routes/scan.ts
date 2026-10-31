import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { getDb } from '../db/index.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { getNodeManagerSecret } from '../utils/env.js';
import { NodeApiClient } from '../sdk/node-api-client.js';
import { SENTINEL_NODE_IDS } from '../utils/sentinel-nodes.js';

export const scanRouter = new Hono<AppVariables>();
scanRouter.use('*', authMiddleware);

/**
 * Scan all online nodes for installed skills.
 * Contacts each node-manager agent's GET /skills endpoint in parallel.
 */
scanRouter.post('/skills', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb();
  const nodes = await db.node.findMany({
    where: { status: 'ONLINE', id: { notIn: SENTINEL_NODE_IDS } },
    select: { id: true, name: true, ipAddress: true, port: true },
  });

  const results = await Promise.allSettled(
    nodes.map(async (node) => {
      const client = new NodeApiClient({
        baseUrl: getNodeBaseUrl(node.ipAddress, node.port),
        resourceNodeId: node.id,
        nodeToken: getNodeManagerSecret(),
        timeout: 15_000,
      });

      try {
        const res = await client.listSkills();

        return {
          nodeId: node.id,
          nodeName: node.name,
          status: 'done' as const,
          skills: res.data ?? [],
        };
      } catch (err: unknown) {
        return {
          nodeId: node.id,
          nodeName: node.name,
          status: 'error' as const,
          skills: [],
          error: err instanceof Error ? err.message : 'Unknown error',
        };
      }
    }),
  );

  const data = results.map((r) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          nodeId: 'unknown',
          nodeName: 'unknown',
          status: 'error' as const,
          skills: [],
          error: r.reason instanceof Error ? r.reason.message : 'Unknown error',
        },
  );

  return c.json({ success: true, data });
});

/**
 * Scan all online nodes for cron jobs across all system users.
 * Contacts each node-manager agent's GET /cron/all-users endpoint in parallel.
 */
scanRouter.post('/cron', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const db = getDb();
  const nodes = await db.node.findMany({
    where: { status: 'ONLINE', id: { notIn: SENTINEL_NODE_IDS } },
    select: { id: true, name: true, ipAddress: true, port: true },
  });

  const results = await Promise.allSettled(
    nodes.map(async (node) => {
      const client = new NodeApiClient({
        baseUrl: getNodeBaseUrl(node.ipAddress, node.port),
        resourceNodeId: node.id,
        nodeToken: getNodeManagerSecret(),
        timeout: 15_000,
      });

      try {
        const res = await client.listAllUserCronJobs();

        return {
          nodeId: node.id,
          nodeName: node.name,
          status: 'done' as const,
          jobs: res.data ?? [],
        };
      } catch (err: unknown) {
        // Fallback to old endpoint if agent hasn't been updated yet
        try {
          const fallback = await client.listCronJobs();
          return {
            nodeId: node.id,
            nodeName: node.name,
            status: 'done' as const,
            jobs: (fallback.data ?? []).map((j) => ({ ...j, user: 'root' })),
          };
        } catch {
          return {
            nodeId: node.id,
            nodeName: node.name,
            status: 'error' as const,
            jobs: [],
            error: err instanceof Error ? err.message : 'Unknown error',
          };
        }
      }
    }),
  );

  const data = results.map((r) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          nodeId: 'unknown',
          nodeName: 'unknown',
          status: 'error' as const,
          jobs: [],
          error: r.reason instanceof Error ? r.reason.message : 'Unknown error',
        },
  );

  return c.json({ success: true, data });
});
