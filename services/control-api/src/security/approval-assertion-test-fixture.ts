import { generateKeyPairSync, sign } from 'node:crypto';
import { approvalPayloadCanonical, type ApprovalPayload } from './approval-assertion.js';

const keys = generateKeyPairSync('ed25519');

export const approvalSignerPublicKeyB64 = keys.publicKey
  .export({ format: 'der', type: 'spki' })
  .toString('base64');

export function signApprovalAssertion(payload: ApprovalPayload) {
  return {
    payload,
    signature: sign(
      null,
      Buffer.from(`magnus.approval-assertion.v${payload.version}\n` + approvalPayloadCanonical(payload)),
      keys.privateKey,
    ).toString('base64url'),
  };
}
