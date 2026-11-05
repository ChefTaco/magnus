import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, getUser } from '../middleware/auth.js';
import { AGENT_VERSION, CONTROL_API_VERSION } from '../config/version.js';
import { featureFlags } from '../config/features.js';
import { securityConsoleUrl } from '../services/security-export.js';

export const consoleRouter = new Hono<AppVariables>();

consoleRouter.use('*', authMiddleware);

/**
 * GET /console/session
 * What a browser console may show this caller. A static page has no server of its
 * own to read the environment, so this answers what the dashboard derives from
 * server-side checks and build-time public values.
 */
consoleRouter.get('/session', (c) => {
  const user = getUser(c);
  c.header('Cache-Control', 'no-store');
  return c.json({
    success: true,
    data: {
      userId: user.userId,
      role: user.role,
      capabilities: {
        hermes: featureFlags().hermes,
        agentVersion: AGENT_VERSION,
        magnusVersion: CONTROL_API_VERSION,
        securityConsoleUrl: securityConsoleUrl() ?? null,
      },
    },
  });
});
