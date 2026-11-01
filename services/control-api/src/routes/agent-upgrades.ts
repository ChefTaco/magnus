import { Hono } from 'hono';
import { z } from 'zod';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, getUser, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { upgradeSettings } from '../config/features.js';
import { AGENT_VERSION } from '../config/version.js';
import { getUpgradeRun, latestUpgradeRun, listUpgradeCandidates, startUpgradeRun } from '../services/agent-upgrade-service.js';

/** /api/v1/agents/upgrade: which agents can take a version, and fleet upgrade runs. */
export const agentUpgradesRouter = new Hono<AppVariables>();
agentUpgradesRouter.use('*', authMiddleware);

const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);

agentUpgradesRouter.get('/eligibility', async c => {
  const target = version.safeParse(c.req.query('version') ?? AGENT_VERSION);
  if (!target.success) throw new HttpError(400, 'INVALID_VERSION', 'version must be X.Y.Z');
  const nodes = await listUpgradeCandidates(target.data);
  return c.json({ success: true, data: {
    version: target.data, serverVersion: AGENT_VERSION, upgradesEnabled: upgradeSettings().agentUpgrades,
    disabledReason: upgradeSettings().agentUpgrades ? null : 'MAGNUS_AGENT_UPGRADES=false on the server',
    nodes, latestRun: await latestUpgradeRun(),
  } });
});

const startSchema = z.object({
  version: version.optional(),
  integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/).optional(),
  nodeIds: z.array(z.string().min(1).max(128)).max(1000).optional(),
}).strict();

agentUpgradesRouter.post('/', requireRole('ADMIN'), async c => {
  const parsed = startSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new HttpError(400, 'VALIDATION_ERROR', parsed.error.issues.map(issue => issue.message).join('; '));
  const { run } = await startUpgradeRun({ ...parsed.data, actorId: getUser(c).userId });
  return c.json({ success: true, data: run }, 202);
});

agentUpgradesRouter.get('/runs/latest', async c => c.json({ success: true, data: await latestUpgradeRun() }));

agentUpgradesRouter.get('/runs/:id', async c => {
  const run = await getUpgradeRun(c.req.param('id'));
  if (!run) throw new HttpError(404, 'NOT_FOUND', 'Upgrade run not found');
  return c.json({ success: true, data: run });
});
