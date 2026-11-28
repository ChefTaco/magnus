import * as jose from 'jose';

type IamVerificationKey = Awaited<ReturnType<typeof jose.importSPKI>>;

/** The longest lifetime (`exp - iat`) Magnus accepts on a Hive IAM access token. */
export const IAM_MAX_TOKEN_LIFETIME_SEC = 24 * 60 * 60;

/**
 * Verify the complete Hive IAM access-token contract. Signature-only checks
 * are insufficient because a valid token minted for another service must not
 * be replayable against Magnus.
 *
 * Deprecated (2026-11-28): the external Hive IAM mode (`IAM_CORE_URL`) is retired in favour of
 * Oathweave mode (`OATHWEAVE_ISSUER`, `middleware/oathweave-verifier.ts`) and is removed in the
 * next major release (4.0.0). HiveCommon's `createOathweaveVerifier()` does not fit it (it needs an
 * https issuer and Oathweave's claim contract), so this verifier stays, with the same strict
 * checks: RS256 only, exact issuer, exactly one audience equal to Magnus's, `sub`, `jti`, `iat` and
 * `exp` present, and a bounded lifetime.
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
    requiredClaims: ['exp', 'iat', 'jti'],
    maxTokenAge: IAM_MAX_TOKEN_LIFETIME_SEC,
  });
  if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number'
    || payload.exp <= payload.iat || payload.exp - payload.iat > IAM_MAX_TOKEN_LIFETIME_SEC) {
    throw new Error('IAM access token lifetime is outside the accepted range');
  }

  // jose accepts an audience array that contains ours; the issuer mints exactly one audience.
  if (payload.aud !== audience) {
    throw new Error('IAM access token audience must be exactly the configured audience');
  }

  if (typeof payload.jti !== 'string' || payload.jti.length === 0) {
    throw new Error('IAM access token is missing jti');
  }

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new Error('IAM access token is missing subject');
  }

  return payload;
}
