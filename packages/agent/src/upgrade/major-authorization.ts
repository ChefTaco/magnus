/**
 * A self-upgrade across a major version needs the server's explicit permission for this node: the
 * request's `majorAuthorization`, signed with a server key this agent pins (kind
 * `agent-major-upgrade`) over the package, the version this agent runs, the target version, the
 * tarball integrity and an expiry. The shared node secret can never grant it, and neither can a
 * signature made for another node, another version or another tarball. Without a bound key and a
 * pinned server key there is nothing to verify against, so the upgrade is refused.
 */
import type { AgentUpgradeRequest } from '@hivemagnus/magnus-contracts';
import { nodeAuthNow } from '../node-auth.js';
import { agentMajorUpgradeSigningPayload, readEvidenceSignature, verifyServerAuthorization } from '../security/node-evidence.js';
import { boundNodeIdentity } from '../security/node-identity.js';

/** Reported in the self-upgrade status (`majorUpgradeAuthorization`), so the server knows it may send one. */
export const MAJOR_UPGRADE_AUTHORIZATION_PROTOCOL = 1;
/** The longest validity the agent accepts: an authorization is for one upgrade run, not a standing permission. */
export const MAX_MAJOR_AUTHORIZATION_MS = 24 * 60 * 60_000;

export type MajorAuthorizationVerdict = { ok: true } | { ok: false; reason: string };

/** Whether `request` (a target in another major version than `from`) carries a valid authorization for this node. */
export function checkMajorAuthorization(request: AgentUpgradeRequest, from: string, now = nodeAuthNow()): MajorAuthorizationVerdict {
  const no = (reason: string): MajorAuthorizationVerdict => ({ ok: false, reason });
  const authorization = request.majorAuthorization;
  if (!authorization) return no('the request carries no major-upgrade authorization');
  const identity = boundNodeIdentity();
  if (!identity || identity.binding.serverKeys.length === 0)
    return no('this node has no bound node key and pinned server key to verify a major-upgrade authorization with');
  if (!Number.isSafeInteger(authorization.expiresAt) || authorization.expiresAt <= now) return no('the major-upgrade authorization has expired');
  if (authorization.expiresAt - now > MAX_MAJOR_AUTHORIZATION_MS) return no('the major-upgrade authorization is valid for longer than 24 hours');
  const signature = readEvidenceSignature(authorization.serverSignature);
  if (signature === null) return no('the major-upgrade authorization is not signed');
  if (signature === 'MALFORMED') return no('the major-upgrade authorization signature is malformed');
  if (signature.nodeId !== identity.binding.nodeId) return no('the major-upgrade authorization is for another node');
  const pinned = identity.binding.serverKeys.find(key => key.keyId === signature.keyId);
  if (!pinned) return no('the major-upgrade authorization is signed by a key this agent does not pin');
  const payload = agentMajorUpgradeSigningPayload({ nodeId: identity.binding.nodeId, packageName: request.packageName, from, to: request.version,
    integrity: request.integrity, expiresAt: authorization.expiresAt });
  const verified = verifyServerAuthorization('agent-major-upgrade', { signature, publicKey: pinned.publicKey, expectedNodeId: identity.binding.nodeId, payload });
  return verified.ok ? { ok: true }
    : no(`the major-upgrade authorization does not verify for this node, ${from} -> ${request.version} and this integrity (${verified.reason})`);
}
