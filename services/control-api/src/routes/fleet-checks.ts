import { optional } from '../utils/optional.js';
import { intQuery } from '../utils/query.js';
import { Hono, type Context } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, getUser } from '../middleware/auth.js';
import {
  getLatestFleetCheckRun,
  listFleetCheckLogFiles,
  listFleetCheckRuns,
} from '../services/fleet-check-log.js';

export const fleetChecksRouter = new Hono<AppVariables>();

fleetChecksRouter.use('*', authMiddleware);

/** The server's log directory is a host path: only an ADMIN sees it. */
function forRole<T extends { directory: string }>(c: Context<AppVariables>, result: T): T | Omit<T, 'directory'> {
  if (getUser(c).role === 'ADMIN') return result;
  const { directory, ...rest } = result;
  void directory;
  return rest;
}

fleetChecksRouter.get('/runs', async (c) => {
  const limit = intQuery(c, 'limit', { fallback: 20, min: 1, max: 200 });
  const kind = c.req.query('kind') || undefined;
  const result = await listFleetCheckRuns({ limit, ...optional("kind", kind) });
  return c.json({ success: true, data: forRole(c, result) });
});

fleetChecksRouter.get('/latest', async (c) => {
  const kind = c.req.query('kind') || undefined;
  const result = await getLatestFleetCheckRun(kind);
  return c.json({ success: true, data: forRole(c, result) });
});

fleetChecksRouter.get('/files', async (c) => {
  const result = await listFleetCheckLogFiles();
  return c.json({ success: true, data: forRole(c, result) });
});
