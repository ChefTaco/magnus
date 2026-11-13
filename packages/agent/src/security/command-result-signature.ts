// Parsed optional wire fields may be undefined; signing still omits them identically.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { commandAbsenceSigningPayload, commandReconciliationSigningPayload, commandRefusalSigningPayload,
  commandResultSigningPayload, fenceProofSigningPayload } from './node-evidence.js';

// The canonical payloads live in node-evidence.ts, shared byte-for-byte with the server.
export { commandAbsenceSigningPayload, commandReconciliationSigningPayload, commandRefusalSigningPayload,
  commandResultSigningPayload, fenceProofSigningPayload };

export interface SignableCommandResult {
  commandId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  coordination?: { version: 1; resourceKey: string; fence: string; expiresAt: number; requestSha256: string } | undefined;
  completion?: { registryVersion:1; registrySha256:string; descriptorId:string } | undefined;
}

export function signCommandResult(result: SignableCommandResult, secret: string): string {
  if (secret.length < 32) {
    throw new Error('RESULT_SIGNING_SECRET must contain at least 32 characters');
  }
  return createHmac('sha256', secret).update(commandResultSigningPayload(result)).digest('hex');
}

export function verifyCommandResult(result: SignableCommandResult & { signature: string }, secret: string): boolean {
  if (secret.length < 32 || !/^[a-f0-9]{64}$/.test(result.signature)) return false;
  return timingSafeEqual(Buffer.from(result.signature, 'hex'), Buffer.from(signCommandResult(result, secret), 'hex'));
}

export interface CommandReconciliationAssertion {
  nodeFqdn: string;
  commandId: string;
  requestSha256: string;
  coordination?: { version: 1; resourceKey: string; fence: string; expiresAt: number } | undefined;
  disposition: 'effects_verified' | 'no_effect_verified';
  evidenceSha256: string;
  approvalRef: string;
  decisionId: string;
  expiresAt: number;
  /** The COMMAND_RECONCILIATION_SECRET HMAC; absent when the server signed with its key only. */
  signature?: string | undefined;
  /** The server key's signature for this node (security/evidence-signing.ts verifies it). */
  serverSignature?: { alg: 'ed25519'; v: 1; nodeId: string; keyId: string; sig: string } | undefined;
}

export function verifyCommandReconciliation(assertion: CommandReconciliationAssertion, secret: string): boolean {
  if (secret.length < 32 || typeof assertion.signature !== 'string' || !/^[a-f0-9]{64}$/.test(assertion.signature)) return false;
  const expected = createHmac('sha256', secret).update(commandReconciliationSigningPayload(assertion)).digest();
  return timingSafeEqual(expected, Buffer.from(assertion.signature, 'hex'));
}

/**
 * A certain refusal: this exact request did not start and has no receipt. Bound
 * to the request digest, the lease and the node, so it settles nothing else.
 */
export interface CommandRefusal {
  commandId: string;
  requestSha256: string;
  code: string;
  highWater: string | null;
  nodeFqdn: string;
  leaseId: string;
  signature: string;
}

/**
 * What this ledger holds about a command right now, bound to the node and a fresh
 * nonce. Absence means something only next to positive evidence that a ledger is
 * there at all: its root, the fence high-water and the enrollment marker.
 */
export interface CommandAbsence {
  commandId: string;
  nodeFqdn: string;
  nonce: string;
  ledgerExists: boolean;
  receipt: boolean;
  activeLock: boolean;
  resourceKey: string;
  fenceHighWater: string | null;
  markerState: 'absent' | 'present' | 'unknown';
  markerNodeId: string | null;
  /** The fence of this command's durable record of a failed admission, if it has one. */
  admissionFailedFence: string | null;
  signature: string;
}

export function signCommandEvidence(payload: string, secret: string): string {
  if (secret.length < 32) throw new Error('RESULT_SIGNING_SECRET must contain at least 32 characters');
  return createHmac('sha256', secret).update(payload).digest('hex');
}
