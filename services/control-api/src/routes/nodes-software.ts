/** Authenticated node metadata read. Never dispatch a generic command as a fallback. */
import { Hono } from 'hono';
import { getDb } from '../db/index.js';
import { NodeApiClient } from '../sdk/node-api-client.js';
import { HttpError } from '../middleware/error-handler.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { getNodeManagerSecret } from '../utils/env.js';

export const nodeSoftwareRouter = new Hono();
nodeSoftwareRouter.get('/:nodeId/software', async c => {
  const node = await getDb().node.findUnique({ where: { id: c.req.param('nodeId')! } });
  if (!node) throw new HttpError(404, 'NOT_FOUND', 'Node not found');
  if (node.status !== 'ONLINE') throw new HttpError(409, 'INVALID_STATE', 'The node must be online to read software metadata');
  const client = new NodeApiClient({ baseUrl: getNodeBaseUrl(node.ipAddress, node.port), resourceNodeId: node.id,
    nodeToken: getNodeManagerSecret(), timeout: 5000 });
  return c.json(await client.softwareStatus());
});
