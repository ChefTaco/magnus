/**
 * Which evidence the server accepts about one node (see docs/NODE_CREDENTIALS.md, "Signed evidence").
 *
 * Evidence carries the legacy HMAC (`signature`, the fleet-wide `RESULT_SIGNING_SECRET`) and, from
 * an agent of this release with a bound key, an Ed25519 `nodeSignature` made with the node key over
 * the same payload, the node id and the key id. The rules:
 *
 *   1. A `nodeSignature` by a key the server knows decides: it must belong to this node (ACTIVE, or
 *      RETIRING inside its grace period), name this node, and verify. Anything else is refused, and a
 *      valid HMAC next to it does not help.
 *   2. Without one (or with a key this server does not know, e.g. after a database restore), the
 *      HMAC is accepted, counted as legacy use, unless
 *        - the mode is `enforce`, or
 *        - the node's agent said in its last signed heartbeat that it signs evidence with its key
 *          (the evidence ratchet: an agent of this release never sends HMAC-only evidence then, so
 *          HMAC-only evidence for that node is a forgery or a replay).
 *
 * Load a policy once per operation with {@link nodeEvidencePolicy}; `verify` is synchronous so it
 * fits the existing verification code, including inside transactions.
 */
import { keyFingerprint } from '../security/node-request-auth.js';
import { readEvidenceSignature, verifyNodeEvidence, type NodeEvidenceKind } from '../security/node-evidence.js';
import { logAuditEvent } from './audit-service.js';
import { nodeAuthMode } from './node-auth-config.js';
import { nodeCredentialStore, type CredentialRow } from './node-credential-store.js';
import { recordLegacyUse, recordUnattributedLegacyUse } from './node-legacy-use.js';
import { verifyCommandEvidence } from '../security/command-result-signature.js';
import { RESULT_SIGNING_PREVIOUS_SECRET, RESULT_SIGNING_SECRET } from '../utils/env.js';

export type EvidenceVerdict =
  | { ok: true; method: 'ed25519' | 'hmac' }
  | { ok: false; reason: 'NODE_SIGNATURE_INVALID' | 'WRONG_NODE' | 'KEY_NOT_VALID' | 'HMAC_REFUSED' | 'HMAC_INVALID' };

export interface NodeEvidencePolicy {
  readonly nodeId: string | null;
  /** True when evidence for this node must carry a valid node signature. */
  readonly requiresNodeSignature: boolean;
  /**
   * Judge one piece of evidence. `payload` is the exact canonical text (the HMAC message);
   * `legacyHmac` checks the HMAC and is called only when the rules allow it.
   */
  check(kind: NodeEvidenceKind, payload: string, nodeSignature: unknown, legacyHmac: () => boolean): EvidenceVerdict;
  verify(kind: NodeEvidenceKind, payload: string, nodeSignature: unknown, legacyHmac: () => boolean): boolean;
}

const refusalAudits = new Map<string, number>();
function auditRefusal(nodeId: string | null, kind: NodeEvidenceKind, reason: string, keyId: string | null): void {
  const id = `${nodeId ?? '-'}:${kind}:${reason}`;
  const now = Date.now();
  if ((refusalAudits.get(id) ?? 0) > now - 60 * 60 * 1000) return;
  if (refusalAudits.size > 5000) refusalAudits.clear();
  refusalAudits.set(id, now);
  void logAuditEvent({ action: 'node.credential.evidence_refused', actorType: 'agent', actorId: nodeId ? `node:${nodeId}` : 'node:unknown',
    targetType: 'node', targetId: nodeId ?? 'unknown', details: { kind, reason, ...(keyId ? { keyFingerprint: keyFingerprint(keyId) } : {}) } })
    .catch(() => undefined);
}

function usable(row: CredentialRow, now: number): boolean {
  return row.status === 'ACTIVE' || (row.status === 'RETIRING' && row.retireAt !== null && row.retireAt.getTime() > now);
}

/** Build a policy from the node's credential rows. Exported for tests; production code uses {@link nodeEvidencePolicy}. */
export function evidencePolicyFor(nodeId: string | null, rows: readonly CredentialRow[], now = Date.now()): NodeEvidencePolicy {
  const mode = nodeAuthMode();
  const valid = rows.filter(row => usable(row, now));
  const known = new Map(rows.map(row => [row.keyId, row]));
  const ratchet = valid.some(row => row.evidenceSigning);
  const requiresNodeSignature = mode === 'enforce' || ratchet;
  const check: NodeEvidencePolicy['check'] = (kind, payload, nodeSignature, legacyHmac) => {
    const signature = readEvidenceSignature(nodeSignature);
    if (signature === 'MALFORMED') { auditRefusal(nodeId, kind, 'NODE_SIGNATURE_INVALID', null); return { ok: false, reason: 'NODE_SIGNATURE_INVALID' }; }
    if (signature) {
      // Evidence signed as another node is refused outright, whatever key it names.
      if (!nodeId || signature.nodeId !== nodeId) { auditRefusal(nodeId, kind, 'WRONG_NODE', signature.keyId); return { ok: false, reason: 'WRONG_NODE' }; }
      const row = known.get(signature.keyId);
      if (row) {
        if (!usable(row, now)) { auditRefusal(nodeId, kind, 'KEY_NOT_VALID', row.keyId); return { ok: false, reason: 'KEY_NOT_VALID' }; }
        const verified = verifyNodeEvidence(kind, { signature, publicKey: row.publicKey, expectedNodeId: nodeId, payload });
        if (verified.ok) return { ok: true, method: 'ed25519' };
        auditRefusal(nodeId, kind, 'NODE_SIGNATURE_INVALID', row.keyId);
        return { ok: false, reason: 'NODE_SIGNATURE_INVALID' };
      }
      // A key this server does not know (its records were restored): judged by the HMAC rules below.
    }
    if (requiresNodeSignature) { auditRefusal(nodeId, kind, 'HMAC_REFUSED', null); return { ok: false, reason: 'HMAC_REFUSED' }; }
    if (!legacyHmac()) return { ok: false, reason: 'HMAC_INVALID' };
    if (nodeId) recordLegacyUse(nodeId, 'evidence', kind); else recordUnattributedLegacyUse(`evidence:${kind}`);
    return { ok: true, method: 'hmac' };
  };
  return { nodeId, requiresNodeSignature, check, verify: (...args) => check(...args).ok };
}

/** The evidence policy for one node (null: a node the caller cannot name, which only the HMAC rules apply to). */
export async function nodeEvidencePolicy(nodeId: string | null | undefined, now = Date.now()): Promise<NodeEvidencePolicy> {
  if (!nodeId) return evidencePolicyFor(null, [], now);
  return evidencePolicyFor(nodeId, await nodeCredentialStore.credentialsOfNode(nodeId), now);
}

/** The legacy check of evidence signed with the shared result key; `previous` also accepts the key being rotated out. */
export function resultKeyHmac(payload: string, signature: unknown, options: { previous?: boolean } = {}): () => boolean {
  return () => verifyCommandEvidence(payload, signature, RESULT_SIGNING_SECRET, options.previous === false ? '' : RESULT_SIGNING_PREVIOUS_SECRET);
}

/** A signed field, removed before an object is canonicalized for its signature. */
export function withoutEvidenceSignatures<T extends object>(value: T): Omit<T, 'signature' | 'nodeSignature'> {
  const { signature: _signature, nodeSignature: _nodeSignature, ...rest } = value as T & { signature?: unknown; nodeSignature?: unknown };
  return rest as Omit<T, 'signature' | 'nodeSignature'>;
}

/** For tests. */
export function resetEvidencePolicyState(): void {
  refusalAudits.clear();
}
