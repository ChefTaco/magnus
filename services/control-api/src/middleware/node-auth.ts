/**
 * Authentication of agent-to-server requests (see docs/NODE_CREDENTIALS.md).
 *
 * A request is accepted with a valid Ed25519 signature of a node key, or, outside enforce mode,
 * with the shared node secret (`x-node-token`). Two rules bind the caller to a node:
 *
 *   - signed: the node is the key's node. Body fields that name a node are claims and must name
 *     that node ({@link assertNodeClaims}).
 *   - shared secret: the caller may not name a node that has a credential (the per-node ratchet).
 *
 * Every route behind `nodeAuth()` must call `assertNodeClaims()` with the node its body names.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { HttpError } from './error-handler.js';
import { NonceCache, pathWithQueryOf, readNodeAuthHeaders, verifyNodeRequest, type NodeAuthHeaderValues } from '../security/node-request-auth.js';
import { secretFingerprint, verifyWithRotation } from '../services/credential-rotation-service.js';
import { nodeAuthMode } from '../services/node-auth-config.js';
import { fqdnClaimMatchesNode, reportIdentityMismatch } from '../services/node-credential-service.js';
import { nodeCredentialStore, type CredentialNode } from '../services/node-credential-store.js';
import { serverAudiences } from '../services/node-server-key.js';
import { recordLegacyUse, recordUnattributedLegacyUse } from '../services/node-legacy-use.js';
import { NODE_MANAGER_SECRET } from '../utils/env.js';

export type NodeAuthContext =
  | { method: 'signature'; node: CredentialNode; keyId: string; boundFqdn: string }
  /** `signatureProblem` is set when the caller also sent a signature this server has no key for. */
  | { method: 'legacy'; tokenFingerprint: string; signatureProblem?: 'UNKNOWN_KEY' };

export interface NodeClaims { nodeId?: string | null | undefined; fqdn?: string | null | undefined }

const contexts = new WeakMap<Request, NodeAuthContext>();
const nonces = new NonceCache();
const lastTouched = new Map<string, number>();
const legacyWarned = new Map<string, number>();
const TOUCH_INTERVAL_MS = 60_000;

export function nodeAuthOf(c: Context): NodeAuthContext {
  const context = contexts.get(c.req.raw);
  if (!context) throw new HttpError(500, 'NODE_AUTH_MISSING', 'Route is not behind node authentication');
  return context;
}

function refuse(code: string, message: string, status = 401): never {
  throw new HttpError(status, code, message);
}

async function verifySignature(c: Context, headers: NodeAuthHeaderValues): Promise<NodeAuthContext | 'UNKNOWN_KEY'> {
  const found = await nodeCredentialStore.credentialByKeyId(headers.keyId);
  if (!found) return 'UNKNOWN_KEY';
  const { credential, node } = found;
  const now = Date.now();
  if (credential.status === 'REVOKED') refuse('NODE_CREDENTIAL_REVOKED', 'This node key was revoked; enroll the node with a new token');
  if (credential.status === 'RETIRING' && (!credential.retireAt || credential.retireAt.getTime() <= now))
    refuse('NODE_CREDENTIAL_EXPIRED', 'This node key was replaced and is no longer accepted');
  if (credential.status !== 'ACTIVE' && credential.status !== 'RETIRING') refuse('NODE_CREDENTIAL_REVOKED', 'This node key is not valid');
  const hasBody = c.req.method !== 'GET' && c.req.method !== 'HEAD';
  const body = hasBody ? new Uint8Array(await c.req.arrayBuffer()) : new Uint8Array();
  const verified = verifyNodeRequest({ headers, publicKey: credential.publicKey, expectedNodeId: credential.nodeId, audiences: serverAudiences(),
    method: c.req.method, pathWithQuery: pathWithQueryOf(c.req.url), body, now });
  if (!verified.ok) {
    if (verified.reason === 'SKEW') refuse('NODE_AUTH_SKEW', 'The request timestamp is outside the accepted clock window');
    refuse('NODE_SIGNATURE_INVALID', 'The node signature does not verify');
  }
  // Only a verified request may spend a nonce, so an unauthenticated caller cannot fill the cache.
  if (!nonces.claim(headers.keyId, headers.nonce, now)) refuse('NODE_AUTH_REPLAY', 'This signed request was already received');
  if (node.status === 'DECOMMISSIONED') refuse('NODE_DECOMMISSIONED', 'This node was decommissioned', 403);
  if ((lastTouched.get(headers.keyId) ?? 0) < now - TOUCH_INTERVAL_MS) {
    if (lastTouched.size > 50_000) lastTouched.clear();
    lastTouched.set(headers.keyId, now);
    void nodeCredentialStore.touch(headers.keyId, new Date(now)).catch(() => undefined);
  }
  return { method: 'signature', node, keyId: credential.keyId, boundFqdn: credential.boundFqdn };
}

export interface NodeAuthOptions {
  /** Error code of a missing or wrong shared secret; routes keep the code their callers already know. */
  legacyErrorCode?: string;
}

/** Authenticate an agent-to-server request. Read the result with {@link nodeAuthOf}. */
export async function authenticateNode(c: Context, options: NodeAuthOptions = {}): Promise<NodeAuthContext> {
  const mode = nodeAuthMode();
  // Agents correct a wrong clock from this header (it is sent on refusals too).
  c.header('x-magnus-server-time', String(Date.now()));
  c.header('Cache-Control', 'no-store');
  const headers = readNodeAuthHeaders(name => c.req.header(name));
  let signatureProblem: 'UNKNOWN_KEY' | undefined;
  if (headers === 'MALFORMED') refuse('NODE_SIGNATURE_INVALID', 'The node signature headers are malformed');
  if (headers) {
    const result = await verifySignature(c, headers);
    if (result !== 'UNKNOWN_KEY') { contexts.set(c.req.raw, result); return result; }
    // A key this server does not know (its records were restored or the node was re-created): the
    // shared secret, when also sent, is judged on its own below, ratchet included.
    signatureProblem = 'UNKNOWN_KEY';
    if (mode === 'enforce') refuse('NODE_CREDENTIAL_UNKNOWN', 'This node key is not enrolled');
  }
  if (mode === 'enforce') refuse('NODE_SIGNATURE_REQUIRED', 'A node signature is required (NODE_AUTH_MODE=enforce)');
  const token = c.req.header('x-node-token') ?? '';
  const code = options.legacyErrorCode ?? 'UNAUTHORIZED';
  if (!token) refuse(signatureProblem ? 'NODE_CREDENTIAL_UNKNOWN' : code, signatureProblem ? 'This node key is not enrolled' : 'Node credential required');
  if (!NODE_MANAGER_SECRET) throw new HttpError(500, 'CONFIG_ERROR', 'NODE_MANAGER_SECRET not configured on control-api');
  if (!verifyWithRotation('NODE_MANAGER_SECRET', NODE_MANAGER_SECRET, token)) refuse(code, 'Node credential required');
  const context: NodeAuthContext = { method: 'legacy', tokenFingerprint: secretFingerprint(token), ...(signatureProblem ? { signatureProblem } : {}) };
  contexts.set(c.req.raw, context);
  if (mode === 'warn') {
    const path = c.req.path;
    const now = Date.now();
    if ((legacyWarned.get(path) ?? 0) < now - 10 * 60_000) {
      if (legacyWarned.size > 500) legacyWarned.clear();
      legacyWarned.set(path, now);
      console.warn(`[node-auth] shared node secret accepted on ${path}; this stops with NODE_AUTH_MODE=enforce`);
    }
  }
  return context;
}

export function nodeAuth(options: NodeAuthOptions = {}): MiddlewareHandler {
  return async (c, next) => { await authenticateNode(c, options); await next(); };
}

/**
 * Bind the node a request body names to the authenticated caller.
 *
 * Signed: `nodeId` must be the key's node; `fqdn` must be a name of that node and must not be the
 * host name of any other node. Shared secret: neither may name a node that has a credential.
 * Returns the authenticated node for a signed caller, else null.
 */
export async function assertNodeClaims(c: Context, claims: NodeClaims): Promise<CredentialNode | null> {
  const auth = nodeAuthOf(c);
  const nodeId = claims.nodeId || undefined;
  const fqdn = claims.fqdn?.trim() || undefined;
  if (auth.method === 'signature') {
    const mismatch = (nodeId !== undefined && nodeId !== auth.node.id)
      || (fqdn !== undefined && (!fqdnClaimMatchesNode(fqdn, auth.node, auth.boundFqdn) || await nodeCredentialStore.otherNodeHasHostname(auth.node.id, fqdn)));
    if (mismatch) {
      await reportIdentityMismatch(auth.node, auth.keyId, { ...(nodeId ? { claimedNodeId: nodeId } : {}), ...(fqdn ? { claimedFqdn: fqdn } : {}), path: c.req.path });
      refuse('NODE_IDENTITY_MISMATCH', 'The request names a node other than the one this key belongs to', 403);
    }
    return auth.node;
  }
  const claimed = await nodeCredentialStore.nodesClaimedBy({ ...(nodeId ? { nodeId } : {}), ...(fqdn ? { fqdn } : {}) });
  await assertLegacyMaySpeakFor(claimed.map(node => node.id));
  // Accounting: which node still speaks with the shared secret (docs/NODE_CREDENTIALS.md, legacy use).
  if (claimed.length === 1) recordLegacyUse(claimed[0]!.id, 'request', c.req.path);
  else recordUnattributedLegacyUse(c.req.path);
  return null;
}

/** The ratchet: the shared secret may not speak for a node that has a credential. */
export async function assertLegacyMaySpeakFor(nodeIds: string[]): Promise<void> {
  if ((await nodeCredentialStore.nodesWithCredentials(nodeIds)).size > 0)
    refuse('NODE_CREDENTIAL_REQUIRED', 'This node has its own key; the shared node secret is no longer accepted for it');
}

/** For tests. */
export function resetNodeAuthState(): void {
  lastTouched.clear();
  legacyWarned.clear();
}
