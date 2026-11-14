/**
 * Signed evidence (Ed25519): the canonical payloads of everything a node agent proves to the
 * Control API, and of the decisions the Control API hands to one node, with the envelope that binds
 * each of them to one node.
 *
 * This file is kept byte-identical in `services/control-api/src/security` and
 * `packages/agent/src/security`; a test in each package compares the two copies and runs the same
 * vectors (`node-evidence.vectors.json`). It uses `node:crypto` and `./node-request-auth.js` only
 * and reads no environment.
 *
 * Node evidence is signed with the node key over
 *
 *   magnus.node-evidence.v1 \n kind \n nodeId \n keyId \n payload
 *
 * and a server authorization (a decision the server sends to one node) with the server key over
 *
 *   magnus.server-authorization.v1 \n kind \n nodeId \n keyId \n payload
 *
 * where `payload` is the exact text the legacy HMAC (`RESULT_SIGNING_SECRET`,
 * `COMMAND_RECONCILIATION_SECRET`) covers. The node id is inside the signed bytes, so evidence one
 * node produced never verifies as another node's, and the key id is inside them, so a signature
 * cannot be moved to another key. The signature travels next to the legacy `signature` field as
 * `nodeSignature` (evidence) or `serverSignature` (authorization).
 */
import { createHash, sign, verify, type KeyObject } from 'node:crypto';
import { constantTimeEqualText, keyIdOfSpki, publicKeyFromSpki } from './node-request-auth.js';

export const NODE_EVIDENCE_PROTOCOL = 'magnus.node-evidence.v1';
export const SERVER_AUTHORIZATION_PROTOCOL = 'magnus.server-authorization.v1';

/** Everything a node signs as evidence. A new kind is added here, in both copies, and in the vectors. */
export const NODE_EVIDENCE_KINDS = [
  'command-result',
  'command-refusal',
  'command-absence',
  'fence-proof',
  'node-session-receipt',
  'enrollment-drain',
  'scheduler-drain',
  'host-local-writer',
  'os-scheduler-writer',
  'terminal-receipt',
  'cron-stage-receipt',
  'scheduler-settlement-receipt',
] as const;
export type NodeEvidenceKind = typeof NODE_EVIDENCE_KINDS[number];

/** Every decision the server signs for one node. */
export const SERVER_AUTHORIZATION_KINDS = ['command-reconciliation', 'cron-enrollment-stage', 'scheduler-source-settlement'] as const;
export type ServerAuthorizationKind = typeof SERVER_AUTHORIZATION_KINDS[number];

/** The wire form: `{ alg, v, nodeId, keyId, sig }`, sent as `nodeSignature` or `serverSignature`. */
export interface EvidenceSignature {
  alg: 'ed25519';
  v: 1;
  nodeId: string;
  keyId: string;
  /** Ed25519 signature, base64url (86 characters). */
  sig: string;
}

export type EvidenceFailure = 'MALFORMED' | 'NODE_MISMATCH' | 'KEY_MISMATCH' | 'SIGNATURE';

const KEY_ID = /^[a-f0-9]{64}$/;
const NODE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function signingInput(protocol: string, kind: string, nodeId: string, keyId: string, payload: string): string {
  if (!NODE_ID.test(nodeId)) throw new Error('Invalid evidence node id');
  if (!KEY_ID.test(keyId)) throw new Error('Invalid evidence key id');
  if (typeof payload !== 'string' || payload.length === 0) throw new Error('Invalid evidence payload');
  return [protocol, kind, nodeId, keyId, payload].join('\n');
}

/** The exact bytes a node evidence signature covers. */
export function nodeEvidenceSigningInput(kind: NodeEvidenceKind, nodeId: string, keyId: string, payload: string): string {
  if (!(NODE_EVIDENCE_KINDS as readonly string[]).includes(kind)) throw new Error('Unknown evidence kind');
  return signingInput(NODE_EVIDENCE_PROTOCOL, kind, nodeId, keyId, payload);
}

/** The exact bytes a server authorization signature covers. */
export function serverAuthorizationSigningInput(kind: ServerAuthorizationKind, nodeId: string, keyId: string, payload: string): string {
  if (!(SERVER_AUTHORIZATION_KINDS as readonly string[]).includes(kind)) throw new Error('Unknown authorization kind');
  return signingInput(SERVER_AUTHORIZATION_PROTOCOL, kind, nodeId, keyId, payload);
}

function signed(input: string, privateKey: KeyObject, nodeId: string, keyId: string): EvidenceSignature {
  return { alg: 'ed25519', v: 1, nodeId, keyId, sig: sign(null, Buffer.from(input, 'utf8'), privateKey).toString('base64url') };
}

/** Sign evidence with the node key. `nodeId` is the node the key is bound to. */
export function signNodeEvidence(privateKey: KeyObject, keyId: string, nodeId: string, kind: NodeEvidenceKind, payload: string): EvidenceSignature {
  return signed(nodeEvidenceSigningInput(kind, nodeId, keyId, payload), privateKey, nodeId, keyId);
}

/** Sign a decision for one node with the server key. `nodeId` is the node the decision is for. */
export function signServerAuthorization(privateKey: KeyObject, keyId: string, nodeId: string, kind: ServerAuthorizationKind, payload: string): EvidenceSignature {
  return signed(serverAuthorizationSigningInput(kind, nodeId, keyId, payload), privateKey, nodeId, keyId);
}

/**
 * Read a `nodeSignature` / `serverSignature` value. `null` means there is none (legacy evidence);
 * `'MALFORMED'` means there is something, but not a well-formed signature.
 */
export function readEvidenceSignature(value: unknown): EvidenceSignature | null | 'MALFORMED' {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'MALFORMED';
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).length !== 5 || entry['alg'] !== 'ed25519' || entry['v'] !== 1
    || typeof entry['nodeId'] !== 'string' || !NODE_ID.test(entry['nodeId'])
    || typeof entry['keyId'] !== 'string' || !KEY_ID.test(entry['keyId'])
    || typeof entry['sig'] !== 'string' || !SIGNATURE.test(entry['sig'])) return 'MALFORMED';
  return { alg: 'ed25519', v: 1, nodeId: entry['nodeId'], keyId: entry['keyId'], sig: entry['sig'] };
}

export interface VerifyEvidenceInput {
  signature: EvidenceSignature;
  /** SPKI base64 of the key the verifier holds for `signature.keyId`. */
  publicKey: string;
  /** The node the evidence must be bound to: the node that produced it, or the node a decision is for. */
  expectedNodeId: string;
  payload: string;
}

function verifySigned(input: VerifyEvidenceInput, build: (nodeId: string, keyId: string) => string): { ok: true } | { ok: false; reason: EvidenceFailure } {
  const { signature } = input;
  let key: KeyObject;
  try {
    if (!constantTimeEqualText(keyIdOfSpki(input.publicKey), signature.keyId)) return { ok: false, reason: 'KEY_MISMATCH' };
    key = publicKeyFromSpki(input.publicKey);
  } catch { return { ok: false, reason: 'KEY_MISMATCH' }; }
  if (!constantTimeEqualText(signature.nodeId, input.expectedNodeId)) return { ok: false, reason: 'NODE_MISMATCH' };
  let bytes: Buffer;
  let text: string;
  try {
    bytes = Buffer.from(signature.sig, 'base64url');
    text = build(signature.nodeId, signature.keyId);
  } catch { return { ok: false, reason: 'MALFORMED' }; }
  if (bytes.length !== 64) return { ok: false, reason: 'MALFORMED' };
  return verify(null, Buffer.from(text, 'utf8'), key, bytes) ? { ok: true } : { ok: false, reason: 'SIGNATURE' };
}

export function verifyNodeEvidence(kind: NodeEvidenceKind, input: VerifyEvidenceInput): { ok: true } | { ok: false; reason: EvidenceFailure } {
  return verifySigned(input, (nodeId, keyId) => nodeEvidenceSigningInput(kind, nodeId, keyId, input.payload));
}

export function verifyServerAuthorization(kind: ServerAuthorizationKind, input: VerifyEvidenceInput): { ok: true } | { ok: false; reason: EvidenceFailure } {
  return verifySigned(input, (nodeId, keyId) => serverAuthorizationSigningInput(kind, nodeId, keyId, input.payload));
}

// ── Canonical payloads. Each is the exact text the legacy HMAC covers, and what the envelope signs. ──

/** JSON with object keys sorted, recursively: the canonical form of drain and writer evidence. */
export function canonicalEvidenceJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalEvidenceJson).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => JSON.stringify(key) + ':' + canonicalEvidenceJson(item)).join(',') + '}';
  return JSON.stringify(value);
}

export interface CommandResultEvidence {
  commandId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  coordination?: { version: 1; resourceKey: string; fence: string; expiresAt: number; requestSha256: string } | undefined;
  completion?: { registryVersion: 1; registrySha256: string; descriptorId: string } | undefined;
}

export function commandResultSigningPayload(result: CommandResultEvidence): string {
  return JSON.stringify({
    version: result.completion ? 3 : result.coordination ? 2 : 1,
    commandId: result.commandId,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdoutSha256: sha256Hex(result.stdout),
    stderrSha256: sha256Hex(result.stderr),
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

export interface CommandRefusalEvidence {
  commandId: string; requestSha256: string; code: string; highWater: string | null; nodeFqdn: string; leaseId: string;
}

export function commandRefusalSigningPayload(refusal: CommandRefusalEvidence): string {
  return JSON.stringify({ domain: 'magnus.command-refusal.v1', commandId: refusal.commandId, requestSha256: refusal.requestSha256,
    code: refusal.code, highWater: refusal.highWater, nodeFqdn: refusal.nodeFqdn, leaseId: refusal.leaseId });
}

export interface CommandAbsenceEvidence {
  commandId: string; nodeFqdn: string; nonce: string; ledgerExists: boolean; receipt: boolean; activeLock: boolean;
  resourceKey: string; fenceHighWater: string | null; markerState: 'absent' | 'present' | 'unknown'; markerNodeId: string | null;
  admissionFailedFence: string | null;
}

export function commandAbsenceSigningPayload(absence: CommandAbsenceEvidence): string {
  return JSON.stringify({ domain: 'magnus.command-absence.v1', commandId: absence.commandId, nodeFqdn: absence.nodeFqdn, nonce: absence.nonce,
    ledgerExists: absence.ledgerExists, receipt: absence.receipt, activeLock: absence.activeLock, resourceKey: absence.resourceKey,
    fenceHighWater: absence.fenceHighWater, markerState: absence.markerState, markerNodeId: absence.markerNodeId, admissionFailedFence: absence.admissionFailedFence });
}

/** The fence high-water a preflight reports, bound to the node and a fresh nonce. */
export function fenceProofSigningPayload(proof: { nonce: string; nodeFqdn: string; fenceHighWater: Readonly<Record<string, string>> }): string {
  return JSON.stringify({ domain: 'magnus.fence-high-water.v1', nonce: proof.nonce, nodeFqdn: proof.nodeFqdn,
    fenceHighWater: Object.fromEntries(Object.entries(proof.fenceHighWater).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) });
}

export interface CommandReconciliationDecision {
  nodeFqdn: string; commandId: string; requestSha256: string;
  coordination?: { version: 1; resourceKey: string; fence: string; expiresAt: number } | undefined;
  disposition: 'effects_verified' | 'no_effect_verified'; evidenceSha256: string; approvalRef: string; decisionId: string; expiresAt: number;
}

/** A decision about an unknown command outcome. Never a node's evidence: only the server signs it. */
export function commandReconciliationSigningPayload(assertion: CommandReconciliationDecision): string {
  return JSON.stringify({
    domain: 'magnus.command-reconciliation.v1', nodeFqdn: assertion.nodeFqdn,
    commandId: assertion.commandId, requestSha256: assertion.requestSha256,
    coordination: assertion.coordination ? {
      version: assertion.coordination.version, resourceKey: assertion.coordination.resourceKey,
      fence: assertion.coordination.fence, expiresAt: assertion.coordination.expiresAt,
    } : null,
    disposition: assertion.disposition, evidenceSha256: assertion.evidenceSha256,
    approvalRef: assertion.approvalRef, decisionId: assertion.decisionId, expiresAt: assertion.expiresAt,
  });
}

export interface NodeSessionReceiptEvidence {
  version: 1; workId: string; nodeId: string; nodeFqdn: string; participant: string; ownerId: string; kind: string;
  operationSha256: string; requestSha256: string; fence: string; deadline: number; bootId: string; unit: string; invocationId: string;
  cgroup: string; startedAt: number; terminalAt: number; disposition: string; resultSha256: string; completionRegistrySha256: string;
  completionDescriptorId: string; groupEmpty: true; effectBoundary: string;
}

export function nodeSessionReceiptSigningPayload(value: NodeSessionReceiptEvidence): string {
  return JSON.stringify({ domain: 'magnus.node-session-terminal.v1', version: value.version, workId: value.workId,
    nodeId: value.nodeId, nodeFqdn: value.nodeFqdn, participant: value.participant, ownerId: value.ownerId, kind: value.kind,
    operationSha256: value.operationSha256, requestSha256: value.requestSha256, fence: value.fence, deadline: value.deadline,
    bootId: value.bootId, unit: value.unit, invocationId: value.invocationId, cgroup: value.cgroup,
    startedAt: value.startedAt, terminalAt: value.terminalAt, disposition: value.disposition,
    resultSha256: value.resultSha256, completionRegistrySha256: value.completionRegistrySha256,
    completionDescriptorId: value.completionDescriptorId, groupEmpty: value.groupEmpty, effectBoundary: value.effectBoundary });
}

/** An agent or scheduler drain receipt, without its signatures. */
export function enrollmentReceiptSigningPayload(unsigned: unknown): string {
  return 'magnus.resource-enrollment.v1\n' + canonicalEvidenceJson(unsigned);
}

export function hostLocalWriterSigningPayload(unsigned: unknown): string {
  return 'magnus.host-local-writer.v1\n' + canonicalEvidenceJson(unsigned);
}

export function osSchedulerWriterSigningPayload(unsigned: unknown): string {
  return 'magnus.os-scheduler-writer.v1\n' + canonicalEvidenceJson(unsigned);
}

export interface CronEnrollmentStageDecision {
  version: 1; nodeId: string; nodeFqdn: string; spec: unknown; operationId: string; expiresAt: number;
}

/** The server's instruction to stage one disabled scheduler definition during enrollment. */
export function cronEnrollmentStageSigningPayload(value: CronEnrollmentStageDecision): string {
  return JSON.stringify({ domain: 'magnus.cron-enrollment-stage.v1', version: value.version, nodeId: value.nodeId,
    nodeFqdn: value.nodeFqdn, specSha256: sha256Hex(JSON.stringify(value.spec)), operationId: value.operationId,
    expiresAt: value.expiresAt });
}

/** The node's receipt for a staged definition: its fields in the order the node sends them. */
export function cronEnrollmentStageReceiptPayload(value: object): string {
  return JSON.stringify({ domain: 'magnus.cron-enrollment-stage-receipt.v1', ...value });
}

/** The node's receipt for a settled foreign scheduler source: its fields in the order the node sends them. */
export function schedulerSourceSettlementReceiptPayload(value: object): string {
  return JSON.stringify({ domain: 'magnus.scheduler-source-reconciliation-receipt.v2', ...value });
}
