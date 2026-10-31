/** Node credentials may consume existing authority, never create a cron definition. */
import { Hono } from 'hono';
import { z } from 'zod';
import { HttpError } from '../middleware/error-handler.js';
import { NODE_MANAGER_SECRET } from '../utils/env.js';
import { verifyWithRotation } from '../services/credential-rotation-service.js';
import { parseBody } from '../utils/validate.js';
import { admitCronOccurrence, cronOccurrenceStatus, settleCronOccurrence, schedulerTriggerSchema, schedulerSettleSchema } from '../services/managed-cron.js';
export const managedCronRouter = new Hono();
managedCronRouter.use('*', async (c, next) => {
  const token = c.req.header('x-node-token') ?? '';
  if (!token || !NODE_MANAGER_SECRET || !verifyWithRotation('NODE_MANAGER_SECRET', NODE_MANAGER_SECRET, token)) throw new HttpError(401, 'UNAUTHORIZED', 'Node credential required');
  c.header('Cache-Control', 'no-store'); await next();
});
managedCronRouter.post('/admit', async c => c.json({ success: true, data: await admitCronOccurrence(await parseBody(c, schedulerTriggerSchema)) }));
managedCronRouter.post('/settle', async c => c.json({ success: true, data: await settleCronOccurrence(await parseBody(c, schedulerSettleSchema)) }));
managedCronRouter.post('/status', async c => {
  const body = await parseBody(c, z.object({ nodeFqdn: z.string().min(1).max(253), occurrenceId: z.string().regex(/^[a-f0-9]{64}$/) }).strict());
  return c.json({ success: true, data: await cronOccurrenceStatus(body.nodeFqdn, body.occurrenceId) });
});
