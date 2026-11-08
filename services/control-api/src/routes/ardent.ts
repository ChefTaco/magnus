import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import type { Context, Next } from 'hono';
import { authMiddleware, getUser } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { logAuditEvent } from '../services/audit-service.js';
import { actingOathweaveLink, watchOathweaveStream } from '../middleware/oathweave.js';
import { getArdentAgentOperation, resumeArdentAgentOperation, startArdentAgentDeploy, startArdentHiveMemEnable, type ArdentOperationActor } from '../services/ardent-agent-deploy.js';
import { getArdentContextAdoption, getArdentContextRelease, getArdentInstallation, getArdentProfileResource, listArdentInstallations, performArdentAction, requireArdentStudioAgent, streamArdentProfileResource } from '../services/ardent-service.js';
import { AgentResponseError } from '../sdk/node-api-client.js';
import { HTTPError } from 'ky';
import { z } from 'zod';
import { ARDENT_STUDIO_CAPABILITY, ArdentContextAdoptionInputSchema, ardentDevelopmentNoteSchema, ardentMissionSubmitSchema, ardentPreviewSubmitSchema, ardentSessionOpenSchema } from '@hivemagnus/magnus-contracts';

export const ardentRouter = new Hono<AppVariables>();
ardentRouter.use('*', authMiddleware);

/**
 * ADMIN people, plus a linked Ardent service identity. Authentication already
 * confines a service to the bridge routes; the handlers below narrow it further
 * (read resources, the session, task, mission, preview and note actions) and
 * require an acting person for previews and notes, and an acting ADMIN to change agents.
 */
async function requireArdentAccess(c: Context<AppVariables>, next: Next): Promise<void> {
  const user = getUser(c);
  if (user.service?.kind !== 'ardent' && user.role !== 'ADMIN') throw new HttpError(403, 'FORBIDDEN', 'Requires one of: ADMIN');
  await next();
}
ardentRouter.use('*', requireArdentAccess);

/** The header a service uses to name the person it acts for. */
export const ACTING_SUBJECT_HEADER = 'x-acting-subject';

/**
 * Who the audit names. A person acts as themself. A service acts as itself, or
 * for the person its x-acting-subject names, which must be linked on the
 * service's issuer; both are recorded. `requireAdmin` additionally needs that
 * person's link role to be ADMIN; `requireSubject` needs a named person of any role.
 */
export function ardentActor(c: Context<AppVariables>, requireAdmin: boolean, requireSubject = requireAdmin): ArdentOperationActor {
  const user = getUser(c);
  if (!user.service) {
    if (requireAdmin && user.role !== 'ADMIN') throw new HttpError(403, 'FORBIDDEN', 'Requires one of: ADMIN');
    return { actorId: user.userId, details: {} };
  }
  const subject = c.req.header(ACTING_SUBJECT_HEADER);
  if (subject === undefined) {
    if (requireAdmin) throw new HttpError(403, 'ACTING_ADMIN_REQUIRED', `This change needs ${ACTING_SUBJECT_HEADER} naming a linked Magnus ADMIN`);
    if (requireSubject) throw new HttpError(403, 'ACTING_SUBJECT_REQUIRED', `This action needs ${ACTING_SUBJECT_HEADER} naming the linked person it is for`);
    return { actorId: user.userId, details: { serviceClientId: user.service.clientId } };
  }
  const link = actingOathweaveLink(user.service.issuer, subject);
  if (!link) throw new HttpError(403, 'ACTING_SUBJECT_UNLINKED', `${ACTING_SUBJECT_HEADER} must name a person with one Magnus link on the same issuer`);
  if (requireAdmin && link.role !== 'ADMIN') throw new HttpError(403, 'ACTING_ADMIN_REQUIRED', 'The acting person is not a Magnus ADMIN');
  return { actorId: link.localUserId, details: { serviceActor: user.userId, serviceClientId: user.service.clientId, actingSubject: subject } };
}

/** Profile reads a service identity may make. Configuration, providers, channels and peers stay with ADMIN people. */
const SERVICE_READ = /^(?:status|profile|skills|memory\/status|sessions|sessions\/[0-9a-f-]{36}\/messages|tasks|tasks\/[0-9a-f-]{36}(?:\/events|\/artifacts)?|artifacts\/[a-f0-9]{64}\/manifest|development|identity\/(?:soul|identity))$/;
const SERVICE_ACTIONS = new Set(['session-open', 'task-submit', 'task-cancel', 'mission-submit', 'task-pause', 'task-resume', 'preview-submit', 'development-note']);
/** Service actions that must name the person they are for. */
const SERVICE_SUBJECT_ACTIONS = new Set(['preview-submit', 'development-note']);
/** Actions and reads that Ardent 2.2.0 added, which need a node agent at studio level 2. */
const MISSION_ACTIONS = new Set(['mission-submit', 'task-pause', 'task-resume', 'preview-submit', 'development-note']);
const MISSION_READ = /^(?:tasks\/[0-9a-f-]{36}\/artifacts|artifacts\/[a-f0-9]{64}\/manifest|development)$/;
/** Query parameters a profile read passes on, each with the values it may hold. */
const READ_QUERY: Record<string, RegExp> = {
  after: /^[A-Za-z0-9_-]{1,400}$/, limit: /^\d{1,3}$/, kind: /^[a-z][a-z0-9_]{0,63}$/, context: /^(?:direct|mission|preview)$/,
};

/** The HTTP status the node agent or Ardent answered, when a request reached them and was refused. */
function refusedStatus(error: unknown): number | undefined {
  if (error instanceof AgentResponseError) return error.agentStatus;
  if (error instanceof HTTPError) return error.response.status;
  return undefined;
}
/** Ardent's own refusal, passed on with its status: a bad request, a missing task or session, or a finished task. */
function ardentRefusal(error: unknown): HttpError | undefined {
  const status = refusedStatus(error);
  if (status === 400 || status === 413) return new HttpError(400, 'VALIDATION_ERROR', 'Ardent rejected the request');
  if (status === 404) return new HttpError(404, 'NOT_FOUND', 'Ardent task, session or resource not found');
  if (status === 409) return new HttpError(409, 'CONFLICT', 'Ardent refused the request in the task\'s current state');
  return undefined;
}

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
  if (!/^(?:openapi|status|profile|config|config\/schema|providers|channels|peers|peers\/config|memory\/status|skills|sessions|tasks|tasks\/[0-9a-f-]{36}(?:\/events|\/artifacts)?|artifacts\/[a-f0-9]{64}\/manifest|development|sessions\/[0-9a-f-]{36}\/messages|identity\/(?:soul|identity)(?:\/history)?)$/.test(resource))
    throw new HttpError(404, 'NOT_FOUND', 'Ardent resource unavailable');
  if (getUser(c).service && !SERVICE_READ.test(resource)) throw new HttpError(403, 'FORBIDDEN', 'This Ardent resource is not available to a service identity');
  const query: Record<string, string> = {};
  for (const [key, pattern] of Object.entries(READ_QUERY)) {
    const value = c.req.query(key);
    if (value === undefined) continue;
    if (!pattern.test(value)) throw new HttpError(400, 'VALIDATION_ERROR', `Invalid ${key} query`);
    query[key] = value;
  }
  // An older agent would drop the session context and list direct sessions instead.
  if (MISSION_READ.test(resource) || query['context'] !== undefined) await requireArdentStudioAgent(nodeId, ARDENT_STUDIO_CAPABILITY.missions);
  try {
    const data = await getArdentProfileResource(nodeId, name, resource, query);
    return c.json({ success: true, data });
  } catch (error: unknown) {
    const status = refusedStatus(error);
    if (status === 404) throw new HttpError(404, 'NOT_FOUND', 'Ardent resource not found');
    if (status === 400) throw new HttpError(400, 'VALIDATION_ERROR', 'Ardent rejected the read');
    throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', error instanceof Error ? error.message.slice(0, 300) : 'Ardent node unavailable');
  }
});

/** What the audit keeps of a mission or preview: identifiers, never the objective, context or identity texts. */
function actionAuditDetails(action: string, body: unknown): Record<string, unknown> {
  if (action === 'mission-submit') {
    const mission = ardentMissionSubmitSchema.safeParse(body);
    return mission.success ? { missionId: mission.data.mission.id, missionRevision: mission.data.mission.revision,
      sessionId: mission.data.session_id ?? null, idempotencyKey: mission.data.idempotency_key } : {};
  }
  if (action === 'preview-submit') {
    const preview = ardentPreviewSubmitSchema.safeParse(body);
    return preview.success ? { sessionId: preview.data.session_id ?? null, overrides: Object.keys(preview.data.overrides ?? {}).sort() } : {};
  }
  if (action === 'development-note' && body && typeof body === 'object' && 'kind' in body && typeof body.kind === 'string')
    return { kind: body.kind.slice(0, 64) };
  return {};
}

/** Bodies checked here, before anything reaches a node; the node agent and Ardent check them again. */
const ACTION_BODIES: Partial<Record<string, z.ZodType>> = {
  'session-open': ardentSessionOpenSchema, 'mission-submit': ardentMissionSubmitSchema,
  'preview-submit': ardentPreviewSubmitSchema, 'development-note': ardentDevelopmentNoteSchema,
};

const Action = z.object({
  action: z.enum(['profile-create', 'session-open', 'config-validate', 'config-save', 'peer-validate', 'peer-save', 'identity-save', 'identity-restore', 'provider-test', 'channel-test', 'peer-test', 'memory-search', 'task-submit', 'task-cancel', 'mission-submit', 'task-pause', 'task-resume', 'preview-submit', 'development-note', 'skill-set', 'service-start', 'service-stop', 'service-restart', 'package-install', 'context-stage', 'context-adopt', 'context-rollback']),
  target: z.string().min(1).max(128).optional(), body: z.unknown().optional(),
}).strict();
ardentRouter.post('/installations/:nodeId/profiles/:name/action', async c => {
  const nodeId = id(c.req.param('nodeId'));
  const profile = id(c.req.param('name'));
  const parsed = Action.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid Ardent action');
  const { action, target, body } = parsed.data;
  if (getUser(c).service && !SERVICE_ACTIONS.has(action)) throw new HttpError(403, 'FORBIDDEN', 'A service identity may only open sessions, run tasks, missions and previews, and record development notes');
  const actor = ardentActor(c, false, SERVICE_SUBJECT_ACTIONS.has(action));
  if (['context-stage', 'context-adopt', 'context-rollback'].includes(action)
    && (target !== undefined || !ArdentContextAdoptionInputSchema.safeParse(body).success))
    throw new HttpError(400, 'VALIDATION_ERROR', 'Context adoption requires exact release, source and policy pins without an arbitrary target');
  const shape = ACTION_BODIES[action]?.safeParse(body);
  if (shape && !shape.success) throw new HttpError(400, 'VALIDATION_ERROR', shape.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 500));
  if ((action === 'task-pause' || action === 'task-resume') && (!target || !/^[0-9a-f-]{36}$/.test(target) || (body !== undefined && !z.object({}).strict().safeParse(body).success)))
    throw new HttpError(400, 'VALIDATION_ERROR', 'Task pause and resume need the task ID as target and no body');
  if (MISSION_ACTIONS.has(action) || (action === 'session-open' && body && typeof body === 'object' && 'context' in body))
    await requireArdentStudioAgent(nodeId, ARDENT_STUDIO_CAPABILITY.missions);
  else if (action === 'session-open' || (action === 'task-submit' && body && typeof body === 'object' && 'session_id' in body))
    await requireArdentStudioAgent(nodeId);
  try {
    const result = await performArdentAction(nodeId, profile, action, target, body);
    await logAuditEvent({ action: `ardent.${action}`, actorId: actor.actorId,
      targetType: 'ardent-profile', targetId: `${nodeId}:${profile}`, details: {
        target: target ?? null, ...actor.details, ...actionAuditDetails(action, body),
        ...(['context-stage', 'context-adopt', 'context-rollback'].includes(action) ? ArdentContextAdoptionInputSchema.parse(body) : {})
      } });
    return c.json({ success: true, data: result });
  } catch (error: unknown) {
    // The agent refused it, or Ardent did: pass the newer actions' refusals on as such.
    const refusal = MISSION_ACTIONS.has(action) ? ardentRefusal(error) : undefined;
    if (refusal) throw refusal;
    throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', error instanceof Error ? error.message.slice(0, 300) : 'Ardent action unavailable');
  }
});

// ── New Agent and Enable HiveMem operations ──

const operationId = (value: string | undefined) => {
  if (!value || !/^[0-9a-f-]{36}$/.test(value)) throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid operation ID');
  return value;
};

ardentRouter.post('/agents', async c => {
  const actor = ardentActor(c, true);
  const operation = await startArdentAgentDeploy(await c.req.json().catch(() => null), actor);
  return c.json({ success: true, data: { operationId: operation } }, 202);
});
ardentRouter.get('/agents/operations/:id', async c => c.json({ success: true, data: await getArdentAgentOperation(operationId(c.req.param('id'))) }));
ardentRouter.get('/agents/operations/:id/stream', async c => {
  const id = operationId(c.req.param('id'));
  let last = JSON.stringify(await getArdentAgentOperation(id));
  const encoder = new TextEncoder();
  const signal = c.req.raw.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopWatching: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        stopWatching?.();
        try { controller.close(); } catch { /* already closed */ }
      };
      const send = (event: string, data: string) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
      stopWatching = watchOathweaveStream(c.req.header('Authorization'), close);
      signal.addEventListener('abort', close, { once: true });
      const started = Date.now();
      let quietSince = Date.now();
      const finished = (text: string) => (JSON.parse(text) as { status: string }).status !== 'running';
      send('operation', last);
      if (finished(last)) { send('done', last); close(); return; }
      const poll = async () => {
        if (closed) return;
        try {
          const next = JSON.stringify(await getArdentAgentOperation(id));
          if (next !== last) { last = next; quietSince = Date.now(); send('operation', next); }
          if (finished(next)) { send('done', next); close(); return; }
          if (Date.now() - quietSince > 15_000) { quietSince = Date.now(); controller.enqueue(encoder.encode(': keepalive\n\n')); }
          // A client reconnects after this; the operation keeps running.
          if (Date.now() - started > 15 * 60_000) { close(); return; }
        } catch { close(); return; }
        timer = setTimeout(() => { void poll(); }, 500);
      };
      timer = setTimeout(() => { void poll(); }, 500);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      stopWatching?.();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' } });
});
ardentRouter.post('/agents/operations/:id/resume', async c => {
  const id = operationId(c.req.param('id'));
  const actor = ardentActor(c, true);
  return c.json({ success: true, data: { operationId: await resumeArdentAgentOperation(id, actor) } }, 202);
});
ardentRouter.post('/installations/:nodeId/profiles/:name/hivemem', async c => {
  const nodeId = id(c.req.param('nodeId'));
  const profile = id(c.req.param('name'));
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(profile)) throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid Ardent profile');
  const actor = ardentActor(c, true);
  return c.json({ success: true, data: { operationId: await startArdentHiveMemEnable(nodeId, profile, actor) } }, 202);
});
