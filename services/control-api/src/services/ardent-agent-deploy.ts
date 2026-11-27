/**
 * New Agent, Enable HiveMem and Set Emberpath key: durable, resumable operations that compose the
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
import { agentPersonaSha256, ARDENT_INSTANCE_REF_ENV, ARDENT_MODEL_API_KEY_ENV, ardentAgentModelCredentialRequestSchema, ardentAgentOperationResumeRequestSchema, ARDENT_STUDIO_CAPABILITY, ardentInstanceRef, ardentAgentDeployRequestSchema, type ArdentCommandOwner, type ArdentFleetInstallation,
  type ArdentSkillInstall, type ArdentSkillInstallResult, type ArdentSkillReceipts } from '@hivemagnus/magnus-contracts';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';
import { logAuditEvent } from './audit-service.js';
import { ardentCommandOwners, ardentOwnerBlock, describeOwner } from './ardent-command-owner.js';
import { getArdentInstallation, getArdentProfileResource, getArdentSkillReceipts, performArdentAction, requireArdentStudioAgent } from './ardent-service.js';
import { fetchArdentSkillRelease, type ArdentSkillRelease } from './ardent-hiveskills.js';
import { dependencyReport, discoveredEndpoint } from './discovery.js';
import {
  ARDENT_HIVEMEM_TOKEN_ENV, ardentHiveMemAgentId, ardentHiveMemSupportsRenewal, HiveMemEnrollmentError, planArdentHiveMemCredential,
  prepareArdentHiveMem, requestArdentHiveMemCredential, requireArdentHiveMemSettings, type ArdentHiveMemAction, type ArdentHiveMemPlan,
  type ArdentHiveMemSettings,
} from './ardent-hivemem.js';
import { recordArdentHiveMemCredential } from './ardent-hivemem-renewal.js';
import {
  checkEmberpathClientKey, EMBERPATH_KEY_MISSING, EMBERPATH_KEY_NOT_EXPLICIT, heldEmberpathClientKey, holdEmberpathClientKey, releaseEmberpathClientKey,
  type EmberpathKeyCheck,
} from './ardent-emberpath-key.js';
import type { z } from 'zod';

export type ArdentAgentDeployInput = z.infer<typeof ardentAgentDeployRequestSchema>;
type StepName = 'profile-check' | 'profile-create' | 'service-start' | 'identity-soul' | 'identity-identity'
  | 'hivemem-enroll' | 'extensions-install' | 'config-save' | 'skill-set' | 'skill-install' | 'service-restart' | 'ready-probe';
type StepStatus = 'pending' | 'running' | 'succeeded' | 'skipped' | 'failed';
interface Step { name: StepName; status: StepStatus; startedAt: string | null; finishedAt: string | null; receipt: Record<string, unknown> | null; error: string | null }
type Kind = 'deploy' | 'hivemem' | 'definition' | 'model-credential';
/**
 * What a definition install adds to New Agent: the definition's identity and digests, the runtime settings
 * New Agent does not set, the reviewed extensions and plugin specifiers, and the pinned skills. Persona texts
 * travel in soul_md and identity_md as for New Agent.
 */
export interface ArdentStoredDefinition {
  name: string; sha256: string; personaSha256: string;
  execution: { deadline_seconds?: number; max_parallel_tasks?: number; max_parallel_tool_calls?: number };
  extensions: Array<{ name: string; version: string; integrity: string; package_tree_sha256: string }>;
  plugins: string[];
  skills: Array<{ slug: string; version: string; sha256: string }>;
}
/** The stored deploy input: never the Emberpath client key, which only this process's memory holds until it is delivered. */
type DeployRequest = Omit<ArdentAgentDeployInput, 'apiPort' | 'emberpath_client_key'> & { apiPort: number; definition?: ArdentStoredDefinition };
/** Set Emberpath key on an existing agent: the profile and the alias its configuration names, never the key. */
type ModelCredentialRequest = { nodeId: string; profile: string; modelCredential: { emberpath_alias: string } };
/** The stored request: the deploy input with its port resolved, the profile for a backfill, or a key to set. */
type StoredRequest = DeployRequest | { nodeId: string; profile: string; hivemem: true } | ModelCredentialRequest;

export const ARDENT_DEPLOY_STEPS: readonly StepName[] = ['profile-create', 'service-start', 'identity-soul', 'identity-identity',
  'hivemem-enroll', 'config-save', 'skill-set', 'service-restart', 'ready-probe'];
export const ARDENT_HIVEMEM_STEPS: readonly StepName[] = ['profile-check', 'hivemem-enroll', 'config-save', 'service-restart', 'ready-probe'];
/** Set Emberpath key: config-save writes the key to the profile's .env and names it in the configuration; the restart activates it. */
export const ARDENT_MODEL_CREDENTIAL_STEPS: readonly StepName[] = ['profile-check', 'config-save', 'service-restart', 'ready-probe'];
/** New Agent for a definition: its reviewed extensions are checked before the configuration names them, and its skills install pinned. */
export const ARDENT_DEFINITION_STEPS: readonly StepName[] = ['profile-create', 'service-start', 'identity-soul', 'identity-identity',
  'hivemem-enroll', 'extensions-install', 'config-save', 'skill-install', 'service-restart', 'ready-probe'];
const PORT_RANGE = { first: 9910, last: 9999 };
/** A running operation no process has touched for this long was interrupted (for example by a restart). */
const STALE_MS = 2 * 60_000;

/** Who started or resumed an operation, as the audit records it. */
export interface ArdentOperationActor { actorId: string; details: Record<string, unknown> }

export interface ArdentDeployDeps {
  installation(nodeId: string): Promise<ArdentFleetInstallation>;
  read<T>(nodeId: string, profile: string, resource: string): Promise<T>;
  action(nodeId: string, profile: string, action: string, target?: string, body?: unknown): Promise<unknown>;
  studio(nodeId: string, level?: number): Promise<void>;
  /** Refresh dependency discovery when its report is stale, so defaults reflect the Hive Registry. */
  discover(): Promise<void>;
  /** Fetch and check a pinned HiveSkills release whose digest must be `sha256`. */
  skillRelease(request: ArdentSkillInstall, sha256: string): Promise<ArdentSkillRelease>;
  skillReceipts(nodeId: string, profile: string): Promise<ArdentSkillReceipts>;
  hivemem(): ArdentHiveMemSettings;
  /** Before an operation starts: Magnus reaches HiveMem as itself and the agents' workspace exists. */
  prepare(settings: ArdentHiveMemSettings): Promise<void>;
  credential(settings: ArdentHiveMemSettings, plan: ArdentHiveMemPlan): ReturnType<typeof requestArdentHiveMemCredential>;
  /** Whether HiveMem can renew a credential with a new deadline, rather than only rotate it. */
  supportsRenewal(settings: ArdentHiveMemSettings): Promise<boolean>;
  /** Remember the credential delivered to a profile, so the renewal job keeps it ahead of its deadline. */
  record(input: Parameters<typeof recordArdentHiveMemCredential>[0]): Promise<void>;
  delay(ms: number): Promise<void>;
  /** Command owners holding the node, oldest first. */
  owners(nodeId: string): Promise<ArdentCommandOwner[]>;
  /** Why a step's failure blocks the node, when a command owner is the cause. */
  explain(nodeId: string, error: unknown): Promise<Error | undefined>;
  /** Whether the Emberpath URL is the explicit MAGNUS_ARDENT_EMBERPATH_URL rather than one the Hive Registry resolved. */
  emberpathExplicit(): boolean;
  /** Ask Emberpath whether a client key may use an alias; throws a 422 HttpError on a definite refusal. */
  emberpathKey(baseUrl: string, key: string, alias: string): Promise<EmberpathKeyCheck>;
}

const defaultDeps: ArdentDeployDeps = {
  installation: getArdentInstallation,
  read: (nodeId, profile, resource) => getArdentProfileResource(nodeId, profile, resource) as never,
  action: performArdentAction,
  studio: requireArdentStudioAgent,
  // Only the Registry supplies defaults, so without it there is nothing to refresh (and nothing is probed).
  discover: async () => { if (process.env['MAGNUS_HIVE_REGISTRY_URL']) await dependencyReport(); },
  skillRelease: (request, sha256) => fetchArdentSkillRelease(request, fetch, { expectedSha256: sha256 }),
  skillReceipts: getArdentSkillReceipts,
  hivemem: requireArdentHiveMemSettings,
  prepare: settings => prepareArdentHiveMem(settings),
  credential: (settings, plan) => requestArdentHiveMemCredential(settings, plan),
  supportsRenewal: settings => ardentHiveMemSupportsRenewal(settings),
  record: recordArdentHiveMemCredential,
  delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
  owners: async nodeId => (await ardentCommandOwners([nodeId])).get(nodeId) ?? [],
  explain: ardentOwnerBlock,
  emberpathExplicit: () => Boolean(process.env['MAGNUS_ARDENT_EMBERPATH_URL']),
  emberpathKey: (baseUrl, key, alias) => checkEmberpathClientKey(baseUrl, key, alias),
};
let deps = defaultDeps;
/** Replace node, HiveMem and timer access in tests. Returns a restore function. */
export function setArdentDeployDeps(overrides: Partial<ArdentDeployDeps>): () => void {
  deps = { ...defaultDeps, ...overrides };
  return () => { deps = defaultDeps; };
}

/** Operations this process is executing, so a resume never runs the same steps twice. */
const active = new Map<string, Promise<void>>();

/** MAGNUS_ARDENT_EMBERPATH_URL, or the Emberpath model endpoint the Hive Registry resolved when it is unset. */
export function emberpathUrl(): string {
  const raw = process.env['MAGNUS_ARDENT_EMBERPATH_URL'] || discoveredEndpoint('emberpath');
  if (!raw) throw new HttpError(503, 'EMBERPATH_UNAVAILABLE', 'An Emberpath alias needs MAGNUS_ARDENT_EMBERPATH_URL on the server, or an Emberpath the Hive Registry lists');
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

/** The Agent Card provider of an agent Magnus deploys (Ardent 3.4.0 `a2a.provider`), as every Ardent before 3.4.0 reported it. */
export const ARDENT_MAGNUS_AGENT_CARD_PROVIDER = { organization: 'Magnus', url: 'https://github.com/ChefTaco/magnus' } as const;

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
  const request = JSON.parse(row.requestJson) as Partial<DeployRequest> & Partial<ModelCredentialRequest>;
  return {
    id: row.id, kind: row.kind as Kind, nodeId: row.nodeId, profile: row.profile,
    status: row.status as 'running' | 'succeeded' | 'failed', steps: JSON.parse(row.stepsJson) as Step[],
    error: row.error, createdBy: row.createdBy, attempts: row.attempts,
    request: { apiPort: request.apiPort ?? null, model: request.model ?? request.modelCredential ?? null, skills: request.skills ?? [], hivemem: true,
      artifacts_max_bytes: request.artifacts_max_bytes ?? null,
      definition: request.definition ? { name: request.definition.name, sha256: request.definition.sha256 } : null },
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
  const steps: Step[] = (kind === 'deploy' ? ARDENT_DEPLOY_STEPS : kind === 'definition' ? ARDENT_DEFINITION_STEPS
    : kind === 'model-credential' ? ARDENT_MODEL_CREDENTIAL_STEPS : ARDENT_HIVEMEM_STEPS)
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
  return startDeploy(raw, actor);
}

/**
 * New Agent for a definition whose preflight passed (services/ardent-agent-definition.ts): the same checks
 * and steps, plus the extension check, the definition's runtime settings and its pinned skills.
 */
export async function startArdentDefinitionDeploy(raw: unknown, definition: ArdentStoredDefinition, actor: ArdentOperationActor): Promise<string> {
  return startDeploy(raw, actor, definition);
}

async function startDeploy(raw: unknown, actor: ArdentOperationActor, definition?: ArdentStoredDefinition): Promise<string> {
  const parsed = ardentAgentDeployRequestSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'VALIDATION_ERROR', parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 500));
  const { emberpath_client_key: key, ...input } = parsed.data;
  await deps.discover().catch(() => undefined);
  const hivemem = deps.hivemem();
  const alias = 'emberpath_alias' in input.model ? input.model.emberpath_alias : undefined;
  if (alias === undefined && key !== undefined)
    throw new HttpError(400, 'VALIDATION_ERROR', 'emberpath_client_key belongs to an emberpath_alias model; a base_url model keeps its key in the profile environment');
  let keyCheck: EmberpathKeyCheck | undefined;
  if (alias !== undefined) {
    const gateway = emberpathUrl();
    if (key === undefined) throw new HttpError(400, 'EMBERPATH_KEY_REQUIRED', EMBERPATH_KEY_MISSING);
    if (!deps.emberpathExplicit()) throw new HttpError(409, 'EMBERPATH_NOT_EXPLICIT', EMBERPATH_KEY_NOT_EXPLICIT);
    await deps.studio(input.nodeId, ARDENT_STUDIO_CAPABILITY.modelCredential);
    keyCheck = await deps.emberpathKey(gateway, key, alias);
  }
  await deps.studio(input.nodeId);
  if (definition?.skills.length) await deps.studio(input.nodeId, ARDENT_STUDIO_CAPABILITY.skillInstall);
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
  const id = await createOperation(definition ? 'definition' : 'deploy', { ...input, apiPort, ...(definition ? { definition } : {}) }, actor);
  if (key !== undefined) holdEmberpathClientKey(id, key);
  await logAuditEvent({ action: definition ? 'ardent.agent.definition-install' : 'ardent.agent.deploy', actorId: actor.actorId, targetType: 'ardent-profile', targetId: `${input.nodeId}:${input.profile}`,
    details: { operationId: id, apiPort, model: 'emberpath_alias' in input.model ? { emberpath_alias: input.model.emberpath_alias } : { base_url: input.model.base_url, model: input.model.model },
      skills: input.skills,
      // Whether a key came and what Emberpath said about it; never the key.
      ...(keyCheck ? { emberpathClientKey: keyCheck.checked ? 'checked' : `unchecked: ${keyCheck.reason}` } : {}),
      ...(definition ? { definition: { name: definition.name, sha256: definition.sha256 },
        pinnedSkills: definition.skills.map(skill => `${skill.slug}@${skill.version}`), extensions: definition.extensions.map(item => `${item.name}@${item.version}`) } : {}),
      ...actor.details } });
  launch(id);
  return id;
}

/** Enable HiveMem on an existing, running profile (the backfill for agents created before New Agent). */
export async function startArdentHiveMemEnable(nodeId: string, profile: string, actor: ArdentOperationActor): Promise<string> {
  await deps.discover().catch(() => undefined);
  const hivemem = deps.hivemem();
  await deps.studio(nodeId);
  await deps.prepare(hivemem);
  const id = await createOperation('hivemem', { nodeId, profile, hivemem: true }, actor);
  await logAuditEvent({ action: 'ardent.hivemem.enable', actorId: actor.actorId, targetType: 'ardent-profile', targetId: `${nodeId}:${profile}`,
    details: { operationId: id, ...actor.details } });
  launch(id);
  return id;
}

/**
 * The base URLs an existing profile's model may name to count as served by `gateway` (with or without a final slash).
 */
function sameEndpoint(value: unknown, gateway: string): boolean {
  if (typeof value !== 'string') return false;
  const trim = (url: string) => url.replace(/\/+$/u, '');
  try { return trim(new URL(value).toString()) === trim(gateway); } catch { return false; }
}

/**
 * Set Emberpath key: set or rotate the Emberpath client key of an existing, running agent whose model is an alias
 * served by MAGNUS_ARDENT_EMBERPATH_URL. The same checks as New Agent's key (400 EMBERPATH_KEY_REQUIRED, 409
 * EMBERPATH_NOT_EXPLICIT, studio level 6, Emberpath's model list), then an operation that writes it to the
 * profile's .env (model-credential-set), names it in providers.llamacpp.api_key_env and restarts the profile.
 * The key is held in this process's memory only until config-save has delivered it; it is never stored or audited.
 */
export async function startArdentModelCredentialSet(nodeId: string, profile: string, raw: unknown, actor: ArdentOperationActor): Promise<string> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as Record<string, unknown>)['emberpath_client_key'] === undefined)
    throw new HttpError(400, 'EMBERPATH_KEY_REQUIRED', EMBERPATH_KEY_MISSING);
  const parsed = ardentAgentModelCredentialRequestSchema.safeParse(raw);
  // The issues name the field and the rule, never the value.
  if (!parsed.success) throw new HttpError(400, 'VALIDATION_ERROR', parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 500));
  const key = parsed.data.emberpath_client_key;
  await deps.discover().catch(() => undefined);
  const gateway = emberpathUrl();
  if (!deps.emberpathExplicit()) throw new HttpError(409, 'EMBERPATH_NOT_EXPLICIT', EMBERPATH_KEY_NOT_EXPLICIT);
  await deps.studio(nodeId, ARDENT_STUDIO_CAPABILITY.modelCredential);
  const installation = await deps.installation(nodeId);
  if (!installation.reachable) throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', installation.error ?? 'Ardent node unavailable');
  if (!installation.installed) throw new HttpError(409, 'ARDENT_NOT_INSTALLED', 'Install the Ardent package on this node first');
  const current = installation.profiles.find(item => item.id === profile);
  if (!current) throw new HttpError(404, 'NOT_FOUND', 'Ardent profile not found');
  if (!current.running) throw new HttpError(409, 'PROFILE_NOT_RUNNING', 'Start the Ardent profile before setting its Emberpath key');
  let config: { text: string };
  try { config = await deps.read<{ text: string }>(nodeId, profile, 'config'); }
  catch { throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', 'The Ardent configuration could not be read'); }
  let parsedConfig: { execution?: { backend?: unknown }; providers?: { llamacpp?: { base_url?: unknown; model?: unknown } } } | null;
  try { parsedConfig = YAML.parse(config.text) as typeof parsedConfig; } catch { parsedConfig = null; }
  const llamacpp = parsedConfig?.providers?.llamacpp;
  const alias = typeof llamacpp?.model === 'string' ? llamacpp.model : undefined;
  if (parsedConfig?.execution?.backend !== 'llamacpp' || alias === undefined || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(alias) || !sameEndpoint(llamacpp?.base_url, gateway))
    throw new HttpError(409, 'MODEL_NOT_EMBERPATH', 'This agent\'s model is not an Emberpath alias served by MAGNUS_ARDENT_EMBERPATH_URL '
      + '(execution.backend llamacpp with providers.llamacpp.base_url set to it); an Emberpath client key would not reach its model');
  const keyCheck = await deps.emberpathKey(gateway, key, alias);
  const id = await createOperation('model-credential', { nodeId, profile, modelCredential: { emberpath_alias: alias } }, actor);
  holdEmberpathClientKey(id, key);
  await logAuditEvent({ action: 'ardent.agent.model-credential', actorId: actor.actorId, targetType: 'ardent-profile', targetId: `${nodeId}:${profile}`,
    // Whether Emberpath accepted the key; never the key.
    details: { operationId: id, model: { emberpath_alias: alias }, keyEnv: ARDENT_MODEL_API_KEY_ENV,
      emberpathClientKey: keyCheck.checked ? 'checked' : `unchecked: ${keyCheck.reason}`, ...actor.details } });
  launch(id);
  return id;
}

const isModelCredential = (request: StoredRequest): request is ModelCredentialRequest => 'modelCredential' in request;

/** The Emberpath alias of an operation whose config-save step has not yet delivered the client key, else undefined. */
function aliasAwaitingKey(request: StoredRequest, steps: Step[]): string | undefined {
  const alias = isModelCredential(request) ? request.modelCredential.emberpath_alias
    : isDeploy(request) && 'emberpath_alias' in request.model ? request.model.emberpath_alias : undefined;
  if (alias === undefined) return undefined;
  const config = steps.find(step => step.name === 'config-save');
  if (!config || config.status === 'succeeded' || config.status === 'skipped' || config.receipt?.['modelKeyConfigured'] === true) return undefined;
  return alias;
}

/**
 * Rerun a failed (or interrupted) operation from its first unfinished step. When its Emberpath client key has not
 * reached the profile and this process no longer holds it, the body must carry it again (409 EMBERPATH_KEY_REQUIRED).
 */
export async function resumeArdentAgentOperation(id: string, actor: ArdentOperationActor, body?: unknown): Promise<string> {
  const parsedBody = ardentAgentOperationResumeRequestSchema.safeParse(body ?? {});
  if (!parsedBody.success) throw new HttpError(400, 'VALIDATION_ERROR', parsedBody.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 500));
  const key = parsedBody.data.emberpath_client_key;
  const db = getDb();
  const row = await db.ardentAgentOperation.findUnique({ where: { id } });
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Ardent agent operation not found');
  const interrupted = row.status === 'running' && !active.has(id) && Date.now() - row.updatedAt.getTime() > STALE_MS;
  if (row.status !== 'failed' && !interrupted) throw new HttpError(409, 'OPERATION_NOT_RESUMABLE', `The operation is ${row.status}; only a failed operation can be resumed`);
  const alias = aliasAwaitingKey(JSON.parse(row.requestJson) as StoredRequest, JSON.parse(row.stepsJson) as Step[]);
  if (alias === undefined && key !== undefined)
    throw new HttpError(400, 'VALIDATION_ERROR', 'This operation needs no Emberpath client key: it has none to deliver, or delivered it already');
  if (alias !== undefined && key === undefined && heldEmberpathClientKey(id) === undefined)
    throw new HttpError(409, 'EMBERPATH_KEY_REQUIRED', `${EMBERPATH_KEY_MISSING}. This server does not keep the key the operation started with; resume with it again`);
  if (alias !== undefined && key !== undefined) {
    if (!deps.emberpathExplicit()) throw new HttpError(409, 'EMBERPATH_NOT_EXPLICIT', EMBERPATH_KEY_NOT_EXPLICIT);
    await deps.emberpathKey(emberpathUrl(), key, alias);
  }
  // Every step is a managed Ardent action, so a held command owner would stop it again at once.
  const [owner] = await deps.owners(row.nodeId);
  if (owner) throw new HttpError(409, 'COMMAND_OWNER_UNSETTLED', owner.state === 'unknown'
    ? `The node could not confirm the outcome of ${describeOwner(owner)}, so no Ardent action can run there. An ADMIN must check what it did and reconcile it on the Ardent installations page, then resume this operation.`
    : `${describeOwner(owner)} is still running on the node; resume this operation when it finishes.`);
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
  if (key !== undefined) holdEmberpathClientKey(id, key);
  await logAuditEvent({ action: 'ardent.agent.resume', actorId: actor.actorId, targetType: 'ardent-profile', targetId: `${row.nodeId}:${row.profile}`,
    details: { operationId: id, attempt: row.attempts + 1, ...(key !== undefined ? { emberpathClientKey: 'supplied' } : {}), ...actor.details } });
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
      // A command owner left unknown (by this step or an earlier action) is named, with what to do about it.
      step.error = message(await deps.explain(row.nodeId, error).catch(() => undefined) ?? error);
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
  releaseEmberpathClientKey(id);
  await logAuditEvent({ action: 'ardent.agent.complete', actorId: row.createdBy, targetType: 'ardent-profile', targetId: `${row.nodeId}:${row.profile}`,
    details: { operationId: id, kind: row.kind } });
}

const isDeploy = (request: StoredRequest): request is DeployRequest => 'apiPort' in request;
const definitionOf = (request: StoredRequest): ArdentStoredDefinition | undefined => (isDeploy(request) ? request.definition : undefined);

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

/**
 * For a definition install, the agent must now carry exactly the definition's persona and skills: the persona
 * digest over what Ardent serves and the skill receipts the node agent reads. A mismatch fails the probe.
 */
async function definitionMatches(context: Context): Promise<Record<string, unknown>> {
  const definition = definitionOf(context.request);
  if (!definition) return {};
  const [soul, identity] = await Promise.all((['soul', 'identity'] as const).map(kind =>
    deps.read<{ text: string }>(context.row.nodeId, context.row.profile, `identity/${kind}`)));
  const personaSha256 = await agentPersonaSha256({ soul_md: soul!.text, identity_md: identity!.text });
  if (personaSha256 !== definition.personaSha256) throw new DefinitionMismatch('The persona on the agent differs from the definition');
  const receipts = (await deps.skillReceipts(context.row.nodeId, context.row.profile)).skills;
  const absent = definition.skills.filter(skill => !receipts.some(item => item.name === skill.slug && item.version === skill.version && item.sha256 === skill.sha256));
  if (absent.length) throw new DefinitionMismatch(`Skills differ from the definition: ${absent.map(skill => `${skill.slug}@${skill.version}`).join(', ')}`);
  return { definition: { sha256: definition.sha256, personaSha256, skills: definition.skills.map(skill => `${skill.slug}@${skill.version}`) } };
}
class DefinitionMismatch extends Error {}

/**
 * Write ARDENT_INSTANCE_REF=<node id>.<profile> into the new profile's environment, so its execution references
 * name this Magnus node. Before the first service start; an agent below studio level 4 cannot, which the receipt notes.
 */
async function instanceRefStep(context: Context): Promise<Record<string, unknown>> {
  const value = ardentInstanceRef(context.row.nodeId, context.row.profile);
  if (!value) return { instanceRef: null, instanceRefNote: `The node ID and profile name are longer than ${ARDENT_INSTANCE_REF_ENV} allows; the profile keeps local.<profile>` };
  try { await deps.studio(context.row.nodeId, ARDENT_STUDIO_CAPABILITY.runtimeContracts); }
  catch (error: unknown) {
    if (error instanceof HttpError && error.code === 'AGENT_UPGRADE_REQUIRED')
      return { instanceRef: null, instanceRefNote: `The node agent cannot set ${ARDENT_INSTANCE_REF_ENV}; an Ardent upgrade after an agent upgrade sets it` };
    throw error;
  }
  await deps.action(context.row.nodeId, context.row.profile, 'instance-ref-set', undefined, { instance_ref: value });
  return { instanceRef: value };
}

/**
 * Write the held Emberpath client key to the profile's .env (model-credential-set), once: the receipt records that it
 * did and whether the file changed, never the key, and the key leaves this process's memory as soon as it is delivered.
 */
async function deliverModelKey(context: Context): Promise<void> {
  if (context.step.receipt?.['modelKeyConfigured'] === true) return;
  const key = heldEmberpathClientKey(context.row.id);
  if (key === undefined) throw new Error(`${EMBERPATH_KEY_MISSING}. This server no longer holds the key; resume the operation with emberpath_client_key`);
  const result = await deps.action(context.row.nodeId, context.row.profile, 'model-credential-set', undefined, { api_key: key }) as { changed?: unknown } | undefined;
  context.step.receipt = { ...context.step.receipt, modelKeyEnv: ARDENT_MODEL_API_KEY_ENV, modelKeyConfigured: true,
    ...(typeof result?.changed === 'boolean' ? { modelKeyChanged: result.changed } : {}) };
  await context.save();
  releaseEmberpathClientKey(context.row.id);
}

/** Set Emberpath key's config-save: deliver the key, then point providers.llamacpp.api_key_env at it. Nothing else changes. */
async function modelCredentialConfig(context: Context): Promise<Result> {
  await deliverModelKey(context);
  const config = await deps.read<{ revision: string; text: string }>(context.row.nodeId, context.row.profile, 'config');
  const document = YAML.parseDocument(config.text, { uniqueKeys: true });
  const previous = document.getIn(['providers', 'llamacpp', 'api_key_env']);
  document.setIn(['providers', 'llamacpp', 'api_key_env'], ARDENT_MODEL_API_KEY_ENV);
  const text = String(document);
  const named = { previousKeyEnv: typeof previous === 'string' ? previous : null };
  if (text === config.text) return { skipped: true, receipt: { revision: config.revision, unchanged: true, ...named } };
  const saved = await deps.action(context.row.nodeId, context.row.profile, 'config-save', undefined, { text, revision: config.revision }) as { revision?: unknown };
  return { receipt: { revision: typeof saved?.revision === 'string' ? saved.revision : null, activationRequired: true, ...named } };
}

const STEPS: Record<StepName, (context: Context) => Promise<Result>> = {
  'profile-check': async context => {
    const { installation, profile } = await profileOf(context);
    if (!profile) throw new Error('Ardent profile not found on the node');
    if (!profile.running) throw new Error(isModelCredential(context.request) ? 'Start the Ardent profile before setting its Emberpath key' : 'Start the Ardent profile before enabling HiveMem');
    return { receipt: { apiPort: profile.apiPort, version: installation.version } };
  },

  'profile-create': async context => {
    const request = context.request;
    if (!isDeploy(request)) throw new Error('profile-create belongs to New Agent');
    const { installation, profile } = await profileOf(context);
    if (profile) {
      // A retried creation whose earlier attempt reached the node: adopt exactly that profile.
      if (context.row.attempts > 1 && profile.apiPort === request.apiPort)
        return { skipped: true, receipt: { apiPort: profile.apiPort, adopted: true, ...await instanceRefStep(context) } };
      throw new Error('An Ardent profile with this ID already exists on the node');
    }
    await deps.action(context.row.nodeId, context.row.profile, 'profile-create', undefined, { api_port: request.apiPort });
    return { receipt: { apiPort: request.apiPort, version: installation.version, ...await instanceRefStep(context) } };
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
    const plan = (action: ArdentHiveMemAction) => planArdentHiveMemCredential(settings, { operationId: `${context.row.id}:${context.row.attempts}`,
      nodeId: context.row.nodeId, nodeName: name, profile: context.row.profile, action });
    // The plan is stored before the request, so a retry repeats it and HiveMem replays the same credential.
    let current = (context.step.receipt?.['plan'] as ArdentHiveMemPlan | undefined) ?? plan('enroll');
    const remember = async () => { context.step.receipt = { ...context.step.receipt, plan: current }; await context.save(); };
    await remember();
    let issued: Awaited<ReturnType<ArdentDeployDeps['credential']>> | undefined;
    let fallbacks: ArdentHiveMemAction[] | undefined;
    while (!issued) {
      try {
        issued = await deps.credential(settings, current);
      } catch (error: unknown) {
        if (!(error instanceof HiveMemEnrollmentError)) throw error;
        // 409: the agent ID already exists (an earlier profile of this name). 410: an earlier
        // attempt's receipt expired before its token reached the node. Both issue a replacement,
        // which also invalidates any credential that never arrived: a renewal with a fresh
        // deadline where HiveMem supports it (a rotation keeps the first one), else a rotation.
        // A renewal HiveMem refuses (403/404, say an agent outside the workspace) falls back to rotation.
        // A plan stored by an earlier attempt of this operation is replaced the same way.
        const stale = !current.key.startsWith(`${context.row.id}:${context.row.attempts}:`);
        const recoverable = (current.action === 'enroll' || stale) && [409, 410].includes(error.status)
          || current.action === 'renew' && [403, 404, 410].includes(error.status);
        if (!recoverable) throw error;
        fallbacks ??= (await deps.supportsRenewal(settings).catch(() => false)) ? ['renew', 'rotate'] : ['rotate'];
        const next = fallbacks.shift();
        if (!next) throw error;
        current = plan(next);
        await remember();
      }
    }
    await deps.action(context.row.nodeId, context.row.profile, 'hivemem-credential-set', undefined, { token: issued.token });
    await deps.record({ nodeId: context.row.nodeId, profile: context.row.profile, agentId: issued.agentId, workspaceId: current.workspaceId,
      expiresAt: issued.expiresAt });
    return { receipt: { plan: current, agentId: issued.agentId, workspaceId: settings.workspaceId, expiresAt: issued.expiresAt,
      action: current.action, tokenEnv: ARDENT_HIVEMEM_TOKEN_ENV } };
  },

  'config-save': async context => {
    const request = context.request;
    if (isModelCredential(request)) return modelCredentialConfig(context);
    const settings = deps.hivemem();
    const agentId = context.steps.find(step => step.name === 'hivemem-enroll')?.receipt?.['agentId'] as string | undefined;
    const config = await deps.read<{ revision: string; text: string }>(context.row.nodeId, context.row.profile, 'config');
    const document = YAML.parseDocument(config.text, { uniqueKeys: true });
    const notes: string[] = [];
    if (isDeploy(request)) {
      document.setIn(['execution', 'backend'], 'llamacpp');
      const model = 'emberpath_alias' in request.model ? { base_url: emberpathUrl(), model: request.model.emberpath_alias } : request.model;
      document.setIn(['providers', 'llamacpp', 'base_url'], model.base_url);
      document.setIn(['providers', 'llamacpp', 'model'], model.model);
      if ('emberpath_alias' in request.model) {
        await deliverModelKey(context);
        document.setIn(['providers', 'llamacpp', 'api_key_env'], ARDENT_MODEL_API_KEY_ENV);
      }
      // Ardent 2.2.0 added artifacts.max_bytes (default 2 MiB). A new agent gets the node agent's relay cap unless told otherwise.
      const { installation } = await profileOf(context);
      if (newerOrEqual(installation.version, [2, 2, 0])) document.setIn(['artifacts', 'max_bytes'], request.artifacts_max_bytes ?? ARDENT_NEW_AGENT_ARTIFACT_MAX_BYTES);
      else if (request.artifacts_max_bytes !== undefined) notes.push(`artifacts.max_bytes needs Ardent 2.2.0 or later; this node runs ${installation.version ?? 'an unknown version'}`);
      // Ardent before 3.4.0 always named Magnus as its Agent Card provider; 3.4.0 names Ardent unless a2a.provider says
      // otherwise. A new agent Magnus deploys keeps naming Magnus; a provider the template already sets stays.
      if (newerOrEqual(installation.version, [3, 4, 0]) && !document.hasIn(['a2a', 'provider']))
        document.setIn(['a2a', 'provider'], document.createNode(ARDENT_MAGNUS_AGENT_CARD_PROVIDER));
      const definition = request.definition;
      if (definition) {
        for (const [key, value] of Object.entries(definition.execution)) if (value !== undefined) document.setIn(['execution', key], value);
        // Only plugins of extensions the extensions-install step found reviewed on this node.
        if (definition.plugins.length) document.setIn(['plugins'], document.createNode(definition.plugins));
      }
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

  'extensions-install': async context => {
    const definition = definitionOf(context.request);
    if (!definition?.extensions.length) return { skipped: true, receipt: { extensions: [] } };
    // Extensions are installed once per node, reviewed, beside the runtime; a definition names them by digest.
    const { installation } = await profileOf(context);
    const retained = installation.extensions;
    if (!Array.isArray(retained)) throw new Error(installation.extensionsError ?? 'The node agent does not report its reviewed extensions; upgrade it');
    const missing = definition.extensions.filter(item => !retained.some(have => have.name === item.name && have.version === item.version
      && have.integrity === item.integrity && have.packageTreeSha256 === item.package_tree_sha256));
    if (missing.length) throw new Error(`Not reviewed on this node: ${missing.map(item => `${item.name}@${item.version}`).join(', ')}`);
    return { receipt: { extensions: definition.extensions.map(item => ({ name: item.name, version: item.version, integrity: item.integrity })), plugins: definition.plugins } };
  },

  'skill-install': async context => {
    const definition = definitionOf(context.request);
    if (!definition?.skills.length) return { skipped: true, receipt: { installed: [] } };
    const installed: Array<{ name: string; version: string; sha256: string; changed: boolean }> = [];
    for (const skill of definition.skills) {
      const config = await deps.read<{ revision: string; text: string }>(context.row.nodeId, context.row.profile, 'config');
      const request: ArdentSkillInstall = { source: 'hiveskills', name: skill.slug, version: skill.version, pinned: true, enable: true, revision: config.revision };
      const release = await deps.skillRelease(request, skill.sha256);
      const { pinned: _pinned, ...forNode } = request;
      const result = await deps.action(context.row.nodeId, context.row.profile, 'skill-install', undefined,
        { ...forNode, sha256: release.sha256, archive_base64: release.archiveBase64 }) as ArdentSkillInstallResult;
      if (!result?.enabled) throw new Error(`${skill.slug} ${skill.version} was installed but not enabled: ${result?.enable_error ?? 'no reason given'}`);
      installed.push({ name: skill.slug, version: skill.version, sha256: release.sha256, changed: result.changed });
    }
    return { receipt: { installed } };
  },

  'service-restart': async context => {
    if (isModelCredential(context.request)) {
      // Nothing to activate when the profile already had this key under the name its configuration uses.
      const config = context.steps.find(step => step.name === 'config-save')?.receipt;
      if (config?.['modelKeyChanged'] === false && config['unchanged'] === true) return { skipped: true, receipt: { running: true, unchanged: true } };
    }
    const result = await deps.action(context.row.nodeId, context.row.profile, 'service-restart') as { running?: unknown };
    return { receipt: { running: result?.running === true } };
  },

  'ready-probe': async context => {
    let last = 'no answer';
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        const status = await deps.read<{ version?: unknown; backend?: unknown }>(context.row.nodeId, context.row.profile, 'status');
        // Set Emberpath key touches only the model; the agent may have no HiveMem at all.
        if (isModelCredential(context.request)) return { receipt: { attempts: attempt, version: status?.version ?? null, backend: status?.backend ?? null } };
        const memory = await deps.read<{ status?: unknown; agent_id?: unknown; reason?: unknown }>(context.row.nodeId, context.row.profile, 'memory/status');
        if (memory?.status === 'ready') return { receipt: { attempts: attempt, version: status?.version ?? null, backend: status?.backend ?? null,
          memory: 'ready', agentId: memory.agent_id ?? null, ...await definitionMatches(context) } };
        last = `HiveMem is ${String(memory?.status ?? 'unknown')}${typeof memory?.reason === 'string' ? `: ${memory.reason}` : ''}`;
      } catch (error: unknown) {
        if (error instanceof DefinitionMismatch) throw error;
        last = message(error);
      }
      if (attempt < 10) await deps.delay(3000);
    }
    throw new Error(`The agent did not become ready: ${last}`);
  },
};
