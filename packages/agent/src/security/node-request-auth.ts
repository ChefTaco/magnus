/**
 * Per-node request signatures (Ed25519): the wire contract between magnus-server and magnus-agent.
 *
 * This file is kept byte-identical in `services/control-api/src/security` and
 * `packages/agent/src/security`; a test in each package compares the two copies and runs the same
 * vectors (`node-request-auth.vectors.json`). It uses `node:crypto` only and reads no environment.
 *
 * A signed request carries five headers. The signature covers
 *
 *   magnus.node-request.v1 \n METHOD \n path?query \n audience \n nodeId \n timestamp \n nonce \n sha256(body)
 *
 * Agent to server: signed with the node key; the audience names the server key the agent pinned
 * (`server:<keyId>`), so a request made for one control plane is not valid on another.
 * Server to agent: signed with the server key; the audience names the node (`node:<nodeId>`), so a
 * request captured for one node is not valid on another.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual, verify,
  type KeyObject } from 'node:crypto';

export const NODE_REQUEST_PROTOCOL = 'magnus.node-request.v1';
export const NODE_ENROLLMENT_PROTOCOL = 'magnus.node-enrollment.v1';
export const NODE_AUTH_HEADERS = {
  nodeId: 'x-magnus-node-id',
  keyId: 'x-magnus-key-id',
  timestamp: 'x-magnus-timestamp',
  nonce: 'x-magnus-nonce',
  signature: 'x-magnus-signature',
} as const;
/** A request is accepted only this close to the verifier's clock. */
export const NODE_AUTH_MAX_SKEW_MS = 60_000;
/** A nonce is remembered this long: twice the skew, so a replay inside the window is always seen. */
export const NODE_AUTH_NONCE_TTL_MS = 120_000;

const KEY_ID = /^[a-f0-9]{64}$/;
const NODE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const TIMESTAMP = /^[1-9][0-9]{12,13}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SPKI_BASE64 = /^[A-Za-z0-9+/]{59}=$/;
// DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 key bytes follow.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export type NodeAuthFailure =
  | 'MALFORMED' | 'SKEW' | 'SIGNATURE' | 'NODE_MISMATCH' | 'KEY_MISMATCH';

export interface NodeAuthHeaderValues {
  nodeId: string;
  keyId: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

export interface NodeRequestIdentity {
  method: string;
  /** `pathname + search` exactly as sent, e.g. `/api/v1/heartbeat` or `/api/v1/files?path=%2Fetc`. */
  pathWithQuery: string;
  audience: string;
  nodeId: string;
  timestamp: string;
  nonce: string;
  bodySha256: string;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Constant-time comparison of two strings of any length. */
export function constantTimeEqualText(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

export const serverAudience = (serverKeyId: string): string => `server:${serverKeyId}`;
export const nodeAudience = (nodeId: string): string => `node:${nodeId}`;

/** Parse a base64 SPKI DER Ed25519 public key. Throws on any other key type or encoding. */
export function publicKeyFromSpki(spkiBase64: string): KeyObject {
  if (!SPKI_BASE64.test(spkiBase64)) throw new Error('Public key must be a base64 Ed25519 SPKI');
  const der = Buffer.from(spkiBase64, 'base64');
  if (der.length !== 44 || !der.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) throw new Error('Public key must be Ed25519');
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Public key must be Ed25519');
  return key;
}

export function spkiOf(key: KeyObject): string {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key;
  return (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64');
}

/** The key id is the SHA-256 of the SPKI DER, lowercase hex. */
export function keyIdOfSpki(spkiBase64: string): string {
  publicKeyFromSpki(spkiBase64);
  return sha256Hex(Buffer.from(spkiBase64, 'base64'));
}

/** A short form for people to compare: the first 16 hex characters in groups of four. */
export function keyFingerprint(keyId: string): string {
  return (keyId.slice(0, 16).match(/.{4}/g) ?? []).join(':');
}

export function privateKeyFromPem(pem: string): KeyObject {
  const key = createPrivateKey({ key: pem, format: 'pem' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Private key must be Ed25519');
  return key;
}

export function generateSigningKey(): { privateKeyPem: string; publicKey: string; keyId: string } {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = spkiOf(pair.publicKey);
  return { privateKeyPem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string, publicKey, keyId: keyIdOfSpki(publicKey) };
}

export function newNonce(): string {
  return randomBytes(18).toString('base64url');
}

function field(name: string, value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\r\n\0]/.test(value))
    throw new Error(`Invalid signed field: ${name}`);
  return value;
}

export function canonicalNodeRequest(input: NodeRequestIdentity): string {
  if (!SHA256.test(input.bodySha256)) throw new Error('Invalid signed field: bodySha256');
  const path = field('pathWithQuery', input.pathWithQuery);
  if (!path.startsWith('/')) throw new Error('Invalid signed field: pathWithQuery');
  return [NODE_REQUEST_PROTOCOL, field('method', input.method).toUpperCase(), path, field('audience', input.audience),
    field('nodeId', input.nodeId), field('timestamp', input.timestamp), field('nonce', input.nonce), input.bodySha256].join('\n');
}

/** `pathname + search` of a request URL: what both sides sign. */
export function pathWithQueryOf(url: string | URL): string {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  return parsed.pathname + parsed.search;
}

export interface SignNodeRequestInput {
  privateKey: KeyObject;
  keyId: string;
  nodeId: string;
  audience: string;
  method: string;
  pathWithQuery: string;
  /** The exact bytes sent as the request body; empty for none. */
  body: string | Uint8Array;
  now?: number;
  nonce?: string;
}

export function signNodeRequest(input: SignNodeRequestInput): Record<string, string> {
  const timestamp = String(Math.trunc(input.now ?? Date.now()));
  const nonce = input.nonce ?? newNonce();
  const canonical = canonicalNodeRequest({ method: input.method, pathWithQuery: input.pathWithQuery, audience: input.audience,
    nodeId: input.nodeId, timestamp, nonce, bodySha256: sha256Hex(input.body) });
  return {
    [NODE_AUTH_HEADERS.nodeId]: input.nodeId,
    [NODE_AUTH_HEADERS.keyId]: input.keyId,
    [NODE_AUTH_HEADERS.timestamp]: timestamp,
    [NODE_AUTH_HEADERS.nonce]: nonce,
    [NODE_AUTH_HEADERS.signature]: sign(null, Buffer.from(canonical, 'utf8'), input.privateKey).toString('base64url'),
  };
}

/**
 * Read the signature headers. `null` means the request carries none of them (not a signed
 * request); `'MALFORMED'` means it carries some, but not a complete well-formed set.
 */
export function readNodeAuthHeaders(get: (name: string) => string | undefined | null): NodeAuthHeaderValues | null | 'MALFORMED' {
  const values = {
    nodeId: get(NODE_AUTH_HEADERS.nodeId) ?? '', keyId: get(NODE_AUTH_HEADERS.keyId) ?? '',
    timestamp: get(NODE_AUTH_HEADERS.timestamp) ?? '', nonce: get(NODE_AUTH_HEADERS.nonce) ?? '',
    signature: get(NODE_AUTH_HEADERS.signature) ?? '',
  };
  if (Object.values(values).every(value => value === '')) return null;
  if (!NODE_ID.test(values.nodeId) || !KEY_ID.test(values.keyId) || !TIMESTAMP.test(values.timestamp)
    || !NONCE.test(values.nonce) || !SIGNATURE.test(values.signature)) return 'MALFORMED';
  return values;
}

export interface VerifyNodeRequestInput {
  headers: NodeAuthHeaderValues;
  /** SPKI base64 of the key the verifier holds for `headers.keyId`. */
  publicKey: string;
  /** The node the verifier expects in `x-magnus-node-id` (the key's node, or the verifier's own id). */
  expectedNodeId: string;
  /** Every audience the verifier answers to; the signature must have been made for one of them. */
  audiences: readonly string[];
  method: string;
  pathWithQuery: string;
  body: string | Uint8Array;
  now?: number;
}

/**
 * Check a signed request against a key the verifier already trusts. Replay protection is separate:
 * call {@link NonceCache.claim} after this returns `ok`.
 */
export function verifyNodeRequest(input: VerifyNodeRequestInput): { ok: true } | { ok: false; reason: NodeAuthFailure } {
  const { headers } = input;
  let key: KeyObject;
  try {
    if (!constantTimeEqualText(keyIdOfSpki(input.publicKey), headers.keyId)) return { ok: false, reason: 'KEY_MISMATCH' };
    key = publicKeyFromSpki(input.publicKey);
  } catch { return { ok: false, reason: 'KEY_MISMATCH' }; }
  if (!constantTimeEqualText(headers.nodeId, input.expectedNodeId)) return { ok: false, reason: 'NODE_MISMATCH' };
  const now = input.now ?? Date.now();
  if (Math.abs(now - Number(headers.timestamp)) > NODE_AUTH_MAX_SKEW_MS) return { ok: false, reason: 'SKEW' };
  let signature: Buffer;
  let bodySha256: string;
  try {
    signature = Buffer.from(headers.signature, 'base64url');
    bodySha256 = sha256Hex(input.body);
  } catch { return { ok: false, reason: 'MALFORMED' }; }
  if (signature.length !== 64) return { ok: false, reason: 'MALFORMED' };
  let valid = false;
  for (const audience of input.audiences) {
    let canonical: string;
    try {
      canonical = canonicalNodeRequest({ method: input.method, pathWithQuery: input.pathWithQuery, audience,
        nodeId: headers.nodeId, timestamp: headers.timestamp, nonce: headers.nonce, bodySha256 });
    } catch { return { ok: false, reason: 'MALFORMED' }; }
    // No early exit: every audience is tried, so timing does not tell which one matched.
    if (verify(null, Buffer.from(canonical, 'utf8'), key, signature)) valid = true;
  }
  return valid ? { ok: true } : { ok: false, reason: 'SIGNATURE' };
}

/** In-process replay cache: a (key, nonce) pair is accepted once inside the TTL. */
export class NonceCache {
  private readonly seen = new Map<string, number>();
  private lastSweep = 0;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  constructor(ttlMs = NODE_AUTH_NONCE_TTL_MS, maxEntries = 200_000) { this.ttlMs = ttlMs; this.maxEntries = maxEntries; }

  /** True when this pair is new (and now remembered); false for a replay or a full cache. */
  claim(keyId: string, nonce: string, now = Date.now()): boolean {
    if (now - this.lastSweep > 10_000 || this.seen.size >= this.maxEntries) this.sweep(now);
    const id = `${keyId}:${nonce}`;
    const expires = this.seen.get(id);
    if (expires !== undefined && expires > now) return false;
    // Fail closed: when the cache is full of live entries a new request is refused, never forgotten.
    if (this.seen.size >= this.maxEntries) return false;
    this.seen.set(id, now + this.ttlMs);
    return true;
  }

  private sweep(now: number): void {
    this.lastSweep = now;
    for (const [id, expires] of this.seen) if (expires <= now) this.seen.delete(id);
  }

  get size(): number { return this.seen.size; }
}

export type EnrollmentPurpose = 'enroll' | 'legacy-upgrade' | 'rotate';

export interface EnrollmentProofInput {
  purpose: EnrollmentPurpose;
  /** SPKI base64 of the key being bound; the proof is signed with its private key. */
  publicKey: string;
  /** The FQDN the agent reports for itself. */
  fqdn: string;
  /**
   * What the proof is tied to: the SHA-256 of the enrollment token (`enroll`), the node id
   * (`rotate`), or `-` (`legacy-upgrade`, which is tied to the node by the server).
   */
  binding: string;
  timestamp: string;
  nonce: string;
}

export function enrollmentProofPayload(input: EnrollmentProofInput): string {
  if (!TIMESTAMP.test(input.timestamp) || !NONCE.test(input.nonce)) throw new Error('Invalid enrollment proof');
  return [NODE_ENROLLMENT_PROTOCOL, field('purpose', input.purpose), keyIdOfSpki(input.publicKey), field('fqdn', input.fqdn.toLowerCase()),
    field('binding', input.binding), input.timestamp, input.nonce].join('\n');
}

/** Proof of possession: the holder of the private key signs what it asks the server to bind. */
export function signEnrollmentProof(privateKey: KeyObject, input: Omit<EnrollmentProofInput, 'timestamp' | 'nonce'>,
  now = Date.now(), nonce = newNonce()): { timestamp: string; nonce: string; signature: string } {
  const timestamp = String(Math.trunc(now));
  const payload = enrollmentProofPayload({ ...input, timestamp, nonce });
  return { timestamp, nonce, signature: sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64url') };
}

export function verifyEnrollmentProof(input: EnrollmentProofInput & { signature: string }, now = Date.now()):
  { ok: true } | { ok: false; reason: 'MALFORMED' | 'SKEW' | 'SIGNATURE' } {
  let payload: string;
  let key: KeyObject;
  try {
    if (!SIGNATURE.test(input.signature)) return { ok: false, reason: 'MALFORMED' };
    payload = enrollmentProofPayload(input);
    key = publicKeyFromSpki(input.publicKey);
  } catch { return { ok: false, reason: 'MALFORMED' }; }
  if (Math.abs(now - Number(input.timestamp)) > NODE_AUTH_MAX_SKEW_MS) return { ok: false, reason: 'SKEW' };
  return verify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(input.signature, 'base64url'))
    ? { ok: true } : { ok: false, reason: 'SIGNATURE' };
}
