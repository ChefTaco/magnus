/**
 * This agent's side of signed evidence (see docs/NODE_CREDENTIALS.md in the repository).
 *
 * Evidence the agent hands to the Control API keeps its legacy HMAC (`signature`, made with
 * `RESULT_SIGNING_SECRET`) and, once the node has a bound key and the Control API said it verifies
 * such signatures, also carries `nodeSignature`: Ed25519 by the node key over the same payload, the
 * node id and the key id. A server older than node evidence never sees the extra field.
 *
 * Decisions the Control API sends to this node (a command reconciliation, a scheduler enrollment
 * stage) are accepted with a `serverSignature` by a server key this agent pins and made for this
 * node; the `COMMAND_RECONCILIATION_SECRET` HMAC is accepted too, except in enforce mode.
 */
import { boundNodeIdentity } from './node-identity.js';
import { readEvidenceSignature, signNodeEvidence, verifyServerAuthorization, type EvidenceSignature, type NodeEvidenceKind,
  type ServerAuthorizationKind } from './node-evidence.js';
import { agentEnforcesNodeAuth } from '../node-auth.js';
import { commandResultSigningPayload, type SignableCommandResult } from './command-result-signature.js';

/** `{ nodeSignature }` for evidence about this node, or `{}` while it cannot or should not be signed. */
export function nodeEvidenceFields(kind: NodeEvidenceKind, payload: string): { nodeSignature?: EvidenceSignature } {
  const identity = boundNodeIdentity();
  if (!identity?.binding.serverEvidence) return {};
  try {
    return { nodeSignature: signNodeEvidence(identity.privateKey, identity.keyId, identity.binding.nodeId, kind, payload) };
  } catch {
    // Signing never fails a command: the HMAC still travels, and the server's rules decide.
    return {};
  }
}

/** Whether this agent signs evidence with its node key right now (reported in signed heartbeats). */
export function signsNodeEvidence(): boolean {
  return boundNodeIdentity()?.binding.serverEvidence === true;
}

/** Whether this agent verifies decisions signed with a server key (it has a bound key and pins a server key). */
export function verifiesServerDecisions(): boolean {
  return (boundNodeIdentity()?.binding.serverKeys.length ?? 0) > 0;
}

/**
 * Check a decision the Control API made for this node. A `serverSignature` by a pinned server key
 * decides; a malformed or invalid one is refused. Without one (or with a key this agent does not
 * pin), the HMAC check applies, unless this agent enforces node credentials.
 */
export function verifyServerDecision(kind: ServerAuthorizationKind, payload: string, serverSignature: unknown, legacyHmac: () => boolean): boolean {
  const signature = readEvidenceSignature(serverSignature);
  if (signature === 'MALFORMED') return false;
  if (signature) {
    const identity = boundNodeIdentity();
    const pinned = identity?.binding.serverKeys.find(key => key.keyId === signature.keyId);
    if (identity && pinned)
      return verifyServerAuthorization(kind, { signature, publicKey: pinned.publicKey, expectedNodeId: identity.binding.nodeId, payload }).ok;
  }
  return !agentEnforcesNodeAuth() && legacyHmac();
}

/** A signed command result as it leaves this agent: the stored HMAC form plus, when due, the node signature. Never stored. */
export function withResultEvidence<T extends SignableCommandResult & { signature: string }>(result: T): T & { nodeSignature?: EvidenceSignature } {
  const { nodeSignature: _stale, ...plain } = result as T & { nodeSignature?: unknown };
  return { ...plain as T, ...nodeEvidenceFields('command-result', commandResultSigningPayload(plain as T)) };
}
