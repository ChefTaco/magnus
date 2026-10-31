/**
 * topology.ts — Fleet topology discovery routes.
 *
 * GET  /topology         — cached topology map
 * POST /topology/scan    — trigger fresh scan
 */

import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';
import { scanTopology, type TopologyMap } from '../services/topology-service.js';

export const topologyRouter = new Hono<AppVariables>();

topologyRouter.use('*', authMiddleware);

// ── In-memory cache (5 min TTL) ──
let cachedTopology: TopologyMap | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * GET /topology
 * Return the current topology map (cached for 5 min).
 */
topologyRouter.get('/', async (c) => {
  if (!cachedTopology || Date.now() > cacheExpiry) {
    cachedTopology = await scanTopology();
    cacheExpiry = Date.now() + CACHE_TTL_MS;
  }
  return c.json({ success: true, data: cachedTopology });
});

/**
 * POST /topology/scan
 * Force a fresh topology scan (invalidates cache).
 */
topologyRouter.post('/scan', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const body = await c.req.json<{ probeTimeoutMs?: number }>().catch(() => ({} as { probeTimeoutMs?: number }));
  cachedTopology = await scanTopology(body.probeTimeoutMs ?? 3000);
  cacheExpiry = Date.now() + CACHE_TTL_MS;
  return c.json({ success: true, data: cachedTopology });
});
