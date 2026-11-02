import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface SignedCommandResult {
  commandId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  coordination?: { version: 1; resourceKey: string; fence: string; expiresAt: number; requestSha256: string };
  completion?: { registryVersion:1; registrySha256:string; descriptorId:string };
  signature: string;
}

export function commandResultSigningPayload(result: Omit<SignedCommandResult, 'signature'>): string {
  return JSON.stringify({
    version: result.completion ? 3 : result.coordination ? 2 : 1,
    commandId: result.commandId,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdoutSha256: createHash('sha256').update(result.stdout).digest('hex'),
    stderrSha256: createHash('sha256').update(result.stderr).digest('hex'),
    truncated: result.truncated,
    ...(result.coordination ? { coordination: {
      version: result.coordination.version, resourceKey: result.coordination.resourceKey,
      fence: result.coordination.fence, expiresAt: result.coordination.expiresAt,
      requestSha256: result.coordination.requestSha256,
    } } : {}),
    ...(result.completion ? { completion: { registryVersion: result.completion.registryVersion,
      registrySha256: result.completion.registrySha256, descriptorId: result.completion.descriptorId } } : {}),
  });
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
}

export function commandRefusalSigningPayload(refusal: Omit<CommandRefusal, 'signature'>): string {
  return JSON.stringify({ domain: 'magnus.command-refusal.v1', commandId: refusal.commandId, requestSha256: refusal.requestSha256,
    code: refusal.code, highWater: refusal.highWater, nodeFqdn: refusal.nodeFqdn, leaseId: refusal.leaseId });
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
  signature: string;
}

export function commandAbsenceSigningPayload(absence: Omit<CommandAbsence, 'signature'>): string {
  return JSON.stringify({ domain: 'magnus.command-absence.v1', commandId: absence.commandId, nodeFqdn: absence.nodeFqdn, nonce: absence.nonce,
    ledgerExists: absence.ledgerExists, receipt: absence.receipt, activeLock: absence.activeLock, resourceKey: absence.resourceKey,
    fenceHighWater: absence.fenceHighWater, markerState: absence.markerState, markerNodeId: absence.markerNodeId });
}

/** The fence high-water a preflight reports, bound to the node and a fresh nonce. Only this can move a server generation. */
export function fenceProofSigningPayload(proof: { nonce: string; nodeFqdn: string; fenceHighWater: Readonly<Record<string, string>> }): string {
  return JSON.stringify({ domain: 'magnus.fence-high-water.v1', nonce: proof.nonce, nodeFqdn: proof.nodeFqdn,
    fenceHighWater: Object.fromEntries(Object.entries(proof.fenceHighWater).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) });
}

/** HMAC check of a signed refusal or absence payload against the active or previous result key. */
export function verifyCommandEvidence(payload: string, signature: unknown, activeSecret: string, previousSecret = ''): boolean {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature) || activeSecret.length < 32) return false;
  const actual = Buffer.from(signature, 'hex');
  return [activeSecret, previousSecret].filter(secret => secret.length >= 32)
    .some(secret => timingSafeEqual(actual, createHmac('sha256', secret).update(payload).digest()));
}
