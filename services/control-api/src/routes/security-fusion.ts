import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { securityConsoleUrl, securityFusionMode } from '../services/security-export.js';
import type { AppVariables } from '../types/index.js';
/** Compatibility only. Security state and effects belong to Cindertrace. */
export const securityFusionRouter = new Hono<AppVariables>();
securityFusionRouter.use('*', async (c, next) => {
  if (securityFusionMode() === 'off') return c.notFound();
  await next();
});
securityFusionRouter.use('*', authMiddleware);
securityFusionRouter.all('*', (c) =>
  c.json(
    {
      success: false,
      error: {
        code: 'SECURITY_FUSION_MOVED',
        message: 'Security Fusion is now Cindertrace',
        ...(securityConsoleUrl() ? { url: securityConsoleUrl() } : {}),
      },
    },
    410,
  ),
);
