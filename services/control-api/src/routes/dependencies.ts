/**
 * dependencies.ts — Node dependency mapping routes.
 *
 * GET  /dependencies          — cached dependency graph
 * POST /dependencies/scan     — force fresh dependency scan
 */

import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, getUser, requireRole } from '../middleware/auth.js';
import { buildDependencyGraph, type DependencyGraph } from '../services/dependency-service.js';

export const dependenciesRouter = new Hono<AppVariables>();

dependenciesRouter.use('*', authMiddleware);

// ── In-memory cache (10 min TTL) ──
let cachedGraph: DependencyGraph | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * GET /dependencies
 * Return the current dependency graph (cached for 10 min).
 */
dependenciesRouter.get('/', async (c) => {
  if (!cachedGraph || Date.now() > cacheExpiry) {
    cachedGraph = await buildDependencyGraph();
    cacheExpiry = Date.now() + CACHE_TTL_MS;
  }
  // The plugin read credential may observe topology, but never receives node
  // IPs, process names, PIDs, or port-level connection details.
  if (getUser(c).userId.startsWith('service:magnus-plugin-read:')) {
    return c.json({ success: true, data: {
      discoveredAt: cachedGraph.discoveredAt,
      status: cachedGraph.status,
      nodes: cachedGraph.nodes.map(({ id, name, collection }) => ({ id, name, collection: {
        status: collection.status, observedAt: collection.observedAt,
        reason: collection.status === 'unknown' ? 'collection_unavailable' : null,
      } })),
      edges: cachedGraph.edges.map(({ from, to, service, connectionCount }) =>
        ({ from, to, service, connectionCount })),
    } });
  }
  return c.json({ success: true, data: cachedGraph });
});

/**
 * POST /dependencies/scan
 * Force a fresh dependency scan.
 */
dependenciesRouter.post('/scan', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  cachedGraph = await buildDependencyGraph();
  cacheExpiry = Date.now() + CACHE_TTL_MS;
  return c.json({ success: true, data: cachedGraph });
});
