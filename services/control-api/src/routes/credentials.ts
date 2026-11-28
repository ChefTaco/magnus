import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, getUser, requireRole } from '../middleware/auth.js';
import { API_SECRET, NODE_MANAGER_SECRET } from '../utils/env.js';
import {
  getCredentialStatus,
  listActiveRotations,
  retirePreviousCredential,
  retireUnconfiguredPreviousCredential,
  unconfiguredCredentialStatus,
} from '../services/credential-rotation-service.js';
import { logAuditEvent } from '../services/audit-service.js';
import { HttpError } from '../middleware/error-handler.js';

export const credentialsRouter = new Hono<AppVariables>();

credentialsRouter.use('*', authMiddleware);
credentialsRouter.use('*', requireRole('ADMIN'));

/**
 * The server's value for each shared credential. NODE_MANAGER_SECRET is empty in node-key enforce
 * mode without one; the status and retire routes then report `configured: false`.
 */
const retirableCredentialFallbacks = {
  API_SECRET,
  NODE_MANAGER_SECRET,
} as const;

function credentialName(name: string): keyof typeof retirableCredentialFallbacks {
  if (!Object.prototype.hasOwnProperty.call(retirableCredentialFallbacks, name)) {
    throw new HttpError(400, 'UNKNOWN_CREDENTIAL', `Unknown credential: ${name}`);
  }
  return name as keyof typeof retirableCredentialFallbacks;
}

/** Initiate rotation of a named credential. */
credentialsRouter.post('/rotate', async (c) => {
  return c.json({
    success: false,
    error: { code: 'CREDENTIAL_ROTATION_RETIRED', message: 'Online credential rotation is retired; use the reviewed coordinated fleet rollout' },
  }, 410);
});

/** List active credential rotations. */
credentialsRouter.get('/rotations', (c) => {
  return c.json({ success: true, data: listActiveRotations(retirableCredentialFallbacks) });
});

credentialsRouter.get('/:name/status', (c) => {
  const name = credentialName(c.req.param('name'));
  const value = retirableCredentialFallbacks[name];
  return c.json({ success: true, data: value ? getCredentialStatus(name, value) : unconfiguredCredentialStatus(name) });
});

credentialsRouter.post('/:name/rollout', async (c) => {
  return c.json({
    success: false,
    error: { code: 'CREDENTIAL_ROLLOUT_RETIRED', message: 'Online fleet secret rollout is retired; use the inventory-pinned deploy-agent workflow' },
  }, 410);
});

credentialsRouter.post('/:name/retire-previous', async (c) => {
  const user = getUser(c);
  const name = credentialName(c.req.param('name'));

  const value = retirableCredentialFallbacks[name];
  const result = value ? retirePreviousCredential(name, value) : retireUnconfiguredPreviousCredential(name);
  await logAuditEvent({
    action: 'credentials.rotate',
    actorId: user.userId,
    targetType: 'credential',
    targetId: name,
    details: {
      name,
      operation: 'retire-previous',
      configured: result.configured,
      activeFingerprint: result.activeFingerprint,
      retiredPreviousFingerprint: result.retiredPreviousFingerprint,
    },
  });

  return c.json({ success: true, data: result });
});
