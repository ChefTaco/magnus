/**
 * Decisions the server hands to one node (a command reconciliation, a scheduler enrollment stage),
 * signed with the server key for that node instead of the fleet-wide `COMMAND_RECONCILIATION_SECRET`
 * (see docs/NODE_CREDENTIALS.md, "Signed evidence").
 *
 * An agent of this release that pins the server key verifies `serverSignature` and advertises
 * `features.serverAuthorizations: 1` in `/api/v1/ping`; older agents only know the HMAC, so the
 * server keeps adding it while `COMMAND_RECONCILIATION_SECRET` is set. When such a decision comes
 * back from the node (its receipt), the server checks the same signature against its own keys.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readEvidenceSignature, signServerAuthorization, verifyServerAuthorization, type EvidenceSignature,
  type ServerAuthorizationKind } from '../security/node-evidence.js';
import { nodeAuthMode } from './node-auth-config.js';
import { serverSigningKey, serverVerificationKeys } from './node-server-key.js';
import { API_SECRET, getNodeManagerSecret, RESULT_SIGNING_PREVIOUS_SECRET, RESULT_SIGNING_SECRET } from '../utils/env.js';

/** The server's signature of a decision for `nodeId`, or null when the server key cannot be read (outside enforce mode). */
export function serverAuthorizationSignature(nodeId: string, kind: ServerAuthorizationKind, payload: string): EvidenceSignature | null {
  try {
    const key = serverSigningKey();
    return signServerAuthorization(key.privateKey, key.keyId, nodeId, kind, payload);
  } catch (error) {
    if (nodeAuthMode() === 'enforce') throw error;
    console.warn(`[node-auth] decision for ${nodeId} is not signed with the server key: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Whether the server signing key is readable, so decisions can be signed for agents that verify it. */
export function serverCanSignDecisions(): boolean {
  try { serverSigningKey(); return true; } catch { return false; }
}

/**
 * Check a decision this server issued for `nodeId`, as returned by the node. A server signature by
 * one of this server's keys decides, whichever key signed it: the active one, a staged or replaced
 * one, or one retired since (its public key is kept for exactly this), so a decision stored before a
 * server-key rotation keeps verifying. Without one the HMAC is accepted outside enforce mode.
 */
export function verifyServerAuthorizationFor(nodeId: string, kind: ServerAuthorizationKind, payload: string, serverSignature: unknown,
  legacyHmac: () => boolean): boolean {
  const signature = readEvidenceSignature(serverSignature);
  if (signature === 'MALFORMED') return false;
  if (signature) {
    let keys: ReturnType<typeof serverVerificationKeys> = [];
    try { keys = serverVerificationKeys(); } catch { /* no server key: the HMAC rules apply */ }
    const key = keys.find(entry => entry.keyId === signature.keyId);
    if (key) return verifyServerAuthorization(kind, { signature, publicKey: key.publicKey, expectedNodeId: nodeId, payload }).ok;
    // Signed by a key this server no longer has (its key file was replaced): the HMAC rules apply.
  }
  return nodeAuthMode() !== 'enforce' && legacyHmac();
}

/**
 * The dedicated `COMMAND_RECONCILIATION_SECRET`, or null when it is missing or reuses another
 * credential. Only agents without a node key need it (`features.serverAuthorizations` absent).
 */
function nodeSecretOrEmpty(): string {
  try { return getNodeManagerSecret(); } catch { return ''; }
}

export function commandReconciliationKey(): string | null {
  // Enforce mode refuses HMAC-only decisions, so it never makes one either.
  if (nodeAuthMode() === 'enforce') return null;
  const secret = process.env['COMMAND_RECONCILIATION_SECRET'] ?? '';
  const others = [RESULT_SIGNING_SECRET, RESULT_SIGNING_PREVIOUS_SECRET, nodeSecretOrEmpty(), process.env['NODE_MANAGER_SECRET_PREVIOUS'] ?? '',
    process.env['RESOURCE_PARTICIPANT_RECONCILIATION_SECRET'] ?? '', API_SECRET];
  return secret.length >= 32 && !others.some(value => value && value === secret) ? secret : null;
}

/** What identifies one signed decision on the wire: its HMAC, or its server signature when it has none. */
export function decisionIdentity(assertion: { signature?: string | undefined; serverSignature?: { sig: string } | undefined }): string {
  return assertion.signature ?? assertion.serverSignature?.sig ?? '';
}

/**
 * Sign a decision for one node: with the server key when its agent verifies server signatures (always
 * in enforce mode), and with `COMMAND_RECONCILIATION_SECRET` when that is configured outside enforce
 * mode (agents without a node key). Null when neither applies; the caller answers 409
 * RECONCILIATION_UNAVAILABLE.
 */
export function signNodeDecision<T extends object>(nodeId: string, kind: ServerAuthorizationKind, unsigned: T, payload: string,
  options: { agentVerifiesServerSignatures: boolean }): (T & { signature?: string; serverSignature?: EvidenceSignature }) | null {
  const key = commandReconciliationKey();
  const serverSignature = options.agentVerifiesServerSignatures || nodeAuthMode() === 'enforce'
    ? serverAuthorizationSignature(nodeId, kind, payload) : null;
  if (!key && !serverSignature) return null;
  return { ...unsigned, ...(key ? { signature: createHmac('sha256', key).update(payload).digest('hex') } : {}),
    ...(serverSignature ? { serverSignature } : {}) };
}

/** Check a decision about `nodeId` that this server issued, as returned by the node: server key first, then the HMAC. */
export function verifyNodeDecision(nodeId: string, kind: ServerAuthorizationKind, payload: string,
  assertion: { signature?: string | undefined; serverSignature?: unknown }): boolean {
  return verifyServerAuthorizationFor(nodeId, kind, payload, assertion.serverSignature, () => {
    const key = commandReconciliationKey();
    if (!key || typeof assertion.signature !== 'string' || !/^[a-f0-9]{64}$/.test(assertion.signature)) return false;
    return timingSafeEqual(createHmac('sha256', key).update(payload).digest(), Buffer.from(assertion.signature, 'hex'));
  });
}
