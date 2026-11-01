import { z } from 'zod';
import { ApiLocalWorkError, apiLocalWorkStatus } from '../services/api-local-work.js';
import { Hono, type Context, type Next } from 'hono';
import type { AppVariables } from '../types/index.js';
import { AGENT_VERSION, CONTROL_API_VERSION } from '../config/index.js';
import { authMiddleware, getUser, requireRole } from '../middleware/auth.js';
import { logAuditEvent } from '../services/audit-service.js';
import {
  checkForUpdates,
  performSelfUpdate,
  scheduleRestart,
  getUpdateStatus,
} from '../services/self-update-service.js';
import { HttpError } from '../middleware/error-handler.js';
import { upgradeSettings } from '../config/features.js';

export const selfUpdateRouter = new Hono<AppVariables>();

selfUpdateRouter.use('*', authMiddleware);
selfUpdateRouter.use('*', async (c, next) => {
  await next();
  if (c.error instanceof ApiLocalWorkError) {
    // An apply receipt already set on this response must survive a subsequent
    // restart failure. Never trust an arbitrary exception's workId property.
    c.header(c.res.headers.has('X-Magnus-Work-Id') ? 'X-Magnus-Restart-Work-Id' : 'X-Magnus-Work-Id', c.error.workId);
  }
});

/**
 * The git-checkout update path (`git pull`, rebuild, restart) only works for
 * source installs. npm installs upgrade with `magnus upgrade`, which backs up
 * the database and reverts on failure; the old endpoints stay behind
 * MAGNUS_LEGACY_GIT_SELF_UPDATE=true.
 */
const legacyGitSelfUpdate = async (c: Context, next: Next) => {
  if (!upgradeSettings().legacyGitSelfUpdate) {
    return c.json({ success: false, error: { code: 'SELF_UPDATE_RETIRED',
      message: 'In-place git self-update is off. Upgrade with `magnus upgrade` (or `magnus-server upgrade`) on the server host; '
        + 'set MAGNUS_LEGACY_GIT_SELF_UPDATE=true to re-enable this endpoint for a source checkout.',
      upgradeCommand: 'magnus upgrade' } }, 410);
  }
  await next();
};
selfUpdateRouter.use('/check', legacyGitSelfUpdate);
selfUpdateRouter.use('/apply', legacyGitSelfUpdate);
selfUpdateRouter.use('/restart', legacyGitSelfUpdate);

selfUpdateRouter.get('/work/:workId', requireRole('ADMIN', 'OPERATOR'), async c => {
  const id = z.string().guid().safeParse(c.req.param('workId'));
  if (!id.success) throw new HttpError(400, 'INVALID_WORK_ID', 'A durable work UUID is required');
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, data: await apiLocalWorkStatus(id.data) });
});

/**
 * GET /self-update/status
 * Return current Control Node version, git info, and update status.
 */
selfUpdateRouter.get('/status', async (c) => {
  const status = await getUpdateStatus();
  return c.json({ success: true, data: status });
});

/**
 * GET /self-update/version
 * Lightweight version check — returns just the versions.
 */
selfUpdateRouter.get('/version', async (c) => {
  return c.json({
    success: true,
    data: {
      controlApiVersion: CONTROL_API_VERSION,
      agentVersion: AGENT_VERSION,
    },
  });
});

/**
 * POST /self-update/check
 * Check if updates are available (git fetch + compare).
 */
selfUpdateRouter.post('/check', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  try {
    const result = await checkForUpdates();
    return c.json({ success: true, data: result });
  } catch (err: unknown) {
    if (err instanceof HttpError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new HttpError(500, 'UPDATE_CHECK_FAILED', `Failed to check for updates: ${message}`);
  }
});

/**
 * POST /self-update/apply
 * Pull latest code, rebuild, and optionally restart.
 * Body: { restart?: boolean }
 */
selfUpdateRouter.post('/apply', requireRole('ADMIN'), async (c) => {
  const user = getUser(c);
  const body = await c.req.json<{ restart?: boolean }>().catch(() => ({ restart: false }));

  await logAuditEvent({
    action: 'control_node.update',
    actorId: user.userId,
    targetType: 'control_node',
    targetId: 'self',
    details: { restart: body.restart ?? false },
  });

  const result = await performSelfUpdate();
  if (result.workId) c.header('X-Magnus-Work-Id', result.workId);

  if (!result.success) {
    throw new HttpError(
      500,
      'UPDATE_FAILED',
      result.error ?? 'Self-update failed',
    );
  }

  let restartInfo: { scheduled: boolean; method: string } | null = null;
  if (body.restart && result.updated) {
    await logAuditEvent({
      action: 'control_node.restart' as never,
      actorId: user.userId,
      targetType: 'control_node',
      targetId: 'self',
      details: {
        previousVersion: result.previousVersion,
        currentVersion: result.currentVersion,
      },
    });
    restartInfo = await scheduleRestart();
  }

  return c.json({
    success: true,
    data: {
      ...result,
      restart: restartInfo,
    },
  });
});

/**
 * POST /self-update/restart
 * Just restart the Control Node process (no code update).
 */
selfUpdateRouter.post('/restart', requireRole('ADMIN'), async (c) => {
  const user = getUser(c);

  await logAuditEvent({
    action: 'control_node.restart',
    actorId: user.userId,
    targetType: 'control_node',
    targetId: 'self',
    details: {},
  });

  const restartInfo = await scheduleRestart();
  c.header('X-Magnus-Work-Id', restartInfo.workId);

  return c.json({
    success: true,
    data: {
      message: 'Restart requested. The durable work receipt records admission and any unresolved completion.',
      ...restartInfo,
    },
  });
});
