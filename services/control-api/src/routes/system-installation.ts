import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';
import { installationReport } from '../services/installation-report-service.js';

/**
 * GET /api/v1/system/installation: this server's version, Node.js and install layout, and every
 * runtime dependency whose installed version differs from the npm-shrinkwrap.json the package
 * shipped with. ADMIN only: dependency versions tell an attacker what to try.
 */
export const systemInstallationRouter = new Hono<AppVariables>();
systemInstallationRouter.use('*', authMiddleware);

systemInstallationRouter.get('/', requireRole('ADMIN'), c => {
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, data: installationReport() });
});
