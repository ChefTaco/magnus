import * as jose from 'jose';

type IamVerificationKey = Awaited<ReturnType<typeof jose.importSPKI>>;

/** The longest lifetime (`exp - iat`) Magnus accepts on a Hive IAM access token. */
export const IAM_MAX_TOKEN_LIFETIME_SEC = 24 * 60 * 60;

/**
 * Verify the complete Hive IAM access-token contract. Signature-only checks
 * are insufficient because a valid token minted for another service must not
 * be replayable against Magnus.
 */
export async function verifyIamAccessToken(
  token: string,
  key: IamVerificationKey,
  issuer: string,
  audience: string,
): Promise<jose.JWTPayload> {
  if (!issuer || !audience) {
    throw new Error('IAM token issuer and audience must be configured');
  }

  const { payload } = await jose.jwtVerify(token, key, {
    algorithms: ['RS256'],
    issuer,
    audience,
    // A token without an expiry, or one minted to live for weeks, is refused outright.
    requiredClaims: ['exp', 'iat'],
    maxTokenAge: IAM_MAX_TOKEN_LIFETIME_SEC,
  });
  if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number'
    || payload.exp <= payload.iat || payload.exp - payload.iat > IAM_MAX_TOKEN_LIFETIME_SEC) {
    throw new Error('IAM access token lifetime is outside the accepted range');
  }

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new Error('IAM access token is missing subject');
  }

  return payload;
}
