import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware } from '../middleware/auth.js';

/**
 * Browser-driven deployment is retired. The previous implementation accepted
 * reusable SSH passwords, issued invalid shared-host certificates, omitted
 * Result/log credentials, and treated systemd "active" as rollout success.
 * Reviewed key-only scripts are the sole production deployment interface.
 */
export const deployRouter = new Hono<AppVariables>();
deployRouter.use('*', authMiddleware);
deployRouter.all('*', (c) => c.json({
  success: false,
  error: {
    code: 'DEPLOYMENT_PATH_RETIRED',
    message: 'Legacy API-driven deployment is retired; use the reviewed key-only deployment scripts.',
  },
}, 410));
