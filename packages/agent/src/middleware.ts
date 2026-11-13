import type { Context, Next } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { NODE_MANAGER_SECRET as NODE_SECRET, NODE_MANAGER_SECRET_PREVIOUS as NODE_SECRET_PREVIOUS } from './env.js';
import { agentEnforcesNodeAuth, nodeAuthMode, nodeAuthNow, selfAudience } from './node-auth.js';
import { logger } from './utils/logger.js';
import { refreshPinnedServerKeys } from './node-enrollment.js';
import { boundNodeIdentity } from './security/node-identity.js';
import { NonceCache, nodeAudience, pathWithQueryOf, readNodeAuthHeaders, verifyNodeRequest } from './security/node-request-auth.js';

const serverNonces = new NonceCache();
const localDispatch = new WeakSet<Request>();
let sharedSecretWarnedAt = 0;
const SELF_SIGNED_ROUTE = '/api/v1/health/check';

/**
 * Mark a request this process builds and hands to its own app (`app.request(request)`), such as the
 * in-process managed HTTP dispatch. Only an object created in this process can carry the mark, so a
 * request from the network never passes as local. Returns the request.
 */
export function markLocalDispatch(request: Request): Request {
  localDispatch.add(request);
  return request;
}

function refused(c: Context, code: string, message: string): Response {
  return c.json({ success: false, error: { code, message } }, 401);
}

/** Constant-time string comparison to prevent timing attacks. */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare against self to avoid leaking length information via timing
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Auth middleware for control-api → node-manager calls (see docs/NODE_CREDENTIALS.md).
 *
 *   - A request this process dispatched to itself ({@link markLocalDispatch}) passes.
 *   - A request signed by a server key this agent pins is verified as such: made for this node (the
 *     audience), fresh, not replayed, and with the exact method, path, query and body. A signature
 *     that does not verify is refused even when a valid shared secret comes with it.
 *   - A request signed by this node's own key (the upgrade acceptance probe, run on this host) is
 *     accepted on the health check only.
 *   - Otherwise the shared secret (`x-node-token`) decides, unless NODE_AUTH_MODE=enforce is in
 *     effect: then a request without a valid signature is refused on every route.
 *
 * Accepts the active `NODE_MANAGER_SECRET` and, during a rotation, the bounded
 * `NODE_MANAGER_SECRET_PREVIOUS` grace credential so the control-api and agents
 * can be rolled in any order without a flag-day.
 */
export async function nodeAuthMiddleware(c: Context, next: Next): Promise<Response | void> {
  if (localDispatch.has(c.req.raw)) { await next(); return; }
  const signature = readNodeAuthHeaders(name => c.req.header(name));
  if (signature === 'MALFORMED') return refused(c, 'NODE_SIGNATURE_INVALID', 'The server signature headers are malformed');
  if (signature) {
    const identity = boundNodeIdentity();
    if (identity && signature.keyId === identity.keyId) {
      // Signed by this node's own key: a process on this host that can read the key (the acceptance probe).
      if (c.req.method !== 'GET' || c.req.path !== SELF_SIGNED_ROUTE)
        return refused(c, 'NODE_SIGNATURE_INVALID', 'A request signed with the node key is accepted on the health check only');
      const verified = verifyNodeRequest({ headers: signature, publicKey: identity.publicKey, expectedNodeId: identity.binding.nodeId,
        audiences: [selfAudience(identity.binding.nodeId)], method: c.req.method, pathWithQuery: pathWithQueryOf(c.req.url), body: new Uint8Array() });
      if (!verified.ok) return refused(c, 'NODE_SIGNATURE_INVALID', 'The node signature does not verify');
      if (!serverNonces.claim(signature.keyId, signature.nonce)) return refused(c, 'NODE_AUTH_REPLAY', 'This signed request was already received');
      await next();
      return;
    }
    const pinned = identity?.binding.serverKeys.find(key => key.keyId === signature.keyId);
    if (identity && pinned) {
      const hasBody = c.req.method !== 'GET' && c.req.method !== 'HEAD';
      const verified = verifyNodeRequest({ headers: signature, publicKey: pinned.publicKey, expectedNodeId: identity.binding.nodeId,
        audiences: [nodeAudience(identity.binding.nodeId)], method: c.req.method, pathWithQuery: pathWithQueryOf(c.req.url),
        body: hasBody ? new Uint8Array(await c.req.arrayBuffer()) : new Uint8Array(), now: nodeAuthNow() });
      if (!verified.ok) return refused(c, verified.reason === 'SKEW' ? 'NODE_AUTH_SKEW' : 'NODE_SIGNATURE_INVALID',
        verified.reason === 'SKEW' ? 'The request timestamp is outside the accepted clock window' : 'The server signature does not verify for this node');
      if (!serverNonces.claim(signature.keyId, signature.nonce)) return refused(c, 'NODE_AUTH_REPLAY', 'This signed request was already received');
      await next();
      return;
    }
    // Signed by a key this agent has not pinned (the server's key changed): read the keys again
    // from the Control API, and judge this request by the shared secret.
    if (identity) void refreshPinnedServerKeys();
  }
  // Enforce: the shared secret no longer opens this agent's API. This is what stops one node's
  // credentials from managing another node.
  if (agentEnforcesNodeAuth())
    return refused(c, 'NODE_SIGNATURE_REQUIRED', 'This agent accepts only requests signed by the Control API (NODE_AUTH_MODE=enforce)');
  const token = c.req.header('x-node-token');
  if (!token) {
    return c.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Missing x-node-token header' } }, 401);
  }

  if (!NODE_SECRET) {
    return c.json({ success: false, error: { code: 'CONFIG_ERROR', message: 'NODE_MANAGER_SECRET not configured' } }, 500);
  }

  // Evaluate both candidates unconditionally to avoid leaking which matched.
  const matchesActive = constantTimeEqual(token, NODE_SECRET);
  const matchesPrevious = NODE_SECRET_PREVIOUS.length > 0 && constantTimeEqual(token, NODE_SECRET_PREVIOUS);
  if (!matchesActive && !matchesPrevious) {
    return c.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid node token' } }, 401);
  }
  if (nodeAuthMode() === 'warn' && Date.now() - sharedSecretWarnedAt > 10 * 60_000) {
    sharedSecretWarnedAt = Date.now();
    logger.warn(`Shared node secret accepted on ${c.req.method} ${c.req.path}; set NODE_AUTH_MODE=enforce once this node has a key (docs/NODE_CREDENTIALS.md)`);
  }

  await next();
}
