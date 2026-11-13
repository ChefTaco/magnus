/** Agent-facing routes of per-node credentials: binding a key, rotating it, and the server key agents pin. */
import { Hono } from 'hono';
import { z } from 'zod';
import { HttpError } from '../middleware/error-handler.js';
import { authenticateNode } from '../middleware/node-auth.js';
import { verifyWithRotation } from '../services/credential-rotation-service.js';
import { nodeAuthMode } from '../services/node-auth-config.js';
import { enrollWithToken, legacyUpgrade, legacyUpgradeWindow, rotateCredential } from '../services/node-credential-service.js';
import { serverPublicKeys } from '../services/node-server-key.js';
import { NODE_MANAGER_SECRET } from '../utils/env.js';
import { heartbeatPeerAddress } from '../utils/heartbeat-peer.js';
import { parseBody } from '../utils/validate.js';

const proofSchema = z.object({ timestamp: z.string().regex(/^[1-9][0-9]{12,13}$/), nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
const keySchema = z.string().regex(/^[A-Za-z0-9+/]{59}=$/);
const fqdnSchema = z.string().min(1).max(253);
export const legacyUpgradeRequestSchema = z.object({ fqdn: fqdnSchema, publicKey: keySchema, proof: proofSchema }).strict();
export const enrollRequestSchema = z.object({ token: z.string().regex(/^mne_[A-Za-z0-9_-]{43}$/), fqdn: fqdnSchema, publicKey: keySchema, proof: proofSchema }).strict();
export const rotateRequestSchema = z.object({ fqdn: fqdnSchema, publicKey: keySchema, proof: proofSchema }).strict();

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
