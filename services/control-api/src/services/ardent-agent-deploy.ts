/**
 * New Agent and Enable HiveMem: durable, resumable operations that compose the
 * node agent's existing Ardent actions. Each step is audited and leaves a
 * receipt; a failure stops the operation with every receipt kept, and resume
 * reruns only the steps that did not finish.
 *
 * Ardent serves its management API from the running gateway, so a new profile
 * is started before its identity, configuration and skills are written, and
 * restarted once at the end to activate them.
 */
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';
import { ardentAgentDeployRequestSchema, type ArdentFleetInstallation } from '@hivemagnus/magnus-contracts';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';
import { logAuditEvent } from './audit-service.js';
import { getArdentInstallation, getArdentProfileResource, performArdentAction, requireArdentStudioAgent } from './ardent-service.js';
import {
  ARDENT_HIVEMEM_TOKEN_ENV, ardentHiveMemAgentId, HiveMemEnrollmentError, planArdentHiveMemCredential, prepareArdentHiveMem,
  requestArdentHiveMemCredential, requireArdentHiveMemSettings, type ArdentHiveMemPlan, type ArdentHiveMemSettings,
} from './ardent-hivemem.js';
import type { z } from 'zod';

export type ArdentAgentDeployInput = z.infer<typeof ardentAgentDeployRequestSchema>;
type StepName = 'profile-check' | 'profile-create' | 'service-start' | 'identity-soul' | 'identity-identity'
  | 'hivemem-enroll' | 'config-save' | 'skill-set' | 'service-restart' | 'ready-probe';
type StepStatus = 'pending' | 'running' | 'succeeded' | 'skipped' | 'failed';
interface Step { name: StepName; status: StepStatus; startedAt: string | null; finishedAt: string | null; receipt: Record<string, unknown> | null; error: string | null }
type Kind = 'deploy' | 'hivemem';
/** The stored request: the deploy input with its port resolved, or the profile for a backfill. */
type StoredRequest = (Omit<ArdentAgentDeployInput, 'apiPort'> & { apiPort: number }) | { nodeId: string; profile: string; hivemem: true };

export const ARDENT_DEPLOY_STEPS: readonly StepName[] = ['profile-create', 'service-start', 'identity-soul', 'identity-identity',
  'hivemem-enroll', 'config-save', 'skill-set', 'service-restart', 'ready-probe'];
export const ARDENT_HIVEMEM_STEPS: readonly StepName[] = ['profile-check', 'hivemem-enroll', 'config-save', 'service-restart', 'ready-probe'];
const PORT_RANGE = { first: 9910, last: 9999 };
/** A running operation no process has touched for this long was interrupted (for example by a restart). */
const STALE_MS = 2 * 60_000;

/** Who started or resumed an operation, as the audit records it. */
export interface ArdentOperationActor { actorId: string; details: Record<string, unknown> }

export interface ArdentDeployDeps {
  installation(nodeId: string): Promise<ArdentFleetInstallation>;
  read<T>(nodeId: string, profile: string, resource: string): Promise<T>;
  action(nodeId: string, profile: string, action: string, target?: string, body?: unknown): Promise<unknown>;
  studio(nodeId: string): Promise<void>;
  hivemem(): ArdentHiveMemSettings;
  /** Before an operation starts: Magnus reaches HiveMem as itself and the agents' workspace exists. */
  prepare(settings: ArdentHiveMemSettings): Promise<void>;
  credential(settings: ArdentHiveMemSettings, plan: ArdentHiveMemPlan): ReturnType<typeof requestArdentHiveMemCredential>;
  delay(ms: number): Promise<void>;
}

const defaultDeps: ArdentDeployDeps = {
  installation: getArdentInstallation,
  read: (nodeId, profile, resource) => getArdentProfileResource(nodeId, profile, resource) as never,
  action: performArdentAction,
  studio: requireArdentStudioAgent,
  hivemem: requireArdentHiveMemSettings,
  prepare: settings => prepareArdentHiveMem(settings),
  credential: (settings, plan) => requestArdentHiveMemCredential(settings, plan),
  delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
};
let deps = defaultDeps;
/** Replace node, HiveMem and timer access in tests. Returns a restore function. */
export function setArdentDeployDeps(overrides: Partial<ArdentDeployDeps>): () => void {
  deps = { ...defaultDeps, ...overrides };
  return () => { deps = defaultDeps; };
}

/** Operations this process is executing, so a resume never runs the same steps twice. */
const active = new Map<string, Promise<void>>();

function emberpathUrl(): string {
  const raw = process.env['MAGNUS_ARDENT_EMBERPATH_URL'];
  if (!raw) throw new HttpError(503, 'EMBERPATH_UNAVAILABLE', 'An Emberpath alias needs MAGNUS_ARDENT_EMBERPATH_URL on the server');
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('invalid');
    return url.toString();
  } catch { throw new HttpError(503, 'EMBERPATH_UNAVAILABLE', 'MAGNUS_ARDENT_EMBERPATH_URL must be an HTTP(S) URL without credentials'); }
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/** artifacts.max_bytes a New Agent gets when the request does not set it: 64 MiB, the node agent's default relay cap. */
export const ARDENT_NEW_AGENT_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;

function newerOrEqual(version: string | null, wanted: [number, number, number]): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  for (let index = 0; index < 3; index++) if (parts[index] !== wanted[index]) return parts[index]! > wanted[index]!;
  return true;
}

interface Row { id: string; kind: string; nodeId: string; profile: string; status: string; requestJson: string; stepsJson: string;
  error: string | null; createdBy: string; actingJson: string | null; attempts: number; createdAt: Date; updatedAt: Date; completedAt: Date | null }

/** The public view: steps and receipts, the request without its identity texts. */
export function ardentOperationView(row: Row) {
  const request = JSON.parse(row.requestJson) as Partial<StoredRequest & ArdentAgentDeployInput>;
  return {
    id: row.id, kind: row.kind as Kind, nodeId: row.nodeId, profile: row.profile,
    status: row.status as 'running' | 'succeeded' | 'failed', steps: JSON.parse(row.stepsJson) as Step[],
    error: row.error, createdBy: row.createdBy, attempts: row.attempts,
    request: { apiPort: request.apiPort ?? null, model: request.model ?? null, skills: request.skills ?? [], hivemem: true,
      artifacts_max_bytes: request.artifacts_max_bytes ?? null },
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null,
  };
}
export type ArdentOperationView = ReturnType<typeof ardentOperationView>;

export async function getArdentAgentOperation(id: string): Promise<ArdentOperationView> {
  const row = await getDb().ardentAgentOperation.findUnique({ where: { id } });
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Ardent agent operation not found');
  return ardentOperationView(row);
}

async function createOperation(kind: Kind, request: StoredRequest, actor: ArdentOperationActor): Promise<string> {
  const id = randomUUID();
  const steps: Step[] = (kind === 'deploy' ? ARDENT_DEPLOY_STEPS : ARDENT_HIVEMEM_STEPS)
    .map(name => ({ name, status: 'pending', startedAt: null, finishedAt: null, receipt: null, error: null }));
  try {
    await getDb().ardentAgentOperation.create({ data: { id, kind, nodeId: request.nodeId, profile: request.profile,
      requestJson: JSON.stringify(request), stepsJson: JSON.stringify(steps), createdBy: actor.actorId,
      actingJson: Object.keys(actor.details).length ? JSON.stringify(actor.details) : null } });
  } catch (error: unknown) {
    if ((error as { code?: unknown }).code === 'P2002') throw new HttpError(409, 'OPERATION_RUNNING', 'Another operation on this Ardent profile is still running');
    throw error;
  }
  return id;
}

/** Validate, resolve the API port, record the operation and start it. Returns the operation ID. */
export async function startArdentAgentDeploy(raw: unknown, actor: ArdentOperationActor): Promise<string> {
  const parsed = ardentAgentDeployRequestSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'VALIDATION_ERROR', parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 500));
  const input = parsed.data;
  const hivemem = deps.hivemem();
  if ('emberpath_alias' in input.model) emberpathUrl();
  await deps.studio(input.nodeId);
  await deps.prepare(hivemem);
  const installation = await deps.installation(input.nodeId);
  if (!installation.reachable) throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', installation.error ?? 'Ardent node unavailable');
  if (!installation.installed) throw new HttpError(409, 'ARDENT_NOT_INSTALLED', 'Install the Ardent package on this node first');
  if (installation.profiles.some(profile => profile.id === input.profile)) throw new HttpError(409, 'PROFILE_EXISTS', 'An Ardent profile with this ID already exists on the node');
  const used = new Set(installation.profiles.map(profile => profile.apiPort).filter((port): port is number => port !== null));
  let apiPort = input.apiPort;
  if (apiPort !== undefined && used.has(apiPort)) throw new HttpError(409, 'PORT_IN_USE', `API port ${apiPort} is assigned to another profile`);
  if (apiPort === undefined) {
    for (let port = PORT_RANGE.first; port <= PORT_RANGE.last && apiPort === undefined; port++) if (!used.has(port)) apiPort = port;
    if (apiPort === undefined) throw new HttpError(409, 'PORT_IN_USE', 'No free Ardent API port from 9910 to 9999; choose one');
  }
  const id = await createOperation('deploy', { ...input, apiPort }, actor);
  await logAuditEvent({ action: 'ardent.agent.deploy', actorId: actor.actorId, targetType: 'ardent-profile', targetId: `${input.nodeId}:${input.profile}`,
    details: { operationId: id, apiPort, model: 'emberpath_alias' in input.model ? { emberpath_alias: input.model.emberpath_alias } : { base_url: input.model.base_url, model: input.model.model },
      skills: input.skills, ...actor.details } });
  launch(id);
  return id;
}

/** Enable HiveMem on an existing, running profile (the backfill for agents created before New Agent). */
export async function startArdentHiveMemEnable(nodeId: string, profile: string, actor: ArdentOperationActor): Promise<string> {
  const hivemem = deps.hivemem();
  await deps.studio(nodeId);
  await deps.prepare(hivemem);
  const id = await createOperation('hivemem', { nodeId, profile, hivemem: true }, actor);
  await logAuditEvent({ action: 'ardent.hivemem.enable', actorId: actor.actorId, targetType: 'ardent-profile', targetId: `${nodeId}:${profile}`,
    details: { operationId: id, ...actor.details } });
  launch(id);
  return id;
}

/** Rerun a failed (or interrupted) operation from its first unfinished step. */
export async function resumeArdentAgentOperation(id: string, actor: ArdentOperationActor): Promise<string> {
  const db = getDb();
  const row = await db.ardentAgentOperation.findUnique({ where: { id } });
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Ardent agent operation not found');
  const interrupted = row.status === 'running' && !active.has(id) && Date.now() - row.updatedAt.getTime() > STALE_MS;
  if (row.status !== 'failed' && !interrupted) throw new HttpError(409, 'OPERATION_NOT_RESUMABLE', `The operation is ${row.status}; only a failed operation can be resumed`);
  const steps = (JSON.parse(row.stepsJson) as Step[]).map(step => step.status === 'failed' || step.status === 'running'
    ? { ...step, status: 'pending' as const, error: null, finishedAt: null } : step);
  try {
    const updated = await db.ardentAgentOperation.updateMany({ where: { id, status: row.status, updatedAt: row.updatedAt },
      data: { status: 'running', error: null, completedAt: null, stepsJson: JSON.stringify(steps), attempts: { increment: 1 } } });
    if (updated.count !== 1) throw new HttpError(409, 'OPERATION_NOT_RESUMABLE', 'The operation changed; read it again');
  } catch (error: unknown) {
    if ((error as { code?: unknown }).code === 'P2002') throw new HttpError(409, 'OPERATION_RUNNING', 'Another operation on this Ardent profile is still running');
    throw error;
  }
  await logAuditEvent({ action: 'ardent.agent.resume', actorId: actor.actorId, targetType: 'ardent-profile', targetId: `${row.nodeId}:${row.profile}`,
    details: { operationId: id, attempt: row.attempts + 1, ...actor.details } });
  launch(id);
  return id;
}

function launch(id: string): void {
  if (active.has(id)) return;
  const run = runOperation(id).catch((error: unknown) => {
    console.warn(`[ardent-agent-deploy] operation ${id} stopped: ${message(error)}`);
  }).finally(() => active.delete(id));
  active.set(id, run);
}

/** Wait for this process's run of an operation (tests and graceful shutdown). */
export async function settleArdentAgentOperation(id: string): Promise<void> {
  await active.get(id);
}

interface Context { row: Row; request: StoredRequest; steps: Step[]; step: Step; save(): Promise<void> }
type Result = { skipped?: boolean; receipt: Record<string, unknown> };

async function runOperation(id: string): Promise<void> {
  const db = getDb();
  const row = await db.ardentAgentOperation.findUnique({ where: { id } }) as Row | null;
  if (!row || row.status !== 'running') return;
  const steps = JSON.parse(row.stepsJson) as Step[];
  const request = JSON.parse(row.requestJson) as StoredRequest;
  const save = async (patch: Partial<{ status: string; error: string | null; completedAt: Date }> = {}) => {
    await db.ardentAgentOperation.update({ where: { id }, data: { stepsJson: JSON.stringify(steps), ...patch } });
  };
  for (const step of steps) {
    if (step.status === 'succeeded' || step.status === 'skipped') continue;
    step.status = 'running';
    step.startedAt = new Date().toISOString();
    step.error = null;
    await save();
    const context: Context = { row, request, steps, step, save: () => save() };
    let result: Result;
    try {
      result = await STEPS[step.name](context);
    } catch (error: unknown) {
      step.status = 'failed';
      step.error = message(error);
      step.finishedAt = new Date().toISOString();
      await save({ status: 'failed', error: `${step.name}: ${step.error}`, completedAt: new Date() });
      await logAuditEvent({ action: 'ardent.agent.step', actorId: row.createdBy, targetType: 'ardent-profile', targetId: `${row.nodeId}:${row.profile}`,
        details: { operationId: id, step: step.name, status: 'failed', error: step.error } });
      return;
    }
    step.status = result.skipped ? 'skipped' : 'succeeded';
    step.receipt = { ...step.receipt, ...result.receipt };
    step.finishedAt = new Date().toISOString();
    await save();
    await logAuditEvent({ action: 'ardent.agent.step', actorId: row.createdBy, targetType: 'ardent-profile', targetId: `${row.nodeId}:${row.profile}`,
      details: { operationId: id, step: step.name, status: step.status } });
  }
  await save({ status: 'succeeded', error: null, completedAt: new Date() });
  await logAuditEvent({ action: 'ardent.agent.complete', actorId: row.createdBy, targetType: 'ardent-profile', targetId: `${row.nodeId}:${row.profile}`,
    details: { operationId: id, kind: row.kind } });
}

const isDeploy = (request: StoredRequest): request is Extract<StoredRequest, { apiPort: number }> => 'apiPort' in request;

async function profileOf(context: Context) {
  const installation = await deps.installation(context.row.nodeId);
  if (!installation.reachable) throw new Error(installation.error ?? 'Ardent node unavailable');
  return { installation, profile: installation.profiles.find(item => item.id === context.row.profile) };
}

async function identityStep(context: Context, kind: 'soul' | 'identity'): Promise<Result> {
  const request = context.request;
  if (!isDeploy(request)) throw new Error('Identity steps belong to New Agent');
  const desired = kind === 'soul' ? request.soul_md : request.identity_md;
  const current = await deps.read<{ text: string; revision: string }>(context.row.nodeId, context.row.profile, `identity/${kind}`);
  if (current.text === desired) return { skipped: true, receipt: { revision: current.revision, unchanged: true } };
  const saved = await deps.action(context.row.nodeId, context.row.profile, 'identity-save', kind, { text: desired, revision: current.revision }) as { revision?: unknown };
  return { receipt: { revision: typeof saved?.revision === 'string' ? saved.revision : null, bytes: Buffer.byteLength(desired) } };
}

const STEPS: Record<StepName, (context: Context) => Promise<Result>> = {
  'profile-check': async context => {
    const { installation, profile } = await profileOf(context);
    if (!profile) throw new Error('Ardent profile not found on the node');
    if (!profile.running) throw new Error('Start the Ardent profile before enabling HiveMem');
    return { receipt: { apiPort: profile.apiPort, version: installation.version } };
  },

  'profile-create': async context => {
    const request = context.request;
    if (!isDeploy(request)) throw new Error('profile-create belongs to New Agent');
    const { installation, profile } = await profileOf(context);
    if (profile) {
      // A retried creation whose earlier attempt reached the node: adopt exactly that profile.
      if (context.row.attempts > 1 && profile.apiPort === request.apiPort) return { skipped: true, receipt: { apiPort: profile.apiPort, adopted: true } };
      throw new Error('An Ardent profile with this ID already exists on the node');
    }
    await deps.action(context.row.nodeId, context.row.profile, 'profile-create', undefined, { api_port: request.apiPort });
    return { receipt: { apiPort: request.apiPort, version: installation.version } };
  },

  'service-start': async context => {
    const { profile } = await profileOf(context);
    if (profile?.running) return { skipped: true, receipt: { running: true } };
    const result = await deps.action(context.row.nodeId, context.row.profile, 'service-start') as { service?: unknown };
    return { receipt: { service: typeof result?.service === 'string' ? result.service : null, running: true } };
  },

  'identity-soul': context => identityStep(context, 'soul'),
  'identity-identity': context => identityStep(context, 'identity'),

  'hivemem-enroll': async context => {
    const settings = deps.hivemem();
    const name = (await deps.installation(context.row.nodeId)).nodeName;
    const plan = (action: 'enroll' | 'rotate') => planArdentHiveMemCredential(settings, { operationId: `${context.row.id}:${context.row.attempts}`,
      nodeId: context.row.nodeId, nodeName: name, profile: context.row.profile, action });
    // The plan is stored before the request, so a retry repeats it and HiveMem replays the same credential.
    let current = (context.step.receipt?.['plan'] as ArdentHiveMemPlan | undefined) ?? plan('enroll');
    const remember = async () => { context.step.receipt = { ...context.step.receipt, plan: current }; await context.save(); };
    await remember();
    let issued: Awaited<ReturnType<ArdentDeployDeps['credential']>> | undefined;
    for (let tries = 0; !issued; tries++) {
      try {
        issued = await deps.credential(settings, current);
      } catch (error: unknown) {
        const replacement = plan('rotate');
        // 409: the agent ID already exists (an earlier profile of this name). 410: an earlier
        // attempt's receipt expired before its token reached the node. Both rotate, which
        // also invalidates any credential that never arrived.
        if (tries > 0 || !(error instanceof HiveMemEnrollmentError) || ![409, 410].includes(error.status) || replacement.key === current.key) throw error;
        current = replacement;
        await remember();
      }
    }
    await deps.action(context.row.nodeId, context.row.profile, 'hivemem-credential-set', undefined, { token: issued.token });
    return { receipt: { plan: current, agentId: issued.agentId, workspaceId: settings.workspaceId, expiresAt: issued.expiresAt,
      action: current.action, tokenEnv: ARDENT_HIVEMEM_TOKEN_ENV } };
  },

  'config-save': async context => {
    const settings = deps.hivemem();
    const request = context.request;
    const agentId = context.steps.find(step => step.name === 'hivemem-enroll')?.receipt?.['agentId'] as string | undefined;
    const config = await deps.read<{ revision: string; text: string }>(context.row.nodeId, context.row.profile, 'config');
    const document = YAML.parseDocument(config.text, { uniqueKeys: true });
    const notes: string[] = [];
    if (isDeploy(request)) {
      document.setIn(['execution', 'backend'], 'llamacpp');
      const model = 'emberpath_alias' in request.model ? { base_url: emberpathUrl(), model: request.model.emberpath_alias } : request.model;
      document.setIn(['providers', 'llamacpp', 'base_url'], model.base_url);
      document.setIn(['providers', 'llamacpp', 'model'], model.model);
      // Ardent 2.2.0 added artifacts.max_bytes (default 2 MiB). A new agent gets the node agent's relay cap unless told otherwise.
      const { installation } = await profileOf(context);
      if (newerOrEqual(installation.version, [2, 2, 0])) document.setIn(['artifacts', 'max_bytes'], request.artifacts_max_bytes ?? ARDENT_NEW_AGENT_ARTIFACT_MAX_BYTES);
      else if (request.artifacts_max_bytes !== undefined) notes.push(`artifacts.max_bytes needs Ardent 2.2.0 or later; this node runs ${installation.version ?? 'an unknown version'}`);
    }
    document.setIn(['memory'], document.createNode({ provider: 'hivemem', base_url: settings.agentUrl, token_env: ARDENT_HIVEMEM_TOKEN_ENV,
      agent_id: agentId ?? ardentHiveMemAgentId(context.row.nodeId, context.row.profile), workspace_id: settings.workspaceId, default_scope: 'private' }));
    const text = String(document);
    if (text === config.text) return { skipped: true, receipt: { revision: config.revision, unchanged: true, notes } };
    const saved = await deps.action(context.row.nodeId, context.row.profile, 'config-save', undefined, { text, revision: config.revision }) as { revision?: unknown };
    return { receipt: { revision: typeof saved?.revision === 'string' ? saved.revision : null, activationRequired: true, notes } };
  },

  'skill-set': async context => {
    const request = context.request;
    const wanted = isDeploy(request) ? [...new Set(request.skills)] : [];
    if (!wanted.length) return { skipped: true, receipt: { enabled: [] } };
    const enabled: string[] = [];
    const already: string[] = [];
    for (const skill of wanted) {
      const config = await deps.read<{ revision: string; text: string }>(context.row.nodeId, context.row.profile, 'config');
      const current = (YAML.parse(config.text) as { skills?: { enabled?: unknown } } | null)?.skills?.enabled;
      if (Array.isArray(current) && current.includes(skill)) { already.push(skill); continue; }
      await deps.action(context.row.nodeId, context.row.profile, 'skill-set', skill, { enabled: true, revision: config.revision });
      enabled.push(skill);
    }
    return { skipped: enabled.length === 0, receipt: { enabled, alreadyEnabled: already } };
  },

  'service-restart': async context => {
    const result = await deps.action(context.row.nodeId, context.row.profile, 'service-restart') as { running?: unknown };
    return { receipt: { running: result?.running === true } };
  },

  'ready-probe': async context => {
    let last = 'no answer';
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        const status = await deps.read<{ version?: unknown; backend?: unknown }>(context.row.nodeId, context.row.profile, 'status');
        const memory = await deps.read<{ status?: unknown; agent_id?: unknown; reason?: unknown }>(context.row.nodeId, context.row.profile, 'memory/status');
        if (memory?.status === 'ready') return { receipt: { attempts: attempt, version: status?.version ?? null, backend: status?.backend ?? null,
          memory: 'ready', agentId: memory.agent_id ?? null } };
        last = `HiveMem is ${String(memory?.status ?? 'unknown')}${typeof memory?.reason === 'string' ? `: ${memory.reason}` : ''}`;
      } catch (error: unknown) { last = message(error); }
      if (attempt < 10) await deps.delay(3000);
    }
    throw new Error(`The agent did not become ready: ${last}`);
  },
};
