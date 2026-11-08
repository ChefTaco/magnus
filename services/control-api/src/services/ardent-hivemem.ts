/**
 * Per-agent HiveMem credentials for Ardent profiles. Magnus asks HiveMem's
 * durable actor-credential API for one scoped agent token per profile and hands
 * it straight to the node, which writes it into the profile's private `.env` as
 * ARDENT_HIVEMEM_TOKEN (a key the node agent's credential renewal also accepts).
 * The token is never stored or logged here.
 */
import { createHash } from 'node:crypto';
import { HttpError } from '../middleware/error-handler.js';

/** HiveMem permissions an Ardent profile uses: private memories and conversation sessions. */
export const ARDENT_HIVEMEM_SCOPES = ['memories:read', 'memories:write', 'sessions:read', 'sessions:write'] as const;
/** The profile environment variable that carries the agent's HiveMem token. */
export const ARDENT_HIVEMEM_TOKEN_ENV = 'ARDENT_HIVEMEM_TOKEN';
const MAX_HOURS = 720;

export interface ArdentHiveMemSettings {
  /** Base URL Magnus calls (before `v1/`). */
  apiUrl: string;
  /** Base URL written into the profile config; the agent's view of the same server. */
  agentUrl: string;
  token: string;
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

/** Configured enrollment, or null when Magnus has no HiveMem enrollment settings. Throws on a partial or invalid setup. */
export function ardentHiveMemSettings(env: NodeJS.ProcessEnv = process.env): ArdentHiveMemSettings | null {
  const url = env['MAGNUS_ARDENT_HIVEMEM_URL'];
  const token = env['MAGNUS_ARDENT_HIVEMEM_ENROLLMENT_TOKEN'];
  const workspaceId = env['MAGNUS_ARDENT_HIVEMEM_WORKSPACE_ID'];
  if (!url && !token && !workspaceId) return null;
  if (!url || !token || !workspaceId) throw new Error('MAGNUS_ARDENT_HIVEMEM_URL, MAGNUS_ARDENT_HIVEMEM_ENROLLMENT_TOKEN and MAGNUS_ARDENT_HIVEMEM_WORKSPACE_ID are set together');
  if (!/^[a-z0-9_-]{1,100}$/.test(workspaceId)) throw new Error('MAGNUS_ARDENT_HIVEMEM_WORKSPACE_ID must match [a-z0-9_-]{1,100}');
  const rawHours = env['MAGNUS_ARDENT_HIVEMEM_CREDENTIAL_HOURS'];
  const hours = rawHours === undefined || rawHours === '' ? MAX_HOURS : Number(rawHours);
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > MAX_HOURS) throw new Error('MAGNUS_ARDENT_HIVEMEM_CREDENTIAL_HOURS must be an integer from 1 to 720');
  const apiUrl = baseUrl(url, 'MAGNUS_ARDENT_HIVEMEM_URL', true);
  const agentUrl = env['MAGNUS_ARDENT_HIVEMEM_AGENT_URL'] ? baseUrl(env['MAGNUS_ARDENT_HIVEMEM_AGENT_URL'], 'MAGNUS_ARDENT_HIVEMEM_AGENT_URL', false) : apiUrl;
  return { apiUrl, agentUrl, token, workspaceId, hours };
}

/** Settings for a step that needs them; a missing setup is a clear 503 rather than a silent skip. */
export function requireArdentHiveMemSettings(): ArdentHiveMemSettings {
  let settings: ArdentHiveMemSettings | null;
  try { settings = ardentHiveMemSettings(); }
  catch (error: unknown) { throw new HttpError(503, 'HIVEMEM_ENROLLMENT_UNAVAILABLE', error instanceof Error ? error.message : 'HiveMem enrollment is misconfigured'); }
  if (!settings) throw new HttpError(503, 'HIVEMEM_ENROLLMENT_UNAVAILABLE', 'HiveMem enrollment is not configured: set MAGNUS_ARDENT_HIVEMEM_URL, MAGNUS_ARDENT_HIVEMEM_ENROLLMENT_TOKEN and MAGNUS_ARDENT_HIVEMEM_WORKSPACE_ID');
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

export class HiveMemEnrollmentError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'HiveMemEnrollmentError'; }
}

/**
 * Run one durable HiveMem credential operation. The operation ID is a digest of
 * the plan key, so repeating the same plan within HiveMem's fifteen-minute
 * receipt window returns the same token instead of minting another.
 */
export async function requestArdentHiveMemCredential(settings: ArdentHiveMemSettings, plan: ArdentHiveMemPlan,
  fetcher: typeof fetch = fetch): Promise<{ token: string; agentId: string; expiresAt: string | null; operationId: string }> {
  const operationId = createHash('sha256').update(`magnus-ardent:${plan.key}`).digest('hex');
  const response = await fetcher(new URL(`v1/actor-credentials/${operationId}`, settings.apiUrl), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${settings.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ action: plan.action, agent_id: plan.agentId, display_name: plan.displayName,
      description: 'Ardent profile managed by Magnus', scopes: [...ARDENT_HIVEMEM_SCOPES], workspace_id: plan.workspaceId, expires_at: plan.expiresAt }),
  });
  if (!response.ok) {
    const detail = await response.text().then(text => text.slice(0, 300)).catch(() => '');
    throw new HiveMemEnrollmentError(response.status, `HiveMem ${plan.action} answered HTTP ${response.status}${detail ? `: ${detail.replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[token]')}` : ''}`);
  }
  const body = await response.json() as { ok?: unknown; token?: unknown; agent_id?: unknown; expires_at?: unknown };
  if (body.ok !== true || typeof body.token !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(body.token) || body.agent_id !== plan.agentId)
    throw new HiveMemEnrollmentError(502, 'HiveMem returned no usable agent credential');
  return { token: body.token, agentId: plan.agentId, expiresAt: typeof body.expires_at === 'string' ? body.expires_at : null, operationId };
}
