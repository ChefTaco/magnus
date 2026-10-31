import { SENTINEL_NODE_IDS } from '../utils/sentinel-nodes.js';
import { securityInventoryTargetSchema } from '@hivemagnus/magnus-contracts';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { getDb } from '../db/index.js';
import { safeEqual, authMiddleware, requirePermission } from '../middleware/auth.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import type { AppVariables } from '../types/index.js';
export const securityIntegrationRouter = new Hono<AppVariables>();
securityIntegrationRouter.get('/inventory', async (c) => {
  const token = c.req.header('Authorization')?.replace(/^Bearer /, '') ?? '';
  const expected = process.env['SECURITY_INVENTORY_TOKEN_SHA256'];
  if (!expected || !token || !safeEqual(createHash('sha256').update(token).digest('hex'), expected))
    return c.json({ error: 'Unauthorized' }, 401);
  const nodes = await getDb().node.findMany({
    where: {id: {notIn: SENTINEL_NODE_IDS}, agent: {isNot: null}},
    select: {
      id: true,
      name: true,
      hostname: true,
      ipAddress: true,
      port: true,
      tags: true,
      metadata: true,
    },
  });
  return c.json({
    success: true,
    data: nodes.map((n) => {
      let metadata: Record<string, unknown> = {};
      try {
        metadata = JSON.parse(n.metadata);
      } catch {}
      return securityInventoryTargetSchema.parse({
        id: n.id,
        name: n.name,
        hostname: n.hostname,
        baseUrl: getNodeBaseUrl(n.ipAddress, n.port),
        tags: n.tags,
        metadata: JSON.stringify(
          Object.fromEntries(
            [
              'securityIsolationPolicy',
              'securityIsolationCapable',
              'securityAegisChannelVerified',
            ].map((k) => [k, metadata[k]]),
          ),
        ),
      });
    }),
  });
});
securityIntegrationRouter.get(
  '/summary',
  authMiddleware,
  requirePermission('security-fusion:read'),
  async (c) => {
    try {
      const url = process.env['SECURITY_FUSION_API_URL'];
      if (!url || new URL(url).protocol !== 'https:') throw new Error('not configured');
      const res = await fetch(`${url}/api/v1/security-fusion/summary`, {
        headers: { Authorization: `Bearer ${process.env['SECURITY_SUMMARY_TOKEN']}` },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error('unavailable');
      const body = await res.json();
      return c.json(body);
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'SECURITY_UNAVAILABLE', message: 'The external security console is unavailable' },
        },
        503,
      );
    }
  },
);
