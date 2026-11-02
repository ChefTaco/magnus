import { Hono } from 'hono';
import { agentUpgradeRequestSchema } from '@hivemagnus/magnus-contracts';
import { managedExecution } from '../security/managed-context.js';
import { logger } from '../utils/logger.js';
import { AGENT_VERSION } from '../version.js';
import { upgradePreflight } from './preflight.js';
import { EXIT_BACKSTOP_MS, SelfUpgradeError, selfUpgradeStatus, stageUpgrade } from './self-upgrade.js';

/** Seconds between the reply and the exit that hands over to the launcher. */
export const RESTART_DELAY_MS = 3_000;

export const agentUpgradeRoutes = new Hono();

agentUpgradeRoutes.get('/status', c => c.json({ success: true, data: selfUpgradeStatus(AGENT_VERSION) }));

// Read only, and a GET, so it needs no lease, no claim and no registry entry. Older agents answer 404.
agentUpgradeRoutes.get('/preflight', async c => {
  const { commandLedger } = await import('../executors/command-executor.js');
  return c.json({ success: true, data: await upgradePreflight({ version: AGENT_VERSION, target: c.req.query('target'), engines: c.req.query('engines'), nonce: c.req.query('nonce'), ledger: commandLedger }) });
});

agentUpgradeRoutes.post('/', async c => {
  const parsed = agentUpgradeRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'version, integrity (sha512-…) and requestId are required' } }, 400);
  }
  try {
    const result = await stageUpgrade({ request: parsed.data, version: AGENT_VERSION });
    // A retried request: report the current state, change nothing.
    if (result.repeated) return c.json({ success: true, data: { accepted: true, ...result } });
    logger.info(`Self-upgrade staged: ${result.from} -> ${result.to}; restarting through the launcher`);
    // Reply first; the launcher starts versions/<to> on trial after this process exits.
    const restart = () => {
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), RESTART_DELAY_MS).unref();
      // Backstop: a shutdown that hangs must not keep the old version running on the new ./current.
      setTimeout(() => process.exit(0), EXIT_BACKSTOP_MS).unref();
    };
    // A managed request's terminal receipt is written after this handler returns: the clock starts when it is durable.
    const managed = managedExecution.getStore();
    if (managed?.afterSettled) managed.afterSettled.push(restart);
    else restart();
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
