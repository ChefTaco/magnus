import { Hono } from 'hono';
import { z } from 'zod';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, getUser, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { upgradeSettings } from '../config/features.js';
import { AGENT_VERSION } from '../config/version.js';
import { checkUpgrade, getUpgradeRun, isPrerelease, latestUpgradeRun, listUpgradeCandidates, retryUpgradeRun, startUpgradeRun, stopUpgradeRun,
  verifyAgentRelease, withCachedPreflight } from '../services/agent-upgrade-service.js';

/** /api/v1/agents/upgrade: which agents can take a version, and fleet upgrade runs. */
export const agentUpgradesRouter = new Hono<AppVariables>();
agentUpgradesRouter.use('*', authMiddleware);

const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const nodeId = z.string().min(1).max(128);
const maxFailures = z.number().int().min(1).max(1000);

agentUpgradesRouter.get('/eligibility', async c => {
  const target = version.safeParse(c.req.query('version') ?? AGENT_VERSION);
  if (!target.success) throw new HttpError(400, 'INVALID_VERSION', 'version must be X.Y.Z');
  const [nodes, release, latestRun] = await Promise.all([
    listUpgradeCandidates(target.data, undefined, { allowRetryReverted: c.req.query('allowRetryReverted') === 'true' }),
    verifyAgentRelease(target.data), latestUpgradeRun()]);
  return c.json({ success: true, data: {
    version: target.data, serverVersion: AGENT_VERSION, upgradesEnabled: upgradeSettings().agentUpgrades,
    disabledReason: upgradeSettings().agentUpgrades ? null : 'MAGNUS_AGENT_UPGRADES=false on the server',
    prerelease: isPrerelease(target.data), release,
    // Reports hold paths, fences and command ids: only the role that can run upgrades sees them.
    nodes: getUser(c).role === 'ADMIN' ? withCachedPreflight(nodes, target.data) : nodes.map(({ preflight: _preflight, ...node }) => node), latestRun,
  } });
});

const startSchema = z.object({
  version: version.optional(),
  integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/).optional(),
  nodeIds: z.array(nodeId).min(1, 'nodeIds must name at least one node; leave it out for every eligible agent').max(1000).optional(),
  canaryNodeId: nodeId.optional(),
  allowPrerelease: z.boolean().optional(),
  allowRetryReverted: z.boolean().optional(),
  /** Report on every selected node and start nothing: the console's Check action. */
  dryRun: z.boolean().optional(),
  maxFailures: maxFailures.optional(),
}).strict();

const parseBody = async <T extends z.ZodType>(schema: T, raw: unknown): Promise<z.infer<T>> => {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'VALIDATION_ERROR', parsed.error.issues.map(issue => issue.message).join('; '));
  return parsed.data;
};

agentUpgradesRouter.post('/', requireRole('ADMIN'), async c => {
  const body = await parseBody(startSchema, await c.req.json().catch(() => ({})));
  const { dryRun, ...options } = body;
  if (dryRun) return c.json({ success: true, data: { dryRun: true, ...await checkUpgrade(options) } });
  const { run } = await startUpgradeRun({ ...options, actorId: getUser(c).userId });
  return c.json({ success: true, data: run }, 202);
});

agentUpgradesRouter.get('/runs/latest', async c => c.json({ success: true, data: await latestUpgradeRun() }));

agentUpgradesRouter.get('/runs/:id', async c => {
  const run = await getUpgradeRun(c.req.param('id'));
  if (!run) throw new HttpError(404, 'NOT_FOUND', 'Upgrade run not found');
  return c.json({ success: true, data: run });
});

agentUpgradesRouter.post('/runs/:id/stop', requireRole('ADMIN'), async c =>
  c.json({ success: true, data: await stopUpgradeRun(c.req.param('id')!, getUser(c).userId) }, 202));

const retrySchema = z.object({
  canaryNodeId: nodeId.optional(),
  allowRetryReverted: z.boolean().optional(),
  maxFailures: maxFailures.optional(),
  acknowledgeSuspicion: z.boolean().optional(),
}).strict();

agentUpgradesRouter.post('/runs/:id/retry', requireRole('ADMIN'), async c => {
  const body = await parseBody(retrySchema, await c.req.json().catch(() => ({})));
  const { run } = await retryUpgradeRun(c.req.param('id')!, { ...body, actorId: getUser(c).userId });
  return c.json({ success: true, data: run }, 202);
});
