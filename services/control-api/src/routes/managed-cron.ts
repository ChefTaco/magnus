/** Node credentials may consume existing authority, never create a cron definition. */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { assertNodeClaims, nodeAuth } from '../middleware/node-auth.js';
import { parseBody } from '../utils/validate.js';
import { admitCronOccurrence, cronOccurrenceStatus, settleCronOccurrence, schedulerTriggerSchema, schedulerSettleSchema } from '../services/managed-cron.js';
export const managedCronRouter = new Hono();
// Every body names its node as `nodeFqdn`; it is bound to the caller before the service resolves it.
managedCronRouter.use('*', nodeAuth());
async function nodeBody<T extends { nodeFqdn: string }>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const body: T = await parseBody(c, schema);
  await assertNodeClaims(c, { fqdn: body.nodeFqdn });
  return body;
}
managedCronRouter.post('/admit', async c => c.json({ success: true, data: await admitCronOccurrence(await nodeBody(c, schedulerTriggerSchema)) }));
managedCronRouter.post('/settle', async c => c.json({ success: true, data: await settleCronOccurrence(await nodeBody(c, schedulerSettleSchema)) }));
managedCronRouter.post('/status', async c => {
  const body = await nodeBody(c, z.object({ nodeFqdn: z.string().min(1).max(253), occurrenceId: z.string().regex(/^[a-f0-9]{64}$/) }).strict());
  return c.json({ success: true, data: await cronOccurrenceStatus(body.nodeFqdn, body.occurrenceId) });
});
