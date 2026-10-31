import { generateKeyPairSync, sign } from 'node:crypto';
import { DEFAULT_APPROVAL_ASSERTION_DOMAIN, approvalSigningMessage, type ApprovalPayload } from './approval-assertion.js';

const keys = generateKeyPairSync('ed25519');

export const approvalSignerPublicKeyB64 = keys.publicKey
  .export({ format: 'der', type: 'spki' })
  .toString('base64');

export function signApprovalAssertion(payload: ApprovalPayload, domain = DEFAULT_APPROVAL_ASSERTION_DOMAIN) {
  return {
    payload,
    signature: sign(
      null,
      approvalSigningMessage(payload, domain),
      keys.privateKey,
    ).toString('base64url'),
  };
}
