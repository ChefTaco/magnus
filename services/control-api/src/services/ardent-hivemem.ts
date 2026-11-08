/**
 * Per-agent HiveMem credentials for Ardent profiles. Magnus asks HiveMem's
 * durable actor-credential API for one scoped agent token per profile and hands
 * it straight to the node, which writes it into the profile's private `.env` as
 * ARDENT_HIVEMEM_TOKEN (a key the node agent's credential renewal also accepts).
 * The token is never stored or logged here.
 *
 * Magnus authenticates to HiveMem as its own Oathweave service identity
 * (client_credentials, audience hivemem), which HiveMem links to a local
 * principal allowed to enroll agents, or, outside a suite, with a static HiveMem
 * token. With the service identity Magnus also creates the agents' workspace.
 */
import { createHash } from 'node:crypto';
import { HttpError } from '../middleware/error-handler.js';
import { OathweaveClientToken, OathweaveClientTokenError } from './oathweave-client-credentials.js';

/** HiveMem permissions an Ardent profile uses: private memories and conversation sessions. */
export const ARDENT_HIVEMEM_SCOPES = ['memories:read', 'memories:write', 'sessions:read', 'sessions:write'] as const;
/** The profile environment variable that carries the agent's HiveMem token. */
export const ARDENT_HIVEMEM_TOKEN_ENV = 'ARDENT_HIVEMEM_TOKEN';
/** What Magnus's service identity requests: enroll agents, create their workspace, and every scope it grants them. */
export const ARDENT_HIVEMEM_SERVICE_SCOPE = ['admin:agents', 'workspaces:write', ...ARDENT_HIVEMEM_SCOPES].map(scope => `hivemem:${scope}`).join(' ');
/** The workspace a service identity enrolls agents into when none is configured. */
export const ARDENT_HIVEMEM_DEFAULT_WORKSPACE = 'ardent-agents';
const MAX_HOURS = 720;

/** How Magnus authenticates to HiveMem. */
export type ArdentHiveMemAuth =
  | { kind: 'token'; token: string }
  | { kind: 'oathweave'; tokenUrl: string; clientId: string; clientSecret: string; scope: string };

export interface ArdentHiveMemSettings {
  /** Base URL Magnus calls (before `v1/`). */
  apiUrl: string;
  /** Base URL written into the profile config; the agent's view of the same server. */
  agentUrl: string;
  auth: ArdentHiveMemAuth;
  workspaceId: string;
  hours: number;
}

function baseUrl(value: string, name: string, httpsOnly: boolean): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name} must be a URL`); }
  if ((httpsOnly ? url.protocol !== 'https:' : !['http:', 'https:'].includes(url.protocol)) || url.username || url.password || url.search || url.hash)
    throw new Error(`${name} must be an ${httpsOnly ? 'HTTPS' : 'HTTP(S)'} URL without credentials, query or fragment`);
  return url.toString().endsWith('/') ? url.toString() : `${url.toString()}/`;
}

const CLIENT_KEYS = ['MAGNUS_ARDENT_HIVEMEM_CLIENT_ID', 'MAGNUS_ARDENT_HIVEMEM_CLIENT_SECRET', 'MAGNUS_ARDENT_HIVEMEM_TOKEN_URL'] as const;

function oathweaveAuth(env: NodeJS.ProcessEnv): ArdentHiveMemAuth {
  const [clientId, clientSecret, tokenUrl] = CLIENT_KEYS.map(key => env[key]);
  if (!clientId || !clientSecret || !tokenUrl) throw new Error(`${CLIENT_KEYS.join(', ')} are set together`);
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(clientId)) throw new Error('MAGNUS_ARDENT_HIVEMEM_CLIENT_ID must match [a-zA-Z0-9_-]{1,100}');
  const scope = (env['MAGNUS_ARDENT_HIVEMEM_SCOPE'] || ARDENT_HIVEMEM_SERVICE_SCOPE).trim().split(/\s+/);
  if (scope.some(entry => !/^hivemem:[a-z0-9*-]+(?::[a-z0-9*-]+)*$/.test(entry))) throw new Error('MAGNUS_ARDENT_HIVEMEM_SCOPE must list hivemem: permissions separated by spaces');
  const missing = scope.includes('hivemem:admin:all') ? [] : ARDENT_HIVEMEM_SERVICE_SCOPE.split(' ').filter(entry => !scope.includes(entry));
  if (missing.length) throw new Error(`MAGNUS_ARDENT_HIVEMEM_SCOPE lacks ${missing.join(', ')}`);
  return { kind: 'oathweave', tokenUrl: baseUrl(tokenUrl, 'MAGNUS_ARDENT_HIVEMEM_TOKEN_URL', true).replace(/\/$/, ''), clientId, clientSecret, scope: scope.join(' ') };
}

/** Configured enrollment, or null when Magnus has no HiveMem enrollment settings. Throws on a partial or invalid setup. */
export function ardentHiveMemSettings(env: NodeJS.ProcessEnv = process.env): ArdentHiveMemSettings | null {
  const url = env['MAGNUS_ARDENT_HIVEMEM_URL'];
  const token = env['MAGNUS_ARDENT_HIVEMEM_ENROLLMENT_TOKEN'];
  const client = CLIENT_KEYS.some(key => env[key]);
  let workspaceId = env['MAGNUS_ARDENT_HIVEMEM_WORKSPACE_ID'];
  if (!url && !token && !client && !workspaceId) return null;
  if (token && client) throw new Error('Set either MAGNUS_ARDENT_HIVEMEM_ENROLLMENT_TOKEN or the Oathweave client (MAGNUS_ARDENT_HIVEMEM_CLIENT_ID), not both');
  if (!url || (!token && !client)) throw new Error('MAGNUS_ARDENT_HIVEMEM_URL is set together with an Oathweave client (MAGNUS_ARDENT_HIVEMEM_CLIENT_ID, _CLIENT_SECRET, _TOKEN_URL) or MAGNUS_ARDENT_HIVEMEM_ENROLLMENT_TOKEN');
  const auth: ArdentHiveMemAuth = client ? oathweaveAuth(env) : { kind: 'token', token: token! };
  // A static token cannot be assumed to create workspaces, so it names an existing one.
  if (!workspaceId && auth.kind === 'token') throw new Error('MAGNUS_ARDENT_HIVEMEM_ENROLLMENT_TOKEN needs MAGNUS_ARDENT_HIVEMEM_WORKSPACE_ID, an existing workspace');
  workspaceId ||= ARDENT_HIVEMEM_DEFAULT_WORKSPACE;
  if (!/^[a-z0-9_-]{1,100}$/.test(workspaceId)) throw new Error('MAGNUS_ARDENT_HIVEMEM_WORKSPACE_ID must match [a-z0-9_-]{1,100}');
  const rawHours = env['MAGNUS_ARDENT_HIVEMEM_CREDENTIAL_HOURS'];
  const hours = rawHours === undefined || rawHours === '' ? MAX_HOURS : Number(rawHours);
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > MAX_HOURS) throw new Error('MAGNUS_ARDENT_HIVEMEM_CREDENTIAL_HOURS must be an integer from 1 to 720');
  const apiUrl = baseUrl(url, 'MAGNUS_ARDENT_HIVEMEM_URL', true);
  const agentUrl = env['MAGNUS_ARDENT_HIVEMEM_AGENT_URL'] ? baseUrl(env['MAGNUS_ARDENT_HIVEMEM_AGENT_URL'], 'MAGNUS_ARDENT_HIVEMEM_AGENT_URL', false) : apiUrl;
  return { apiUrl, agentUrl, auth, workspaceId, hours };
}

/** Settings for a step that needs them; a missing setup is a clear 503 rather than a silent skip. */
export function requireArdentHiveMemSettings(): ArdentHiveMemSettings {
  let settings: ArdentHiveMemSettings | null;
  try { settings = ardentHiveMemSettings(); }
  catch (error: unknown) { throw new HttpError(503, 'HIVEMEM_ENROLLMENT_UNAVAILABLE', error instanceof Error ? error.message : 'HiveMem enrollment is misconfigured'); }
  if (!settings) throw new HttpError(503, 'HIVEMEM_ENROLLMENT_UNAVAILABLE', 'HiveMem enrollment is not configured: set MAGNUS_ARDENT_HIVEMEM_URL with an Oathweave client (MAGNUS_ARDENT_HIVEMEM_CLIENT_ID, _CLIENT_SECRET, _TOKEN_URL) or MAGNUS_ARDENT_HIVEMEM_ENROLLMENT_TOKEN and MAGNUS_ARDENT_HIVEMEM_WORKSPACE_ID');
  return settings;
}

/** A stable HiveMem agent ID for a node profile: readable, unique, and within HiveMem's 2-32 `[a-z0-9_-]`. */
export function ardentHiveMemAgentId(nodeId: string, profile: string): string {
  const slug = profile.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 16) || 'agent';
  const digest = createHash('sha256').update(JSON.stringify([nodeId, profile])).digest('hex').slice(0, 8);
  return `ardent-${slug}-${digest}`;
}

/** The exact request a step sends. It is stored with the step so a retry repeats it byte for byte. */
export interface ArdentHiveMemPlan {
  key: string;
  action: 'enroll' | 'rotate';
  agentId: string;
  displayName: string;
  workspaceId: string;
  expiresAt: string;
}

export function planArdentHiveMemCredential(settings: ArdentHiveMemSettings, input: {
  operationId: string; nodeId: string; nodeName: string; profile: string; action: 'enroll' | 'rotate'; now?: number;
}): ArdentHiveMemPlan {
  const now = input.now ?? Date.now();
  return {
    key: `${input.operationId}:${input.action}`,
    action: input.action,
    agentId: ardentHiveMemAgentId(input.nodeId, input.profile),
    displayName: `Ardent ${input.profile} on ${input.nodeName}`.slice(0, 128),
    workspaceId: settings.workspaceId,
    // A minute short of the limit, so the deadline is still valid when HiveMem checks it.
    expiresAt: new Date(now + settings.hours * 3_600_000 - 60_000).toISOString(),
  };
}

/** Why HiveMem enrollment stopped. The code leads the message, so a failed step names it too. */
export type HiveMemEnrollmentCode = 'HIVEMEM_IDENTITY_UNAVAILABLE' | 'HIVEMEM_WORKSPACE_UNAVAILABLE' | 'HIVEMEM_ENROLLMENT_FAILED';

export class HiveMemEnrollmentError extends Error {
  constructor(readonly status: number, readonly detail: string, readonly code: HiveMemEnrollmentCode = 'HIVEMEM_ENROLLMENT_FAILED') {
    super(`${code}: ${detail}`);
    this.name = 'HiveMemEnrollmentError';
  }
}

const JWT = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
async function refusal(response: Response): Promise<string> {
  const detail = await response.text().then(text => text.slice(0, 300)).catch(() => '');
  return `HTTP ${response.status}${detail ? `: ${detail.replace(JWT, '[token]')}` : ''}`;
}

/** One cached token per service client; replaced when its settings change. */
const clientTokens = new Map<string, OathweaveClientToken>();
function clientToken(auth: Extract<ArdentHiveMemAuth, { kind: 'oathweave' }>): OathweaveClientToken {
  const key = createHash('sha256').update(JSON.stringify([auth.tokenUrl, auth.clientId, auth.clientSecret, auth.scope])).digest('hex');
  let provider = clientTokens.get(key);
  if (!provider) { clientTokens.clear(); provider = new OathweaveClientToken(auth); clientTokens.set(key, provider); }
  return provider;
}

/** Forget cached service tokens (tests, or after a configuration change). */
export function resetArdentHiveMemTokens(): void { clientTokens.clear(); }

async function bearer(settings: ArdentHiveMemSettings, fetcher: typeof fetch): Promise<string> {
  if (settings.auth.kind === 'token') return settings.auth.token;
  try { return await clientToken(settings.auth).token(fetcher); }
  catch (error: unknown) {
    const reason = error instanceof OathweaveClientTokenError ? error.message : 'Oathweave token request failed';
    throw new HiveMemEnrollmentError(503, `${reason}; check MAGNUS_ARDENT_HIVEMEM_CLIENT_ID, its secret and its Oathweave policy (audience hivemem)`, 'HIVEMEM_IDENTITY_UNAVAILABLE');
  }
}

/** Call HiveMem as Magnus. A service token HiveMem rejects as expired or revoked is replaced once. */
async function callHiveMem(settings: ArdentHiveMemSettings, path: string, body: unknown, fetcher: typeof fetch): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetcher(new URL(path, settings.apiUrl), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${await bearer(settings, fetcher)}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.status !== 401 || settings.auth.kind !== 'oathweave' || attempt > 0) return response;
    await response.body?.cancel().catch(() => undefined);
    clientToken(settings.auth).invalidate();
  }
}

/**
 * Make sure the agents' workspace exists. Only a service identity does this:
 * HiveMem returns the workspace when it exists and creates it, owned by Magnus's
 * principal, when it does not. A static token names an existing workspace.
 */
export async function ensureArdentHiveMemWorkspace(settings: ArdentHiveMemSettings, fetcher: typeof fetch = fetch): Promise<void> {
  if (settings.auth.kind !== 'oathweave') return;
  const response = await callHiveMem(settings, 'v1/workspaces', { workspace_id: settings.workspaceId, title: 'Ardent agents',
    description: 'Private memory of the Ardent agents Magnus manages' }, fetcher);
  if (!response.ok) throw new HiveMemEnrollmentError(response.status === 403 ? 403 : 503,
    `HiveMem refused workspace ${settings.workspaceId} (${await refusal(response)}). Magnus's HiveMem service link needs workspaces:write, and an existing workspace must be one Magnus administers`,
    'HIVEMEM_WORKSPACE_UNAVAILABLE');
  const body = await response.json().catch(() => null) as { workspace_id?: unknown } | null;
  if (body?.workspace_id !== settings.workspaceId) throw new HiveMemEnrollmentError(502, 'HiveMem returned another workspace', 'HIVEMEM_WORKSPACE_UNAVAILABLE');
}

/**
 * Check, before an operation starts, that Magnus can reach HiveMem as itself and
 * that the workspace exists, so a New Agent does not stop halfway on setup.
 */
export async function prepareArdentHiveMem(settings: ArdentHiveMemSettings, fetcher: typeof fetch = fetch): Promise<void> {
  try { await ensureArdentHiveMemWorkspace(settings, fetcher); }
  catch (error: unknown) {
    if (error instanceof HiveMemEnrollmentError) throw new HttpError(503, error.code, error.detail);
    throw new HttpError(503, 'HIVEMEM_ENROLLMENT_UNAVAILABLE', `HiveMem is unreachable (${error instanceof Error ? error.name : 'error'})`);
  }
}

/**
 * Run one durable HiveMem credential operation. The operation ID is a digest of
 * the plan key, so repeating the same plan within HiveMem's fifteen-minute
 * receipt window returns the same token instead of minting another.
 */
export async function requestArdentHiveMemCredential(settings: ArdentHiveMemSettings, plan: ArdentHiveMemPlan,
  fetcher: typeof fetch = fetch): Promise<{ token: string; agentId: string; expiresAt: string | null; operationId: string }> {
  const operationId = createHash('sha256').update(`magnus-ardent:${plan.key}`).digest('hex');
  await ensureArdentHiveMemWorkspace(settings, fetcher);
  const response = await callHiveMem(settings, `v1/actor-credentials/${operationId}`, { action: plan.action, agent_id: plan.agentId,
    display_name: plan.displayName, description: 'Ardent profile managed by Magnus', scopes: [...ARDENT_HIVEMEM_SCOPES],
    workspace_id: plan.workspaceId, expires_at: plan.expiresAt }, fetcher);
  if (!response.ok) throw new HiveMemEnrollmentError(response.status, `HiveMem ${plan.action} answered ${await refusal(response)}`);
  const body = await response.json() as { ok?: unknown; token?: unknown; agent_id?: unknown; expires_at?: unknown };
  if (body.ok !== true || typeof body.token !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(body.token) || body.agent_id !== plan.agentId)
    throw new HiveMemEnrollmentError(502, 'HiveMem returned no usable agent credential');
  return { token: body.token, agentId: plan.agentId, expiresAt: typeof body.expires_at === 'string' ? body.expires_at : null, operationId };
}
