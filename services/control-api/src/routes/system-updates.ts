import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';
import { upgradeSettings } from '../config/features.js';
import { CONTROL_API_VERSION } from '../config/version.js';
import { agentFixCommand, agentVersionSkew, getUpdateCheck } from '../services/update-check-service.js';

/**
 * GET /api/v1/system/updates: available releases (MAGNUS_UPDATE_CHECK) and
 * agents running a different version than the server ships with.
 */
export const systemUpdatesRouter = new Hono<AppVariables>();
systemUpdatesRouter.use('*', authMiddleware);

async function report(refresh: boolean) {
  const [server, agents] = await Promise.all([getUpdateCheck({ refresh }), agentVersionSkew()]);
  const settings = upgradeSettings();
  return {
    version: CONTROL_API_VERSION,
    server,
    agents: {
      ...agents,
      upgradesEnabled: settings.agentUpgrades,
      fixCommand: agents.behind.length > 0 ? agentFixCommand(agents.behind.map(node => node.name)) : null,
    },
  };
}

systemUpdatesRouter.get('/', async c => c.json({ success: true, data: await report(false) }));
systemUpdatesRouter.post('/check', requireRole('ADMIN', 'OPERATOR'), async c => c.json({ success: true, data: await report(true) }));
