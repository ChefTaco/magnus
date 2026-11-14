/**
 * Authentication of server-to-agent requests: one place builds the headers for every call to a
 * node's management API (see docs/NODE_CREDENTIALS.md).
 *
 * Each request is signed with the server key for exactly one node. In compat and warn mode the
 * shared node secret is sent as well, until that node's agent has reported, in a signed heartbeat,
 * that it pins the key this server signs with; from then on the node only receives signatures.
 */
import { signNodeRequest, nodeAudience, pathWithQueryOf } from '../security/node-request-auth.js';
import { getNodeManagerSecret } from '../utils/env.js';
import { nodeAuthMode } from './node-auth-config.js';
import { serverSigningKey } from './node-server-key.js';
import { nodeCredentialStore } from './node-credential-store.js';
import { recordLegacyUse } from './node-legacy-use.js';

const PIN_TTL_MS = 10 * 60_000;
const pins = new Map<string, { keyIds: readonly string[]; at: number }>();
let keyWarningAt = 0;

/** Record which server keys a node's agent pins. Call only for a heartbeat that carried a valid signature. */
export function noteAgentServerKeyPins(nodeId: string, keyIds: unknown, now = Date.now()): void {
  const valid = Array.isArray(keyIds) ? keyIds.filter((id): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)).slice(0, 4) : [];
  if (pins.size > 50_000) pins.clear();
  if (valid.length > 0) pins.set(nodeId, { keyIds: valid, at: now }); else pins.delete(nodeId);
}

/** Whether the node's agent verifies this server's signatures, as far as its recent heartbeats say. */
export function agentVerifiesServerSignatures(nodeId: string, activeKeyId: string, now = Date.now()): boolean {
  const entry = pins.get(nodeId);
  return entry !== undefined && now - entry.at <= PIN_TTL_MS && entry.keyIds.includes(activeKeyId);
}

const evidenceSigning = new Map<string, boolean>();
/**
 * Record whether the agent holding `keyId` signs its evidence with it. Call only for a heartbeat that
 * carried a valid signature by that key. Writes only when the value changes.
 */
export function noteAgentEvidenceSigning(keyId: string, signs: boolean, now = new Date()): void {
  if (evidenceSigning.get(keyId) === signs) return;
  if (evidenceSigning.size > 50_000) evidenceSigning.clear();
  evidenceSigning.set(keyId, signs);
  void nodeCredentialStore.setEvidenceSigning(keyId, signs, now).catch((error: unknown) => {
    evidenceSigning.delete(keyId);
    console.warn(`[node-auth] could not record evidence signing of a node key: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/** Forget what a node advertised, for example after it refused a signature-only request. */
export function forgetAgentServerKeyPins(nodeId: string): void {
  pins.delete(nodeId);
}

export interface AgentRequestTarget {
  /** The node being called. Without it a request cannot be signed and carries the shared secret only. */
  nodeId?: string | undefined;
  /** The shared secret to send while it is still needed; defaults to the configured one. */
  legacyToken?: string | undefined;
}

/**
 * Authentication headers for one request to an agent. `body` is the exact bytes that will be sent.
 * Never log the result: it may carry the shared node secret.
 */
export function agentAuthHeaders(target: AgentRequestTarget, method: string, url: string | URL, body: string | Uint8Array = ''): Record<string, string> {
  const mode = nodeAuthMode();
  const legacy = (): Record<string, string> => ({ 'x-node-token': target.legacyToken ?? getNodeManagerSecret() });
  if (!target.nodeId) {
    if (mode === 'enforce') throw new Error('A request to an agent must name its node to be signed (NODE_AUTH_MODE=enforce)');
    return legacy();
  }
  let signature: Record<string, string>;
  let activeKeyId: string;
  try {
    const key = serverSigningKey();
    activeKeyId = key.keyId;
    signature = signNodeRequest({ privateKey: key.privateKey, keyId: key.keyId, nodeId: target.nodeId, audience: nodeAudience(target.nodeId),
      method, pathWithQuery: pathWithQueryOf(url), body });
  } catch (error) {
    if (mode === 'enforce') throw error;
    // Outside enforce mode a missing or unreadable server key must not stop fleet operations.
    if (Date.now() - keyWarningAt > 10 * 60_000) {
      keyWarningAt = Date.now();
      console.warn(`[node-auth] requests to agents are not signed: ${error instanceof Error ? error.message : String(error)}`);
    }
    recordLegacyUse(target.nodeId, 'outbound', 'unsigned: server key unavailable');
    return legacy();
  }
  if (mode === 'enforce' || agentVerifiesServerSignatures(target.nodeId, activeKeyId)) return signature;
  recordLegacyUse(target.nodeId, 'outbound', `${method.toUpperCase()} ${pathWithQueryOf(url).split('?')[0]}`);
  return { ...legacy(), ...signature };
}

/**
 * Agents 2.10.0 and 2.10.1 that have a node key authenticate `POST /api/v1/commands/managed-http`
 * twice: the second pass finds the nonce the first one claimed and refuses every signed request on
 * that route as a replay (401 NODE_AUTH_REPLAY), before the handler runs. The shared secret has no
 * nonce, so it passes both. Fixed in the 2.10.2 agent.
 */
export function agentRefusesSignedManagedHttp(version: unknown, nodeAuth: unknown): boolean {
  return nodeAuth === 1 && typeof version === 'string' && /^2\.10\.[01](?:[-+][0-9A-Za-z.+-]*)?$/.test(version);
}

/**
 * The headers of a request that must reach such an agent without a signature: the shared secret
 * only, which compat and warn mode also send to any node whose key pins are not current. Refused
 * in enforce mode. The request's own authority (a resource claim the agent confirms with this
 * server over its signed channel, and its once-only ledger receipt) is unchanged.
 */
export function unsignedAgentAuthHeaders(target: AgentRequestTarget, method: string, url: string | URL, reason: string): Record<string, string> {
  if (nodeAuthMode() === 'enforce') throw new Error('An unsigned request to an agent is refused (NODE_AUTH_MODE=enforce)');
  if (target.nodeId) recordLegacyUse(target.nodeId, 'outbound', `${method.toUpperCase()} ${pathWithQueryOf(url).split('?')[0]} (${reason})`);
  return { 'x-node-token': target.legacyToken ?? getNodeManagerSecret() };
}

/** `fetch` for a node's agent with the authentication headers added. `init.body`, when present, must be a string or bytes. */
export function agentFetch(target: AgentRequestTarget, url: string | URL, init: RequestInit = {}): Promise<Response> {
  const body = init.body ?? '';
  if (typeof body !== 'string' && !(body instanceof Uint8Array)) throw new Error('A signed agent request needs a string or byte body');
  const headers = { ...Object.fromEntries(new Headers(init.headers)), ...agentAuthHeaders(target, init.method ?? 'GET', url, body) };
  return fetch(url, { ...init, headers });
}

/** For tests. */
export function resetAgentAuthState(): void {
  pins.clear();
  evidenceSigning.clear();
  keyWarningAt = 0;
}
