import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createOathweaveServiceVerifier, createOathweaveVerifier, parseOathweaveLinks, uniqueOathweaveLink } from '../dist/index.js';

const ISSUER = 'https://identity.example.com';
const options = { issuer: ISSUER, jwksUrl: `${ISSUER}/jwks`, userinfoUrl: `${ISSUER}/userinfo`, audience: 'magnus' };
const { publicKey, privateKey } = await generateKeyPair('RS256');
const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'k', alg: 'RS256' }] });
const fetchUser = async () => Response.json({ sub: 'alice-subject' });
const verifier = () => createOathweaveVerifier(options, { keys, fetch: fetchUser });

function mint(claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ actorType: 'USER', sessionId: 'session', clientId: 'hivexui-magnus', roles: [], permissions: [], ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k' }).setIssuer(ISSUER).setAudience('magnus').setSubject('alice-subject')
    .setJti('jti').setIssuedAt(now).setExpirationTime(now + 600).sign(privateKey);
}

test('exposes a usable auth_time', async () => {
  const value = Math.floor(Date.now() / 1000) - 30;
  assert.equal((await verifier()(await mint({ auth_time: value }))).authTime, value);
});

for (const value of ['1700000000', 0, -1, 1.5, null, true]) {
  test(`treats auth_time ${JSON.stringify(value)} as unknown`, async () => {
    assert.equal((await verifier()(await mint({ auth_time: value }))).authTime, undefined);
  });
}

test('an absent auth_time is unknown', async () => {
  assert.equal((await verifier()(await mint())).authTime, undefined);
});

test('rejects a service actor', async () => {
  await assert.rejects(verifier()(await mint({ actorType: 'SERVICE_ACCOUNT' })), /Invalid resource identity/);
});

test('a revoked session fails verification', async () => {
  const revoked = createOathweaveVerifier(options, { keys, fetch: async () => new Response('', { status: 401 }) });
  await assert.rejects(revoked(await mint()), /inactive/);
});

test('refuses plain HTTP identity endpoints', () => {
  assert.throws(() => createOathweaveVerifier({ ...options, jwksUrl: 'http://identity.example.com/jwks' }), /verified HTTPS/);
});

test('a duplicate identity link grants nothing', () => {
  const link = { issuer: ISSUER, subject: 's', localUserId: 'alice', role: 'ADMIN' };
  assert.equal(uniqueOathweaveLink(parseOathweaveLinks(JSON.stringify([link])), ISSUER, 's')?.role, 'ADMIN');
  assert.equal(uniqueOathweaveLink(parseOathweaveLinks(JSON.stringify([link, link])), ISSUER, 's'), undefined);
  assert.equal(uniqueOathweaveLink([link], ISSUER, 'other'), undefined);
});

test('a link may not name a system actor', () => {
  assert.throws(() => parseOathweaveLinks(JSON.stringify([{ issuer: ISSUER, subject: 's', localUserId: 'system', role: 'ADMIN' }])));
});

function mintService(claims = {}, subject = 'ardent-studio') {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ actorType: 'SERVICE_ACCOUNT', token_type: 'access', clientId: subject, permissions: ['magnus:ardent'], ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k' }).setIssuer(ISSUER).setAudience('magnus').setSubject(subject)
    .setJti('service-jti').setIssuedAt(now).setExpirationTime(now + 300).sign(privateKey);
}
const serviceVerifier = () => createOathweaveServiceVerifier({ issuer: ISSUER, jwksUrl: `${ISSUER}/jwks`, audience: 'magnus' }, { keys });

test('accepts a client-credentials token for its own client', async () => {
  const identity = await serviceVerifier()(await mintService());
  assert.equal(identity.clientId, 'ardent-studio');
  assert.deepEqual(identity.permissions, ['magnus:ardent']);
});

for (const [name, claims] of [
  ['a person', { actorType: 'USER' }],
  ['a session', { sessionId: 'session' }],
  ['another client', { clientId: 'other-client' }],
  ['a refresh token', { token_type: 'refresh' }],
  ['no permissions', { permissions: 'magnus:ardent' }],
]) {
  test(`rejects a service token with ${name}`, async () => {
    await assert.rejects(serviceVerifier()(await mintService(claims)), /Invalid service identity/);
  });
}

test('the person verifier still refuses service tokens, and a service link role parses', async () => {
  await assert.rejects(verifier()(await mintService()), /Invalid resource identity/);
  const link = { issuer: ISSUER, subject: 'ardent-studio', localUserId: 'ardent-studio', role: 'ARDENT_SERVICE' };
  assert.equal(parseOathweaveLinks(JSON.stringify([link]))[0].role, 'ARDENT_SERVICE');
});
