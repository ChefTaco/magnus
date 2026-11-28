import { SENTINEL_NODE_IDS } from '../utils/sentinel-nodes.js';
import { securityInventoryTargetSchema, type SecurityInventorySkipped, type SecurityInventoryTarget } from '@hivemagnus/magnus-contracts';
import { Hono } from 'hono';
import { getDb } from '../db/index.js';
import { authMiddleware, requirePermission } from '../middleware/auth.js';
import { matchesSha256Digest } from '@hivemagnus/hive-common/secrets';
import { getNodeBaseUrl } from '../utils/node-url.js';
import type { AppVariables } from '../types/index.js';
export const securityIntegrationRouter = new Hono<AppVariables>();
securityIntegrationRouter.get('/inventory', async (c) => {
  const token = c.req.header('Authorization')?.replace(/^Bearer /, '') ?? '';
  const expected = process.env['SECURITY_INVENTORY_TOKEN_SHA256'];
  if (!matchesSha256Digest(token, expected))
    return c.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401);
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
  // A node that is not a valid target (no agent TLS, or a blank name) is listed in `skipped`
  // instead of failing the whole export.
  const data: SecurityInventoryTarget[] = [];
  const skipped: SecurityInventorySkipped[] = [];
  for (const n of nodes) {
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(n.metadata);
    } catch {}
    const baseUrl = getNodeBaseUrl(n.ipAddress, n.port);
    const parsed = securityInventoryTargetSchema.safeParse({
      id: n.id,
      name: n.name,
      hostname: n.hostname,
      baseUrl,
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
    if (parsed.success) data.push(parsed.data);
    else skipped.push({ id: n.id, name: n.name, reason: baseUrl.startsWith('https://') ? 'invalid_target' : 'agent_tls_required' });
  }
  return c.json({ success: true, data, skipped });
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
