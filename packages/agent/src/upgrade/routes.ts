import { Hono } from 'hono';
import { agentUpgradeRequestSchema } from '@hivemagnus/magnus-contracts';
import { logger } from '../utils/logger.js';
import { AGENT_VERSION } from '../version.js';
import { SelfUpgradeError, selfUpgradeStatus, stageUpgrade } from './self-upgrade.js';

/** Seconds between the reply and the exit that hands over to the launcher. */
export const RESTART_DELAY_MS = 3_000;

export const agentUpgradeRoutes = new Hono();

agentUpgradeRoutes.get('/status', c => c.json({ success: true, data: selfUpgradeStatus(AGENT_VERSION) }));

agentUpgradeRoutes.post('/', async c => {
  const parsed = agentUpgradeRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'version, integrity (sha512-…) and requestId are required' } }, 400);
  }
  try {
    const result = await stageUpgrade({ request: parsed.data, version: AGENT_VERSION });
    logger.info(`Self-upgrade staged: ${result.from} -> ${result.to}; restarting through the launcher`);
    // Reply first; the launcher starts versions/<to> on trial after this process exits.
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), RESTART_DELAY_MS).unref();
    return c.json({ success: true, data: { accepted: true, ...result, restartInSeconds: RESTART_DELAY_MS / 1000 } });
  } catch (error) {
    if (error instanceof SelfUpgradeError) {
      logger.warn(`Self-upgrade to ${parsed.data.version} refused: ${error.message}`);
      return c.json({ success: false, error: { code: error.code, message: error.message } }, error.status);
    }
    logger.error('Self-upgrade failed', { error: error instanceof Error ? error.message : String(error) });
    return c.json({ success: false, error: { code: 'SELF_UPGRADE_FAILED', message: error instanceof Error ? error.message : String(error) } }, 500);
  }
});
