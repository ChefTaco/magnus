import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, getUser, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { logAuditEvent } from '../services/audit-service.js';
import { getArdentArtifact, getArdentInstallation, getArdentProfileResource, listArdentInstallations, performArdentAction } from '../services/ardent-service.js';
import { z } from 'zod';

export const ardentRouter = new Hono<AppVariables>();
ardentRouter.use('*', authMiddleware);
ardentRouter.use('*', requireRole('ADMIN'));

const id = (value: string | undefined) => {
  if (!value || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid Ardent node or profile');
  return value;
};

ardentRouter.get('/installations', async c => c.json({ success: true, data: await listArdentInstallations() }));
ardentRouter.get('/installations/:nodeId', async c => c.json({ success: true, data: await getArdentInstallation(id(c.req.param('nodeId'))) }));
ardentRouter.get('/profiles', async c => {
  const installations = await listArdentInstallations();
  return c.json({ success: true, data: installations.flatMap(installation => installation.profiles.map(profile => ({ ...profile,
    nodeId: installation.nodeId, nodeName: installation.nodeName, hostname: installation.hostname,
    installationVersion: installation.version, reachable: installation.reachable }))) });
});
ardentRouter.get('/installations/:nodeId/profiles/:name/artifacts/:artifactId', async c => {
  const nodeId = id(c.req.param('nodeId'));
  const profile = id(c.req.param('name'));
  const artifactId = c.req.param('artifactId');
  if (!/^[a-f0-9]{64}$/.test(artifactId)) throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid Ardent artifact ID');
  try {
    const bytes = await getArdentArtifact(nodeId, profile, artifactId);
    return c.body(Uint8Array.from(bytes), 200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="ardent-${artifactId}.bin"`,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'response' in error && error.response instanceof Response && error.response.status === 404)
      throw new HttpError(404, 'NOT_FOUND', 'Ardent artifact not found');
    throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', error instanceof Error ? error.message.slice(0, 300) : 'Ardent artifact unavailable');
  }
});
ardentRouter.get('/installations/:nodeId/profiles/:name/*', async c => {
  const nodeId = id(c.req.param('nodeId'));
  const name = id(c.req.param('name'));
  const marker = `/installations/${nodeId}/profiles/${name}/`;
  const resource = c.req.path.split(marker)[1] ?? '';
  if (!/^(?:openapi|status|profile|config|config\/schema|providers|channels|peers|peers\/config|memory\/status|skills|sessions|tasks|tasks\/[0-9a-f-]{36}(?:\/events)?|sessions\/[0-9a-f-]{36}\/messages|identity\/(?:soul|identity)(?:\/history)?)$/.test(resource))
    throw new HttpError(404, 'NOT_FOUND', 'Ardent resource unavailable');
  const query: Record<string, string> = {};
  for (const key of ['after', 'limit']) {
    const value = c.req.query(key);
    if (value !== undefined) query[key] = value;
  }
  try {
    const data = await getArdentProfileResource(nodeId, name, resource, query);
    return c.json({ success: true, data });
  } catch (error: unknown) {
    throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', error instanceof Error ? error.message.slice(0, 300) : 'Ardent node unavailable');
  }
});

const Action = z.object({
  action: z.enum(['profile-create', 'profile-import-hermes', 'config-validate', 'config-save', 'peer-validate', 'peer-save', 'identity-save', 'identity-restore', 'provider-test', 'channel-test', 'peer-test', 'memory-search', 'task-submit', 'task-cancel', 'skill-set', 'service-start', 'service-stop', 'service-restart', 'package-install']),
  target: z.string().min(1).max(128).optional(), body: z.unknown().optional(),
}).strict();
ardentRouter.post('/installations/:nodeId/profiles/:name/action', async c => {
  const nodeId = id(c.req.param('nodeId'));
  const profile = id(c.req.param('name'));
  const parsed = Action.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid Ardent action');
  const { action, target, body } = parsed.data;
  try {
    const result = await performArdentAction(nodeId, profile, action, target, body);
    await logAuditEvent({ action: `ardent.${action}`, actorId: getUser(c).userId,
      targetType: 'ardent-profile', targetId: `${nodeId}:${profile}`, details: { target: target ?? null } });
    return c.json({ success: true, data: result });
  } catch (error: unknown) {
    throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', error instanceof Error ? error.message.slice(0, 300) : 'Ardent action unavailable');
  }
});
