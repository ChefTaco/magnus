/**
 * Authentication of this agent's requests to the Control API (see docs/NODE_CREDENTIALS.md in the
 * repository). Every sender goes through {@link nodeApiFetch} or {@link controlApiAuthHeaders}.
 *
 * Once the node has a bound key, each request is signed for the pinned server key. The shared node
 * secret is still sent as well: a server older than node credentials ignores the signature headers
 * and keeps working, and a server in compat mode ignores the secret once the signature verifies.
 */
import { CONTROL_API_URL, NODE_MANAGER_SECRET } from './env.js';
import { boundNodeIdentity } from './security/node-identity.js';
import { serverAudience, signNodeRequest } from './security/node-request-auth.js';
import { controlApiFetch } from './tls.js';

export type NodeAuthMode = 'compat' | 'warn' | 'enforce';

/**
 * `NODE_AUTH_MODE` on the agent. Parsed and reported, but reserved: in this release the agent
 * behaves as `compat` whatever the value (it accepts the shared secret on its own API and sends it
 * to the server), because local callers such as the upgrade acceptance probe still use the secret.
 */
export function nodeAuthMode(env: NodeJS.ProcessEnv = process.env): NodeAuthMode {
  const value = (env['NODE_AUTH_MODE'] ?? '').trim().toLowerCase();
  return value === 'warn' || value === 'enforce' ? value : 'compat';
}

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
  const headers: Record<string, string> = { 'x-node-token': NODE_MANAGER_SECRET };
  const identity = boundNodeIdentity();
  const serverKey = identity?.binding.serverKeys[0];
  if (!identity || !serverKey) return headers;
  return { ...headers, ...signNodeRequest({ privateKey: identity.privateKey, keyId: identity.keyId, nodeId: identity.binding.nodeId,
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
