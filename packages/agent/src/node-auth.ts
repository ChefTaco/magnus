/**
 * Authentication of this agent's requests to the Control API (see docs/NODE_CREDENTIALS.md in the
 * repository). Every sender goes through {@link nodeApiFetch} or {@link controlApiAuthHeaders}.
 *
 * Once the node has a bound key, each request is signed for the pinned server key. In enforce mode
 * (the default from 3.0.0) that is all it carries; under an explicit compat or warn the shared node
 * secret is sent as well, which a server older than node credentials still needs.
 */
import { CONTROL_API_URL, NODE_MANAGER_SECRET } from './env.js';
import { boundNodeIdentity } from './security/node-identity.js';
import { serverAudience, signNodeRequest } from './security/node-request-auth.js';
import { controlApiFetch } from './tls.js';

export type NodeAuthMode = 'compat' | 'warn' | 'enforce';

/**
 * `NODE_AUTH_MODE` on the agent (default `enforce` from 3.0.0):
 *
 *   enforce  once this node has a bound key and pins a server key, a request that carries only the
 *            shared secret is refused on every `/api/v1/*` route, decisions must carry a server
 *            signature, and the agent no longer sends the shared secret to the Control API; without a
 *            bound key the agent stays in compat and says so (it needs `magnus-agent enroll --token`)
 *   compat   deprecated: the agent's own API accepts a server signature or the shared node secret
 *            (`x-node-token`), and the agent sends the secret next to its signature
 *   warn     deprecated: the same, and each request accepted on the shared secret is logged (throttled)
 *
 * An explicit `compat` or `warn` keeps working in this major and is removed in the next.
 */
export function nodeAuthModeSetting(env: NodeJS.ProcessEnv = process.env): { mode: NodeAuthMode; explicit: boolean } {
  const value = (env['NODE_AUTH_MODE'] ?? '').trim().toLowerCase();
  if (value === 'compat' || value === 'warn' || value === 'enforce') return { mode: value, explicit: true };
  return { mode: 'enforce', explicit: false };
}

export function nodeAuthMode(env: NodeJS.ProcessEnv = process.env): NodeAuthMode {
  return nodeAuthModeSetting(env).mode;
}

/** The start-up warning of an explicit compat or warn, or null. */
export function nodeAuthDeprecationWarning(env: NodeJS.ProcessEnv = process.env): string | null {
  const setting = nodeAuthModeSetting(env);
  if (!setting.explicit || setting.mode === 'enforce') return null;
  return `NODE_AUTH_MODE=${setting.mode} is deprecated: this agent accepts and sends the shared node secret for this major only; `
    + 'remove the setting (enforce, the default) once the node has a bound key (`magnus-agent identity show`).';
}

/** Whether enforce mode is in effect: requested, and the node has a bound key that pins a server key. */
export function agentEnforcesNodeAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  return nodeAuthMode(env) === 'enforce' && (boundNodeIdentity()?.binding.serverKeys.length ?? 0) > 0;
}

/** The mode in effect, for status output: `enforce` falls back to `compat` until the node has a bound key. */
export function effectiveNodeAuthMode(env: NodeJS.ProcessEnv = process.env): NodeAuthMode {
  const mode = nodeAuthMode(env);
  return mode === 'enforce' && !agentEnforcesNodeAuth(env) ? 'compat' : mode;
}

/** The audience of a request this node signs for its own API (the acceptance probe). */
export const selfAudience = (nodeId: string): string => `self:${nodeId}`;

let clockOffsetMs = 0;
const listeners = new Set<(status: number) => void>();

/**
 * Learn the Control API's clock from `x-magnus-server-time`, which it sends on every node route,
 * refusals included. A host with a wrong clock would otherwise be refused for skew with no way back.
 * The value arrives over the verified TLS connection to the Control API.
 */
export function noteServerTime(value: string | null | undefined, now = Date.now()): void {
  if (!value || !/^[1-9][0-9]{12,13}$/.test(value)) return;
  const offset = Number(value) - now;
  // Small differences are network delay, not a wrong clock.
  clockOffsetMs = Math.abs(offset) > 5000 ? offset : 0;
}

/** This agent's best estimate of the Control API's clock, in milliseconds. */
export function nodeAuthNow(): number {
  return Date.now() + clockOffsetMs;
}

/** Called with the status of every Control API response, so the enrollment loop can react to refusals. */
export function onControlApiStatus(listener: (status: number) => void): void {
  listeners.add(listener);
}

/** The path the server sees: the request path without any prefix `CONTROL_API_URL` carries for a reverse proxy. */
export function controlApiPath(url: string | URL): string {
  const target = new URL(url);
  const prefix = new URL(CONTROL_API_URL).pathname.replace(/\/+$/, '');
  const path = prefix && target.pathname.startsWith(`${prefix}/`) ? target.pathname.slice(prefix.length) : target.pathname;
  return path + target.search;
}

/**
 * Authentication headers for one request to the Control API. `body` must be the exact text sent.
 * Never log the result: it carries the shared node secret.
 */
export function controlApiAuthHeaders(method: string, url: string | URL, body = ''): Record<string, string> {
  const identity = boundNodeIdentity();
  const serverKey = identity?.binding.serverKeys[0];
  // Enforce, with a bound key: the signature alone. Otherwise the shared secret travels as well (when
  // the agent has one), for a server that does not know this key or predates node credentials.
  const legacy: Record<string, string> = NODE_MANAGER_SECRET && !(identity && serverKey && nodeAuthMode() === 'enforce')
    ? { 'x-node-token': NODE_MANAGER_SECRET } : {};
  if (!identity || !serverKey) return legacy;
  return { ...legacy, ...signNodeRequest({ privateKey: identity.privateKey, keyId: identity.keyId, nodeId: identity.binding.nodeId,
    audience: serverAudience(serverKey.keyId), method, pathWithQuery: controlApiPath(url), body, now: nodeAuthNow() }) };
}

/** Record what a Control API response says about the clock and about this node's credentials. */
export function noteControlApiResponse(response: { status: number; headers: { get(name: string): string | null } }): void {
  noteServerTime(response.headers.get('x-magnus-server-time'));
  for (const listener of listeners) {
    try { listener(response.status); } catch { /* a listener must not break a request */ }
  }
}

/** `controlApiFetch` with node authentication. `init.body`, when present, must be a string. */
export async function nodeApiFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const body = init.body ?? '';
  if (typeof body !== 'string') throw new Error('A node request body must be a string');
  const headers = { ...(init.headers as Record<string, string> | undefined), ...controlApiAuthHeaders(init.method ?? 'GET', url, body) };
  const response = await controlApiFetch(typeof url === 'string' ? url : url.toString(), { ...init, headers });
  noteControlApiResponse(response);
  return response;
}

/** For tests. */
export function resetNodeAuthClientState(): void {
  clockOffsetMs = 0;
  listeners.clear();
}
