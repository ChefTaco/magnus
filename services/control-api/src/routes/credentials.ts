import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, getUser, requireRole } from '../middleware/auth.js';
import { API_SECRET, NODE_MANAGER_SECRET } from '../utils/env.js';
import {
  getCredentialStatus,
  listActiveRotations,
  retirePreviousCredential,
} from '../services/credential-rotation-service.js';
import { logAuditEvent } from '../services/audit-service.js';

export const credentialsRouter = new Hono<AppVariables>();

credentialsRouter.use('*', authMiddleware);
credentialsRouter.use('*', requireRole('ADMIN'));

const retirableCredentialFallbacks = {
  API_SECRET,
  NODE_MANAGER_SECRET,
} as const;

/** Initiate rotation of a named credential. */
credentialsRouter.post('/rotate', async (c) => {
  return c.json({
    success: false,
    error: 'Online credential rotation is retired; use the reviewed coordinated fleet rollout',
  }, 410);
});

/** List active credential rotations. */
credentialsRouter.get('/rotations', (c) => {
  return c.json({ success: true, data: listActiveRotations() });
});

credentialsRouter.get('/:name/status', (c) => {
  const name = c.req.param('name') as keyof typeof retirableCredentialFallbacks;
  if (!Object.prototype.hasOwnProperty.call(retirableCredentialFallbacks, name)) {
    return c.json({ success: false, error: `Unknown credential: ${name}` }, 400);
  }
  return c.json({ success: true, data: getCredentialStatus(name, retirableCredentialFallbacks[name] ?? '') });
});

credentialsRouter.post('/:name/rollout', async (c) => {
  return c.json({
    success: false,
    error: 'Online fleet secret rollout is retired; use the inventory-pinned deploy-agent workflow',
  }, 410);
});

credentialsRouter.post('/:name/retire-previous', async (c) => {
  const user = getUser(c);
  const name = c.req.param('name') as keyof typeof retirableCredentialFallbacks;
  if (!Object.prototype.hasOwnProperty.call(retirableCredentialFallbacks, name)) {
    return c.json({ success: false, error: `Unknown credential: ${name}` }, 400);
  }

  const result = retirePreviousCredential(name, retirableCredentialFallbacks[name] ?? '');
  await logAuditEvent({
    action: 'credentials.rotate',
    actorId: user.userId,
    targetType: 'credential',
    targetId: name,
    details: {
      name,
      operation: 'retire-previous',
      activeFingerprint: result.activeFingerprint,
      retiredPreviousFingerprint: result.retiredPreviousFingerprint,
    },
  });

  return c.json({ success: true, data: result });
});
