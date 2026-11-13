// Parsed optional wire fields may be undefined; signing still omits them identically.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { commandAbsenceSigningPayload, commandRefusalSigningPayload, commandResultSigningPayload,
  fenceProofSigningPayload } from './node-evidence.js';

// The canonical payloads live in node-evidence.ts, shared byte-for-byte with the agent.
export { commandAbsenceSigningPayload, commandRefusalSigningPayload, commandResultSigningPayload, fenceProofSigningPayload };

export interface SignedCommandResult {
  commandId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  coordination?: { version: 1; resourceKey: string; fence: string; expiresAt: number; requestSha256: string } | undefined;
  completion?: { registryVersion:1; registrySha256:string; descriptorId:string } | undefined;
  signature: string;
  /** Ed25519 signature by the node key; checked by services/node-evidence-policy.ts. */
  nodeSignature?: unknown;
}

export function verifyCommandResultSignature(
  result: SignedCommandResult,
  activeSecret: string,
  previousSecret = '',
): boolean {
  if (activeSecret.length < 32 || !/^[a-f0-9]{64}$/i.test(result.signature)) return false;
  const actual = Buffer.from(result.signature, 'hex');
  const candidates = [activeSecret, ...(previousSecret.length >= 32 ? [previousSecret] : [])];
  let matched = false;
  for (const secret of candidates) {
    const expected = createHmac('sha256', secret)
      .update(commandResultSigningPayload(result))
      .digest();
    matched = (actual.length === expected.length && timingSafeEqual(actual, expected)) || matched;
  }
  return matched;
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
  nodeSignature?: unknown;
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
  nodeSignature?: unknown;
}

/** HMAC check of a signed refusal or absence payload against the active or previous result key. */
export function verifyCommandEvidence(payload: string, signature: unknown, activeSecret: string, previousSecret = ''): boolean {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature) || activeSecret.length < 32) return false;
  const actual = Buffer.from(signature, 'hex');
  return [activeSecret, previousSecret].filter(secret => secret.length >= 32)
    .some(secret => timingSafeEqual(actual, createHmac('sha256', secret).update(payload).digest()));
}
