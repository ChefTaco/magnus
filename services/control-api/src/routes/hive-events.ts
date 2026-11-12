import { Hono } from 'hono';
import { HiveError } from '@hivemagnus/hive-common/errors';
import { parseFeedQuery, type FeedQuery } from '@hivemagnus/hive-common/events';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, getUser } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { listHiveEvents } from '../services/hive-events.js';

/**
 * The HiveEvent v1 feed, mounted at /api/v1/hive/events. Any role may read it, as it may read
 * notifications; Ardent notifications stay ADMIN-only, as on the Ardent routes. A linked service
 * identity cannot reach it.
 */
export const hiveEventsRouter = new Hono<AppVariables>();

hiveEventsRouter.use('*', authMiddleware);

hiveEventsRouter.get('/', async (c) => {
  let query: FeedQuery;
  try {
    query = parseFeedQuery(new URL(c.req.url).searchParams);
  } catch (error) {
    if (error instanceof HiveError) throw new HttpError(400, 'VALIDATION_ERROR', error.message);
    throw error;
  }
  const page = await listHiveEvents({ ...query, access: { ardent: getUser(c).role === 'ADMIN' } });
  return c.json(page);
});
