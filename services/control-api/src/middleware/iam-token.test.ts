import { beforeAll, describe, expect, it } from 'vitest';
import * as jose from 'jose';
import { verifyIamAccessToken } from './iam-token.js';

const issuer = 'hive-iam';
const audience = 'magnus';
let publicKey: Awaited<ReturnType<typeof jose.generateKeyPair>>['publicKey'];
let privateKey: Awaited<ReturnType<typeof jose.generateKeyPair>>['privateKey'];

beforeAll(async () => {
  ({ publicKey, privateKey } = await jose.generateKeyPair('RS256'));
});

async function sign(overrides: {
  issuer?: string;
  audience?: string;
  subject?: string | null;
  algorithm?: 'RS256' | 'PS256';
  expiresIn?: string | null;
  issuedAt?: number | null;
  jti?: string | null;
  audiences?: string[];
} = {}): Promise<string> {
  const algorithm = overrides.algorithm ?? 'RS256';
  let jwt = new jose.SignJWT({ roles: ['VIEWER'] })
    .setProtectedHeader({ alg: algorithm })
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audiences ?? overrides.audience ?? audience);
  if (overrides.jti !== null) jwt = jwt.setJti(overrides.jti ?? 'fixture-jti');
  if (overrides.issuedAt !== null) jwt = jwt.setIssuedAt(overrides.issuedAt);
  if (overrides.expiresIn !== null) jwt = jwt.setExpirationTime(overrides.expiresIn ?? '5m');
  if (overrides.subject !== null) jwt = jwt.setSubject(overrides.subject ?? 'user-1');
  return jwt.sign(privateKey);
}

describe('verifyIamAccessToken', () => {
  it('accepts an RS256 token with the exact issuer, audience, and subject', async () => {
    const payload = await verifyIamAccessToken(
      await sign(),
      publicKey,
      issuer,
      audience,
    );
    expect(payload.sub).toBe('user-1');
  });

  it('rejects a token issued for another service', async () => {
    await expect(verifyIamAccessToken(
      await sign({ audience: 'collector' }),
      publicKey,
      issuer,
      audience,
    )).rejects.toThrow();
  });

  it('rejects a token whose audience list merely contains Magnus', async () => {
    await expect(verifyIamAccessToken(await sign({ audiences: [audience, 'collector'] }), publicKey, issuer, audience)).rejects.toThrow(/exactly/);
    await expect(verifyIamAccessToken(await sign({ audiences: [audience] }), publicKey, issuer, audience)).rejects.toThrow(/exactly/);
  });

  it('rejects a token without a jti', async () => {
    await expect(verifyIamAccessToken(await sign({ jti: null }), publicKey, issuer, audience)).rejects.toThrow(/jti/);
  });

  it('rejects a token from another issuer', async () => {
    await expect(verifyIamAccessToken(
      await sign({ issuer: 'not-hive' }),
      publicKey,
      issuer,
      audience,
    )).rejects.toThrow();
  });

  it('rejects a token without an expiry or an issue time', async () => {
    await expect(verifyIamAccessToken(await sign({ expiresIn: null }), publicKey, issuer, audience)).rejects.toThrow(/exp/);
    await expect(verifyIamAccessToken(await sign({ issuedAt: null }), publicKey, issuer, audience)).rejects.toThrow(/iat/);
  });

  it('rejects a token minted to live longer than a day', async () => {
    await expect(verifyIamAccessToken(await sign({ expiresIn: '30d' }), publicKey, issuer, audience)).rejects.toThrow(/lifetime/);
    await expect(verifyIamAccessToken(await sign({ expiresIn: '23h' }), publicKey, issuer, audience)).resolves.toMatchObject({ sub: 'user-1' });
  });

  it('rejects a token without a subject', async () => {
    await expect(verifyIamAccessToken(
      await sign({ subject: null }),
      publicKey,
      issuer,
      audience,
    )).rejects.toThrow(/missing subject/);
  });

  it('rejects a signed token using an unapproved algorithm', async () => {
    const keys = await jose.generateKeyPair('PS256');
    const token = await new jose.SignJWT({ roles: ['VIEWER'] })
      .setProtectedHeader({ alg: 'PS256' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject('user-1')
      .setJti('fixture-jti')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(keys.privateKey);
    await expect(verifyIamAccessToken(
      token,
      keys.publicKey,
      issuer,
      audience,
    )).rejects.toThrow();
  });

  it('rejects IAM mode with an incomplete claim contract', async () => {
    await expect(verifyIamAccessToken(
      await sign(),
      publicKey,
      '',
      audience,
    )).rejects.toThrow(/must be configured/);
  });
});
