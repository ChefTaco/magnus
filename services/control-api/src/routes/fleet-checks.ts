import { optional } from '../utils/optional.js';
import { intQuery } from '../utils/query.js';
import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  getLatestFleetCheckRun,
  listFleetCheckLogFiles,
  listFleetCheckRuns,
} from '../services/fleet-check-log.js';

export const fleetChecksRouter = new Hono<AppVariables>();

fleetChecksRouter.use('*', authMiddleware);

fleetChecksRouter.get('/runs', async (c) => {
  const limit = intQuery(c, 'limit', { fallback: 20, min: 1, max: 200 });
  const kind = c.req.query('kind') || undefined;
  const result = await listFleetCheckRuns({ limit, ...optional("kind", kind) });
  return c.json({ success: true, data: result });
});

fleetChecksRouter.get('/latest', async (c) => {
  const kind = c.req.query('kind') || undefined;
  const result = await getLatestFleetCheckRun(kind);
  return c.json({ success: true, data: result });
});

fleetChecksRouter.get('/files', async (c) => {
  const result = await listFleetCheckLogFiles();
  return c.json({ success: true, data: result });
});
