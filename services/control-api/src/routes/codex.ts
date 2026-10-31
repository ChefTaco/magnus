import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, getUser, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { logAuditEvent } from '../services/audit-service.js';
import {
  cancelCodexDeviceLogin,
  getCodexDeviceLogin,
  getCodexInstallation,
  listCodexInstallations,
  logoutCodexInstallation,
  startCodexDeviceLogin,
  updateCodexInstallation,
} from '../services/codex-service.js';

export const codexRouter = new Hono<AppVariables>();
codexRouter.use('*', authMiddleware);
codexRouter.use('*', requireRole('ADMIN'));

const auditedExpiredLogouts = new Set<string>();

function requiredParam(value: string | undefined, name: string): string {
  if (!value || value.length > 128 || !/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${name} is invalid`);
  }
  return value;
}

codexRouter.get('/installations', async (c) => {
  const data = await listCodexInstallations(c.req.query('refreshLatest') === 'true');
  for (const installation of data.filter((item) => item.auth.autoLoggedOut)) {
    const auditKey = `${installation.nodeId}:${installation.checkedAt}`;
    if (auditedExpiredLogouts.has(auditKey)) continue;
    auditedExpiredLogouts.add(auditKey);
    if (auditedExpiredLogouts.size > 1_000) {
      auditedExpiredLogouts.delete(auditedExpiredLogouts.values().next().value!);
    }
    await logAuditEvent({
      action: 'codex.auth.expired_logout', actorId: getUser(c).userId,
      targetType: 'node', targetId: installation.nodeId,
      details: { tokenExpiresAt: installation.auth.tokenExpiresAt, mode: installation.auth.mode },
    });
  }
  return c.json({ success: true, data });
});

codexRouter.get('/installations/:nodeId', async (c) =>
  c.json({ success: true, data: await getCodexInstallation(requiredParam(c.req.param('nodeId'), 'nodeId'), c.req.query('refreshLatest') === 'true') }));

codexRouter.post('/installations/:nodeId/update', requireRole('ADMIN'), async (c) => {
  const nodeId = requiredParam(c.req.param('nodeId'), 'nodeId');
  const data = await updateCodexInstallation(nodeId);
  await logAuditEvent({ action: 'codex.update', actorId: getUser(c).userId, targetType: 'node', targetId: nodeId, details: { version: data.version } });
  return c.json({ success: true, data });
});

codexRouter.post('/installations/:nodeId/logout', requireRole('ADMIN'), async (c) => {
  const nodeId = requiredParam(c.req.param('nodeId'), 'nodeId');
  const data = await logoutCodexInstallation(nodeId);
  await logAuditEvent({ action: 'codex.auth.logout', actorId: getUser(c).userId, targetType: 'node', targetId: nodeId, details: { mode: 'chatgpt' } });
  return c.json({ success: true, data });
});

codexRouter.post('/installations/:nodeId/device-auth', requireRole('ADMIN'), async (c) => {
  const nodeId = requiredParam(c.req.param('nodeId'), 'nodeId');
  const data = await startCodexDeviceLogin(nodeId);
  await logAuditEvent({ action: 'codex.auth.device_start', actorId: getUser(c).userId, targetType: 'node', targetId: nodeId, details: { sessionId: data.id, expiresAt: data.expiresAt } });
  return c.json({ success: true, data });
});

codexRouter.get('/installations/:nodeId/device-auth/:sessionId', async (c) => {
  const nodeId = requiredParam(c.req.param('nodeId'), 'nodeId');
  const sessionId = requiredParam(c.req.param('sessionId'), 'sessionId');
  return c.json({ success: true, data: await getCodexDeviceLogin(nodeId, sessionId) });
});

codexRouter.post('/installations/:nodeId/device-auth/:sessionId/cancel', requireRole('ADMIN'), async (c) => {
  const nodeId = requiredParam(c.req.param('nodeId'), 'nodeId');
  const sessionId = requiredParam(c.req.param('sessionId'), 'sessionId');
  const data = await cancelCodexDeviceLogin(nodeId, sessionId);
  await logAuditEvent({ action: 'codex.auth.device_cancel', actorId: getUser(c).userId, targetType: 'node', targetId: nodeId, details: { sessionId } });
  return c.json({ success: true, data });
});
