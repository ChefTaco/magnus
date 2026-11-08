import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import type { Context, Next } from 'hono';
import { authMiddleware, getUser } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { logAuditEvent } from '../services/audit-service.js';
import { actingOathweaveLink, watchOathweaveStream } from '../middleware/oathweave.js';
import { getArdentAgentOperation, resumeArdentAgentOperation, startArdentAgentDeploy, startArdentHiveMemEnable, type ArdentOperationActor } from '../services/ardent-agent-deploy.js';
import { getArdentContextAdoption, getArdentContextRelease, getArdentInstallation, getArdentProfileResource, listArdentInstallations, performArdentAction, requireArdentStudioAgent, streamArdentProfileResource } from '../services/ardent-service.js';
import { AgentResponseError, managedCommandOf } from '../sdk/node-api-client.js';
import { ardentOwnerBlock, reconcileArdentCommandOwner } from '../services/ardent-command-owner.js';
import { HTTPError } from 'ky';
import { z } from 'zod';
import { ARDENT_STUDIO_CAPABILITY, ArdentCommandReconcileSchema, ArdentContextAdoptionInputSchema, ardentConfigEditSchema, ardentConfigFileSchema, ardentDevelopmentNoteSchema, ardentIdentityEditSchema, ardentMissionSubmitSchema, ardentPreviewSubmitSchema, ardentSessionOpenSchema, ardentSkillEditSchema, ardentSkillInstallSchema } from '@hivemagnus/magnus-contracts';
import { classifyServiceConfigEdit } from '../services/ardent-config-allowlist.js';
import { fetchArdentSkillRelease } from '../services/ardent-hiveskills.js';

export const ardentRouter = new Hono<AppVariables>();
ardentRouter.use('*', authMiddleware);

/**
 * ADMIN people, plus a linked Ardent service identity. Authentication already
 * confines a service to the bridge routes; the handlers below narrow it further
 * (read resources, the session, task, mission, preview and note actions, and
 * identity, skill, skill installation and limited configuration changes) and
 * require an acting person for previews and notes, and an acting ADMIN to read
 * configuration or change agents.
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

/**
 * Profile reads a service identity may make. Configuration needs an acting ADMIN, as it does for a
 * person; providers, channels, peers and histories stay with ADMIN people.
 */
const SERVICE_READ = /^(?:status|profile|config|skills|memory\/status|sessions|sessions\/[0-9a-f-]{36}\/messages|tasks|tasks\/[0-9a-f-]{36}(?:\/events|\/artifacts)?|artifacts\/[a-f0-9]{64}\/manifest|development|identity\/(?:soul|identity))$/;
const SERVICE_ACTIONS = new Set(['session-open', 'task-submit', 'task-cancel', 'mission-submit', 'task-pause', 'task-resume', 'preview-submit', 'development-note', 'identity-save', 'skill-set', 'config-save', 'skill-install']);
/** Service actions that must name the person they are for. */
const SERVICE_SUBJECT_ACTIONS = new Set(['preview-submit', 'development-note']);
/** Service actions that change an agent, which need an acting ADMIN like New Agent does. */
const SERVICE_ADMIN_ACTIONS = new Set(['identity-save', 'skill-set', 'config-save', 'skill-install']);
/** Actions that carry the revision they replace. Ardent answers a stale one with 409. */
const REVISION_ACTIONS = new Set(['identity-save', 'skill-set', 'config-save']);
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
/** Ardent's refusal of an identity, skill or configuration change: a stale revision, or a value it does not accept. */
function revisionRefusal(error: unknown): HttpError | undefined {
  const status = refusedStatus(error);
  if (status === 409) return new HttpError(409, 'CONFLICT', 'The Ardent revision changed; read it again and reapply the change');
  if (status === 400 || status === 413) {
    const detail = error instanceof AgentResponseError ? error.agentMessage : null;
    return new HttpError(400, 'VALIDATION_ERROR', `Ardent rejected the change${detail ? `: ${detail}` : ''}`.slice(0, 500));
  }
  if (status === 404) return new HttpError(404, 'NOT_FOUND', 'Ardent skill or resource not found');
  return undefined;
}
/** The node agent's refusal of a skill installation, before it changed anything. */
function skillInstallRefusal(error: unknown): HttpError | undefined {
  const status = refusedStatus(error);
  const detail = error instanceof AgentResponseError ? error.agentMessage : null;
  if (status === 409) return new HttpError(409, 'SKILL_CONFLICT', (detail ?? 'The profile has a skill of that name that Magnus did not install').slice(0, 500));
  if (status === 400 || status === 413) return new HttpError(422, 'SKILL_ARCHIVE_INVALID', (detail ?? 'The node agent refused the skill archive').slice(0, 500));
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
  const service = getUser(c).service !== undefined;
  if (service && !SERVICE_READ.test(resource)) throw new HttpError(403, 'FORBIDDEN', 'This Ardent resource is not available to a service identity');
  // A person reads configuration only as an ADMIN; a service only for one.
  if (service && resource === 'config') ardentActor(c, true);
  const query: Record<string, string> = {};
  for (const [key, pattern] of Object.entries(READ_QUERY)) {
    const value = c.req.query(key);
    if (value === undefined) continue;
    if (!pattern.test(value)) throw new HttpError(400, 'VALIDATION_ERROR', `Invalid ${key} query`);
    query[key] = value;
  }
  // An older agent would drop the session context and list direct sessions instead.
  if (MISSION_READ.test(resource) || query['context'] !== undefined) await requireArdentStudioAgent(nodeId, ARDENT_STUDIO_CAPABILITY.missions);
  let data: unknown;
  try {
    data = await getArdentProfileResource(nodeId, name, resource, query);
  } catch (error: unknown) {
    const status = refusedStatus(error);
    if (status === 404) throw new HttpError(404, 'NOT_FOUND', 'Ardent resource not found');
    if (status === 400) throw new HttpError(400, 'VALIDATION_ERROR', 'Ardent rejected the read');
    throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', error instanceof Error ? error.message.slice(0, 300) : 'Ardent node unavailable');
  }
  // A service gets the same text and revision a person sees, and nothing Ardent may add later.
  if (service && resource === 'config') {
    const config = ardentConfigFileSchema.safeParse(data);
    if (!config.success) throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', 'Ardent returned an unexpected configuration');
    return c.json({ success: true, data: { revision: config.data.revision, text: config.data.text } });
  }
  return c.json({ success: true, data });
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
  'identity-save': ardentIdentityEditSchema, 'skill-set': ardentSkillEditSchema, 'config-save': ardentConfigEditSchema,
  'skill-install': ardentSkillInstallSchema,
};
/** Targets checked here; the node agent checks them again. */
const ACTION_TARGETS: Partial<Record<string, RegExp>> = { 'identity-save': /^(?:soul|identity)$/, 'skill-set': /^[A-Za-z0-9_-]{1,100}$/ };

/**
 * A service's config-save may change only ARDENT_SERVICE_CONFIG_PATHS. Compare the edit with the
 * configuration it was based on, which must still be current; Ardent refuses the save if it changes
 * after this check. Answers the changed paths for the audit.
 */
async function checkServiceConfigEdit(nodeId: string, profile: string, body: unknown): Promise<string[]> {
  const edit = ardentConfigEditSchema.parse(body);
  let current: { revision: string; text: string };
  try { current = ardentConfigFileSchema.parse(await getArdentProfileResource(nodeId, profile, 'config')); }
  catch (error: unknown) {
    if (refusedStatus(error) === 404) throw new HttpError(404, 'NOT_FOUND', 'Ardent profile not found');
    throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', 'The current Ardent configuration could not be read');
  }
  if (current.revision !== edit.revision) throw new HttpError(409, 'CONFLICT', 'The Ardent revision changed; read it again and reapply the change');
  let result: { changed: string[]; forbidden: string[] };
  try { result = classifyServiceConfigEdit(current.text, edit.text); }
  catch (error: unknown) { throw new HttpError(400, 'VALIDATION_ERROR', error instanceof Error ? error.message : 'Invalid configuration'); }
  if (result.forbidden.length) throw new HttpError(403, 'CONFIG_PATH_FORBIDDEN',
    `A service may change only the model, provider limits, enabled skills and artifact size; refused: ${result.forbidden.slice(0, 10).join(', ')}`.slice(0, 500));
  return result.changed;
}

const Action = z.object({
  action: z.enum(['command-reconcile', 'profile-create', 'session-open', 'config-validate', 'config-save', 'peer-validate', 'peer-save', 'identity-save', 'identity-restore', 'provider-test', 'channel-test', 'peer-test', 'memory-search', 'task-submit', 'task-cancel', 'mission-submit', 'task-pause', 'task-resume', 'preview-submit', 'development-note', 'skill-set', 'service-start', 'service-stop', 'service-restart', 'package-install', 'context-stage', 'context-adopt', 'context-rollback', 'skill-install']),
  target: z.string().min(1).max(128).optional(), body: z.unknown().optional(),
}).strict();
ardentRouter.post('/installations/:nodeId/profiles/:name/action', async c => {
  const nodeId = id(c.req.param('nodeId'));
  const profile = id(c.req.param('name'));
  const parsed = Action.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid Ardent action');
  const { action, target, body } = parsed.data;
  const service = getUser(c).service !== undefined;
  if (service && !SERVICE_ACTIONS.has(action)) throw new HttpError(403, 'FORBIDDEN', 'A service identity may only open sessions, run tasks, missions and previews, record development notes, and change identity, skills and model settings');
  if (action === 'command-reconcile') {
    // Node-wide, like package-install: the profile segment only satisfies the route. ADMIN people only.
    const actor = ardentActor(c, true);
    if (!target || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(target)) throw new HttpError(400, 'VALIDATION_ERROR', 'command-reconcile needs the command ID as target');
    const decision = ArdentCommandReconcileSchema.safeParse(body);
    if (!decision.success) throw new HttpError(400, 'VALIDATION_ERROR', decision.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 500));
    return c.json({ success: true, data: await reconcileArdentCommandOwner(nodeId, target, decision.data, actor) });
  }
  const adminAction = SERVICE_ADMIN_ACTIONS.has(action);
  const actor = ardentActor(c, adminAction, adminAction || SERVICE_SUBJECT_ACTIONS.has(action));
  if (['context-stage', 'context-adopt', 'context-rollback'].includes(action)
    && (target !== undefined || !ArdentContextAdoptionInputSchema.safeParse(body).success))
    throw new HttpError(400, 'VALIDATION_ERROR', 'Context adoption requires exact release, source and policy pins without an arbitrary target');
  const shape = ACTION_BODIES[action]?.safeParse(body);
  if (shape && !shape.success) throw new HttpError(400, 'VALIDATION_ERROR', shape.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 500));
  const targetPattern = ACTION_TARGETS[action];
  if (targetPattern && (!target || !targetPattern.test(target))) throw new HttpError(400, 'VALIDATION_ERROR', `Invalid ${action} target`);
  const configPaths = service && action === 'config-save' ? await checkServiceConfigEdit(nodeId, profile, body) : undefined;
  if ((action === 'task-pause' || action === 'task-resume') && (!target || !/^[0-9a-f-]{36}$/.test(target) || (body !== undefined && !z.object({}).strict().safeParse(body).success)))
    throw new HttpError(400, 'VALIDATION_ERROR', 'Task pause and resume need the task ID as target and no body');
  if (MISSION_ACTIONS.has(action) || (action === 'session-open' && body && typeof body === 'object' && 'context' in body))
    await requireArdentStudioAgent(nodeId, ARDENT_STUDIO_CAPABILITY.missions);
  else if (action === 'session-open' || (action === 'task-submit' && body && typeof body === 'object' && 'session_id' in body))
    await requireArdentStudioAgent(nodeId);
  if (action === 'skill-install' && target !== undefined) throw new HttpError(400, 'VALIDATION_ERROR', 'skill-install names the skill in its body, not as a target');
  // A skill installation sends the node the release Magnus fetched and checked, never anything the caller sent.
  let nodeBody = body;
  let installDetails: Record<string, unknown> = {};
  if (action === 'skill-install') {
    const request = ardentSkillInstallSchema.parse(body);
    await requireArdentStudioAgent(nodeId, ARDENT_STUDIO_CAPABILITY.skillInstall);
    installDetails = { source: request.source, name: request.name, version: request.version, channel: request.channel ?? 'stable', enable: request.enable ?? false };
    let release: Awaited<ReturnType<typeof fetchArdentSkillRelease>>;
    try { release = await fetchArdentSkillRelease(request); }
    catch (error: unknown) {
      const failure = error instanceof HttpError ? error : new HttpError(503, 'DEPENDENCY_UNAVAILABLE', 'The HiveSkills release could not be fetched');
      await logAuditEvent({ action: 'ardent.skill-install', actorId: actor.actorId, targetType: 'ardent-profile', targetId: `${nodeId}:${profile}`,
        details: { target: null, ...actor.details, ...installDetails, outcome: 'failed', code: failure.code, dispatched: false } });
      throw failure;
    }
    installDetails = { ...installDetails, sha256: release.sha256, files: release.files };
    nodeBody = { ...request, sha256: release.sha256, archive_base64: release.archiveBase64 };
  }
  try {
    const result = await performArdentAction(nodeId, profile, action, target, nodeBody);
    await logAuditEvent({ action: `ardent.${action}`, actorId: actor.actorId,
      targetType: 'ardent-profile', targetId: `${nodeId}:${profile}`, details: {
        target: target ?? null, ...actor.details, ...actionAuditDetails(action, body), ...installDetails, ...(configPaths ? { configPaths } : {}),
        ...(['context-stage', 'context-adopt', 'context-rollback'].includes(action) ? ArdentContextAdoptionInputSchema.parse(body) : {})
      } });
    return c.json({ success: true, data: result });
  } catch (error: unknown) {
    // A held command owner, or this action's own unknown outcome, blocks the node: say which and what to do.
    const blocked = await ardentOwnerBlock(nodeId, error).catch(() => undefined);
    const refusal = blocked ?? (MISSION_ACTIONS.has(action) ? ardentRefusal(error) : REVISION_ACTIONS.has(action) ? revisionRefusal(error)
      : action === 'skill-install' ? skillInstallRefusal(error) : undefined);
    const failure = refusal ?? new HttpError(503, 'DEPENDENCY_UNAVAILABLE', actionFailure(error));
    try {
      await logAuditEvent({ action: `ardent.${action}`, actorId: actor.actorId, targetType: 'ardent-profile', targetId: `${nodeId}:${profile}`,
        details: { target: target ?? null, ...actor.details, ...installDetails, outcome: failure.code === 'ARDENT_OUTCOME_UNKNOWN' ? 'unknown' : 'failed',
          code: failure.code, commandId: managedCommandOf(error) ?? null } });
    } catch (auditError: unknown) {
      console.warn(`[ardent] audit of a failed ${action} on ${nodeId}:${profile} failed: ${auditError instanceof Error ? auditError.message : String(auditError)}`);
    }
    throw failure;
  }
});

/** What a failed action reports: the node agent's own reason when it gave one. */
function actionFailure(error: unknown): string {
  if (error instanceof AgentResponseError && error.agentMessage) return `Ardent action failed: ${error.agentMessage}`.slice(0, 300);
  return error instanceof Error ? error.message.slice(0, 300) : 'Ardent action unavailable';
}

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
