/** Agent-facing routes of per-node credentials: binding a key, rotating it, and the server key agents pin. */
import { Hono } from 'hono';
import { HttpError } from '../middleware/error-handler.js';
import { authenticateNode } from '../middleware/node-auth.js';
import { verifyWithRotation } from '../services/credential-rotation-service.js';
import { nodeAuthMode } from '../services/node-auth-config.js';
import { enrollWithToken, legacyUpgrade, legacyUpgradeWindow, rotateCredential } from '../services/node-credential-service.js';
import { serverPublicKeys } from '../services/node-server-key.js';
import { NODE_MANAGER_SECRET } from '../utils/env.js';
import { heartbeatPeerAddress } from '../utils/heartbeat-peer.js';
import { parseBody } from '../utils/validate.js';
import { enrollRequestSchema, legacyUpgradeRequestSchema, rotateRequestSchema } from '../schemas/node-enrollment.js';

export const nodeEnrollmentRouter = new Hono();
nodeEnrollmentRouter.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('x-magnus-server-time', String(Date.now()));
  await next();
});

/**
 * Public: the keys agents pin and the state of the migration. Agents read it over the same
 * verified TLS connection they send their credentials on.
 */
nodeEnrollmentRouter.get('/server-key', async c => c.json({ success: true, data: {
  keys: serverPublicKeys(), mode: nodeAuthMode(), legacyUpgrade: await legacyUpgradeWindow() } }));

nodeEnrollmentRouter.post('/legacy-upgrade', async c => {
  // Closed in enforce mode whatever the window says, before any credential is looked at: the shared
  // node secret binds nothing any more, and an agent learns to enroll with a token instead.
  if (nodeAuthMode() === 'enforce')
    throw new HttpError(410, 'LEGACY_UPGRADE_CLOSED', 'The automatic upgrade of existing nodes is closed (NODE_AUTH_MODE=enforce); enroll this node with a token');
  const token = c.req.header('x-node-token') ?? '';
  if (!token || !NODE_MANAGER_SECRET || !verifyWithRotation('NODE_MANAGER_SECRET', NODE_MANAGER_SECRET, token))
    throw new HttpError(401, 'UNAUTHORIZED', 'Node credential required');
  const body = await parseBody(c, legacyUpgradeRequestSchema);
  return c.json({ success: true, data: await legacyUpgrade({ ...body, peerAddress: heartbeatPeerAddress(c) }) });
});

nodeEnrollmentRouter.post('/enroll', async c => {
  const body = await parseBody(c, enrollRequestSchema);
  return c.json({ success: true, data: await enrollWithToken({ ...body, peerAddress: heartbeatPeerAddress(c) }) });
});

nodeEnrollmentRouter.post('/rotate', async c => {
  const auth = await authenticateNode(c);
  if (auth.method !== 'signature') throw new HttpError(401, 'NODE_SIGNATURE_REQUIRED', 'A key is rotated with a request signed by the key it replaces');
  const body = await parseBody(c, rotateRequestSchema);
  return c.json({ success: true, data: await rotateCredential({ node: auth.node, currentKeyId: auth.keyId, boundFqdn: auth.boundFqdn, ...body }) });
});
