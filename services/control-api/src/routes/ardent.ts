import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, getUser, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { logAuditEvent } from '../services/audit-service.js';
import { watchOathweaveStream } from '../middleware/oathweave.js';
import { getArdentContextAdoption, getArdentContextRelease, getArdentInstallation, getArdentProfileResource, listArdentInstallations, performArdentAction, requireArdentStudioAgent, streamArdentProfileResource } from '../services/ardent-service.js';
import { z } from 'zod';
import { ArdentContextAdoptionInputSchema } from '@hivemagnus/magnus-contracts';

export const ardentRouter = new Hono<AppVariables>();
ardentRouter.use('*', authMiddleware);
ardentRouter.use('*', requireRole('ADMIN'));

const id = (value: string | undefined) => {
  if (!value || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid Ardent node or profile');
  return value;
};

ardentRouter.get('/installations', async c => c.json({ success: true, data: await listArdentInstallations() }));
ardentRouter.get('/installations/:nodeId', async c => c.json({ success: true, data: await getArdentInstallation(id(c.req.param('nodeId'))) }));
ardentRouter.get('/installations/:nodeId/profiles/:name/context-release', async c => {
  return c.json({ success: true, data: await getArdentContextRelease(id(c.req.param('nodeId')), id(c.req.param('name'))) });
});
ardentRouter.get('/installations/:nodeId/profiles/:name/context-adoptions/:releaseId', async c => {
  const releaseId = z.string().guid().safeParse(c.req.param('releaseId'));
  if (!releaseId.success) throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid context adoption release ID');
  return c.json({ success: true, data: await getArdentContextAdoption(id(c.req.param('nodeId')), id(c.req.param('name')), releaseId.data) });
});
ardentRouter.get('/profiles', async c => {
  const installations = await listArdentInstallations();
  return c.json({ success: true, data: installations.flatMap(installation => installation.profiles.map(profile => ({ ...profile,
    nodeId: installation.nodeId, nodeName: installation.nodeName, hostname: installation.hostname,
    installationVersion: installation.version, reachable: installation.reachable }))) });
});
const cursor = (value: string | undefined, label: string) => {
  if (value !== undefined && !/^\d{1,15}$/.test(value)) throw new HttpError(400, 'VALIDATION_ERROR', `Invalid ${label}`);
  return value;
};

/** The node agent's answer, or a 404/503 that says which side failed. Never buffers a success. */
async function openNodeStream(nodeId: string, profile: string, resource: string, type: string, signal: AbortSignal,
  options: { after?: string; lastEventId?: string } = {}): Promise<Response> {
  let upstream: Response;
  try { upstream = await streamArdentProfileResource(nodeId, profile, resource, { ...options, signal }); }
  catch (error: unknown) {
    if (error instanceof Error && error.message === 'Managed node not found') throw new HttpError(404, 'NOT_FOUND', 'Managed node not found');
    throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', error instanceof Error ? error.message.slice(0, 300) : 'Ardent node unavailable');
  }
  if (upstream.ok && upstream.body && (upstream.headers.get('content-type') ?? '').startsWith(type)) return upstream;
  await upstream.body?.cancel().catch(() => undefined);
  if (upstream.status === 404) throw new HttpError(404, 'NOT_FOUND', 'Ardent resource not found');
  if (upstream.status === 400) throw new HttpError(400, 'VALIDATION_ERROR', 'Ardent rejected the stream request');
  throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', `Ardent stream unavailable (agent HTTP ${upstream.status})`);
}

/**
 * Pass bytes through as the agent sends them. Nothing is buffered or re-framed;
 * a client disconnect cancels the node request, and an Oathweave stream closes
 * once its token stops authenticating.
 */
function relay(body: ReadableStream<Uint8Array>, authorization: string | undefined): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let stopWatching: (() => void) | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stopWatching = watchOathweaveStream(authorization, () => {
        void reader.cancel().catch(() => undefined);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { stopWatching?.(); controller.close(); return; }
        controller.enqueue(value);
      } catch (error: unknown) {
        stopWatching?.();
        controller.error(error instanceof Error ? error : new Error('Ardent stream failed'));
      }
    },
    cancel(reason) {
      stopWatching?.();
      return reader.cancel(reason).catch(() => undefined);
    },
  });
}

ardentRouter.get('/installations/:nodeId/profiles/:name/tasks/:taskId/stream', async c => {
  const nodeId = id(c.req.param('nodeId'));
  const profile = id(c.req.param('name'));
  const taskId = c.req.param('taskId');
  if (!/^[0-9a-f-]{36}$/.test(taskId)) throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid Ardent task ID');
  const after = cursor(c.req.query('after'), 'stream cursor');
  const lastEventId = cursor(c.req.header('Last-Event-ID'), 'Last-Event-ID');
  await requireArdentStudioAgent(nodeId);
  const upstream = await openNodeStream(nodeId, profile, `tasks/${taskId}/stream`, 'text/event-stream', c.req.raw.signal,
    { ...(after !== undefined ? { after } : {}), ...(lastEventId !== undefined ? { lastEventId } : {}) });
  return new Response(relay(upstream.body!, c.req.header('Authorization')), { status: 200, headers: {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
  } });
});
ardentRouter.get('/installations/:nodeId/profiles/:name/artifacts/:artifactId', async c => {
  const nodeId = id(c.req.param('nodeId'));
  const profile = id(c.req.param('name'));
  const artifactId = c.req.param('artifactId');
  if (!/^[a-f0-9]{64}$/.test(artifactId)) throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid Ardent artifact ID');
  const upstream = await openNodeStream(nodeId, profile, `artifacts/${artifactId}`, 'application/octet-stream', c.req.raw.signal);
  const length = upstream.headers.get('content-length');
  return new Response(relay(upstream.body!, c.req.header('Authorization')), { status: 200, headers: {
    'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="ardent-${artifactId}.bin"`,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no',
    ...(length && /^\d{1,15}$/.test(length) ? { 'Content-Length': length } : {}),
  } });
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
  action: z.enum(['profile-create', 'session-open', 'config-validate', 'config-save', 'peer-validate', 'peer-save', 'identity-save', 'identity-restore', 'provider-test', 'channel-test', 'peer-test', 'memory-search', 'task-submit', 'task-cancel', 'skill-set', 'service-start', 'service-stop', 'service-restart', 'package-install', 'context-stage', 'context-adopt', 'context-rollback']),
  target: z.string().min(1).max(128).optional(), body: z.unknown().optional(),
}).strict();
ardentRouter.post('/installations/:nodeId/profiles/:name/action', async c => {
  const nodeId = id(c.req.param('nodeId'));
  const profile = id(c.req.param('name'));
  const parsed = Action.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid Ardent action');
  const { action, target, body } = parsed.data;
  if (['context-stage', 'context-adopt', 'context-rollback'].includes(action)
    && (target !== undefined || !ArdentContextAdoptionInputSchema.safeParse(body).success))
    throw new HttpError(400, 'VALIDATION_ERROR', 'Context adoption requires exact release, source and policy pins without an arbitrary target');
  if (action === 'session-open' || (action === 'task-submit' && body && typeof body === 'object' && 'session_id' in body))
    await requireArdentStudioAgent(nodeId);
  try {
    const result = await performArdentAction(nodeId, profile, action, target, body);
    await logAuditEvent({ action: `ardent.${action}`, actorId: getUser(c).userId,
      targetType: 'ardent-profile', targetId: `${nodeId}:${profile}`, details: {
        target: target ?? null,
        ...(['context-stage', 'context-adopt', 'context-rollback'].includes(action) ? ArdentContextAdoptionInputSchema.parse(body) : {})
      } });
    return c.json({ success: true, data: result });
  } catch (error: unknown) {
    throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', error instanceof Error ? error.message.slice(0, 300) : 'Ardent action unavailable');
  }
});
