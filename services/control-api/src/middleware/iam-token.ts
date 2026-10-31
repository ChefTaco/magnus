import * as jose from 'jose';

type IamVerificationKey = Awaited<ReturnType<typeof jose.importSPKI>>;

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
  });

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new Error('IAM access token is missing subject');
  }

  return payload;
}
