/**
 * predictions.ts — Routes for predictive failure detection.
 *
 * GET  /predictions           — Fleet-wide predictions (nodes at risk)
 * GET  /predictions/:nodeId   — Predictions for a specific node
 */

import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware } from '../middleware/auth.js';
import { getNodePredictions, getFleetPredictions } from '../services/prediction-service.js';

export const predictionsRouter = new Hono<AppVariables>();

predictionsRouter.use('*', authMiddleware);

// ── Fleet-wide predictions ──
predictionsRouter.get('/', async (c) => {
  const result = await getFleetPredictions();
  return c.json({ success: true, data: result });
});

// ── Node-specific predictions ──
predictionsRouter.get('/:nodeId', async (c) => {
  const nodeId = c.req.param('nodeId')!;
  const predictions = await getNodePredictions(nodeId);
  return c.json({ success: true, data: { nodeId, predictions } });
});
