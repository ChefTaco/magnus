/**
 * Evidence this server records about itself and checks again later (docs/NODE_CREDENTIALS.md,
 * "Signed evidence"): the console drain finding it writes when no console participant exists
 * (`RESOURCE_ENROLLMENT_DASHBOARD_PARTICIPANT=absent`). Up to 3.0.1 it was an HMAC with the shared
 * `RESULT_SIGNING_SECRET`; from 3.0.2 it is signed with the server's own Ed25519 key over
 *
 *   magnus.server-own-evidence.v1 \n kind \n nodeId \n keyId \n payload
 *
 * Its own protocol line keeps it apart from node evidence and from the decisions the server sends
 * to agents, so it can never pass as either. The key id is inside the signed bytes and stored with
 * the signature, and the server keeps the public part of every key it retired, so stored evidence
 * keeps verifying across a server-key rotation.
 */
import { sign, verify } from 'node:crypto';
import { constantTimeEqualText, keyIdOfSpki, publicKeyFromSpki } from '../security/node-request-auth.js';
import { readEvidenceSignature, type EvidenceSignature } from '../security/node-evidence.js';
import { serverSigningKey, serverVerificationKeys } from './node-server-key.js';
import { HttpError } from '../middleware/error-handler.js';

export const SERVER_OWN_EVIDENCE_PROTOCOL = 'magnus.server-own-evidence.v1';
export const SERVER_OWN_EVIDENCE_KINDS = ['console-drain-receipt'] as const;
export type ServerOwnEvidenceKind = typeof SERVER_OWN_EVIDENCE_KINDS[number];

const NODE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const KEY_ID = /^[a-f0-9]{64}$/;

/** The exact bytes a server-own evidence signature covers. */
export function serverOwnEvidenceSigningInput(kind: ServerOwnEvidenceKind, nodeId: string, keyId: string, payload: string): string {
  if (!(SERVER_OWN_EVIDENCE_KINDS as readonly string[]).includes(kind)) throw new Error('Unknown server evidence kind');
  if (!NODE_ID.test(nodeId)) throw new Error('Invalid evidence node id');
  if (!KEY_ID.test(keyId)) throw new Error('Invalid evidence key id');
  if (typeof payload !== 'string' || payload.length === 0) throw new Error('Invalid evidence payload');
  return [SERVER_OWN_EVIDENCE_PROTOCOL, kind, nodeId, keyId, payload].join('\n');
}

/** Sign evidence about `nodeId` with the active server key; 503 SERVER_KEY_UNAVAILABLE when it cannot be read. */
export function signServerOwnEvidence(kind: ServerOwnEvidenceKind, nodeId: string, payload: string): EvidenceSignature {
  let key: ReturnType<typeof serverSigningKey>;
  try { key = serverSigningKey(); }
  catch (error) {
    console.warn(`[server-own-evidence] the server signing key cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    throw new HttpError(503, 'SERVER_KEY_UNAVAILABLE', 'The server signing key cannot be read');
  }
  const input = serverOwnEvidenceSigningInput(kind, nodeId, key.keyId, payload);
  return { alg: 'ed25519', v: 1, nodeId, keyId: key.keyId, sig: sign(null, Buffer.from(input, 'utf8'), key.privateKey).toString('base64url') };
}

/**
 * Whether `value` is this server's signature of `payload` about `nodeId`, by any key it holds or
 * held: the active one, a staged or replaced one, or one retired since.
 */
export function verifyServerOwnEvidence(kind: ServerOwnEvidenceKind, nodeId: string, payload: string, value: unknown): boolean {
  const signature = readEvidenceSignature(value);
  if (!signature || signature === 'MALFORMED' || !constantTimeEqualText(signature.nodeId, nodeId)) return false;
  let keys: ReturnType<typeof serverVerificationKeys>;
  try { keys = serverVerificationKeys(); } catch { return false; }
  const key = keys.find(entry => entry.keyId === signature.keyId);
  if (!key) return false;
  try {
    if (!constantTimeEqualText(keyIdOfSpki(key.publicKey), signature.keyId)) return false;
    const bytes = Buffer.from(signature.sig, 'base64url');
    if (bytes.length !== 64) return false;
    return verify(null, Buffer.from(serverOwnEvidenceSigningInput(kind, nodeId, signature.keyId, payload), 'utf8'),
      publicKeyFromSpki(key.publicKey), bytes);
  } catch { return false; }
}
