import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { runOathweaveConformance } from '@hivemagnus/hive-common/oathweave/conformance';
import {
  createOathweaveServiceVerifier, createOathweaveVerifier, hasOathweavePermission, isOathweaveEndpoint, parseOathweaveLinks, uniqueOathweaveLink,
} from '../dist/index.js';

const ISSUER = 'https://identity.example.com';
const options = { issuer: ISSUER, jwksUrl: `${ISSUER}/jwks`, userinfoUrl: `${ISSUER}/userinfo`, audience: 'magnus' };
const { publicKey, privateKey } = await generateKeyPair('RS256');
const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'k', alg: 'RS256' }] });
const fetchUser = async () => Response.json({ sub: 'alice-subject' });
const verifier = (overrides = {}) => createOathweaveVerifier(options, { keys, fetch: fetchUser, ...overrides });
/** Every refusal is an OathweaveError with a stable reason. */
const refused = (reason) => (error) => error?.name === 'OathweaveError' && error.reason === reason;

function mint(claims = {}, { issuedAt = Math.floor(Date.now() / 1000), lifetime = 600 } = {}) {
  const payload = { actorType: 'USER', sessionId: 'session', clientId: 'hivexui-magnus', roles: [], permissions: [], ...claims };
  for (const [key, value] of Object.entries(payload)) if (value === undefined) delete payload[key];
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'k' }).setIssuer(ISSUER).setAudience('magnus').setSubject('alice-subject')
    .setJti('jti').setIssuedAt(issuedAt).setExpirationTime(issuedAt + lifetime).sign(privateKey);
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
  await assert.rejects(verifier()(await mint({ actorType: 'SERVICE_ACCOUNT' })), refused('invalid_claims'));
});

test('allows no clock skew: a token expired one second ago is refused', async () => {
  const now = Math.floor(Date.now() / 1000);
  await assert.rejects(verifier()(await mint({}, { issuedAt: now - 601, lifetime: 600 })), refused('expired'));
});

test('allows no clock skew: a token issued one second ahead is refused', async () => {
  const now = Math.floor(Date.now() / 1000);
  await assert.rejects(verifier()(await mint({}, { issuedAt: now + 1, lifetime: 600 })), refused('not_yet_valid'));
});

test('refuses a token living longer than fifteen minutes', async () => {
  await assert.rejects(verifier()(await mint({}, { lifetime: 901 })), refused('invalid_lifetime'));
});

test('requires the roles claim', async () => {
  await assert.rejects(verifier()(await mint({ roles: undefined })), refused('invalid_claims'));
  await assert.rejects(verifier()(await mint({ roles: 'ADMIN' })), refused('invalid_claims'));
});

test('takes the client from clientId only', async () => {
  await assert.rejects(verifier()(await mint({ clientId: undefined, client_id: 'hivexui-magnus' })), refused('invalid_claims'));
});

test('returns the identity Magnus maps through its links', async () => {
  const identity = await verifier({ fetch: async () => Response.json({ sub: 'alice-subject', name: 'Alice' }) })(
    await mint({ roles: ['OPERATOR'], permissions: ['magnus:view'] }));
  assert.equal(identity.subject, 'alice-subject');
  assert.equal(identity.issuer, ISSUER);
  assert.equal(identity.sessionId, 'session');
  assert.equal(identity.displayName, 'Alice');
  assert.deepEqual(identity.roles, ['OPERATOR']);
  assert.deepEqual(identity.permissions, ['magnus:view']);
});

test('shares one session check per token for ten seconds', async () => {
  let calls = 0;
  let clock = Date.now();
  const check = verifier({ fetch: async () => { calls += 1; return fetchUser(); }, now: () => clock });
  const token = await mint();
  await check(token);
  await check(token);
  assert.equal(calls, 1);
  clock += 10_000;
  await check(token);
  assert.equal(calls, 2);
});

test('a revoked session fails verification', async () => {
  const revoked = createOathweaveVerifier(options, { keys, fetch: async () => new Response('', { status: 401 }) });
  await assert.rejects(revoked(await mint()), refused('session_inactive'));
});

test('a userinfo answer for another subject fails verification', async () => {
  const other = createOathweaveVerifier(options, { keys, fetch: async () => Response.json({ sub: 'mallory-subject' }) });
  await assert.rejects(other(await mint()), refused('subject_mismatch'));
});

test('refuses plain HTTP identity endpoints', () => {
  assert.throws(() => createOathweaveVerifier({ ...options, jwksUrl: 'http://identity.example.com/jwks' }), /verified HTTPS/);
  assert.throws(() => createOathweaveServiceVerifier({ ...options, issuer: 'http://identity.example.com' }), /verified HTTPS/);
  assert.equal(isOathweaveEndpoint('https://user:secret@identity.example.com'), false);
  assert.equal(isOathweaveEndpoint('https://identity.example.com/#fragment'), false);
  assert.equal(isOathweaveEndpoint('https://identity.example.com/jwks'), true);
});

test('permissions match exactly, without wildcards', () => {
  assert.equal(hasOathweavePermission({ permissions: ['magnus:terminal'] }, 'magnus:terminal'), true);
  assert.equal(hasOathweavePermission({ permissions: ['magnus:*', '*'] }, 'magnus:terminal'), false);
});

test('a duplicate identity link grants nothing', () => {
  const link = { issuer: ISSUER, subject: 's', localUserId: 'alice', role: 'ADMIN' };
  assert.equal(uniqueOathweaveLink(parseOathweaveLinks(JSON.stringify([link])), ISSUER, 's')?.role, 'ADMIN');
  assert.equal(uniqueOathweaveLink(parseOathweaveLinks(JSON.stringify([link, link])), ISSUER, 's'), undefined);
  assert.equal(uniqueOathweaveLink([link], ISSUER, 'other'), undefined);
});

test('a link may not name a system actor', () => {
  assert.throws(() => parseOathweaveLinks(JSON.stringify([{ issuer: ISSUER, subject: 's', localUserId: 'system', role: 'ADMIN' }])));
  assert.throws(() => parseOathweaveLinks(JSON.stringify([{ issuer: ISSUER, subject: 's', localUserId: 'service:x', role: 'ADMIN' }])));
});

test('links keep their four-field contract and a free-form local actor label', () => {
  const link = { issuer: ISSUER, subject: 's', localUserId: 'Alice Example+ops', role: 'VIEWER' };
  assert.equal(parseOathweaveLinks(JSON.stringify([link]))[0].localUserId, 'Alice Example+ops');
  assert.throws(() => parseOathweaveLinks(JSON.stringify([{ ...link, permissions: ['magnus:view'] }])));
  assert.throws(() => parseOathweaveLinks(JSON.stringify([{ ...link, role: 'OWNER' }])));
  assert.throws(() => parseOathweaveLinks(JSON.stringify([{ ...link, role: undefined }])));
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
    await assert.rejects(serviceVerifier()(await mintService(claims)), (error) => error?.name === 'OathweaveError' && error.status === 401);
  });
}

test('the person verifier still refuses service tokens, and a service link role parses', async () => {
  await assert.rejects(verifier()(await mintService({ roles: [] })), refused('wrong_principal_kind'));
  const link = { issuer: ISSUER, subject: 'ardent-studio', localUserId: 'ardent-studio', role: 'ARDENT_SERVICE' };
  assert.equal(parseOathweaveLinks(JSON.stringify([link]))[0].role, 'ARDENT_SERVICE');
});

test('a service token needs no roles claim', async () => {
  assert.equal((await serviceVerifier()(await mintService())).tokenId, 'service-jti');
});

test('meets the Oathweave conformance vectors', async () => {
  const verify = (token, ctx) => {
    const settings = { issuer: ctx.issuer, jwksUrl: ctx.jwksUrl, userinfoUrl: ctx.userinfoUrl, audience: ctx.audience };
    const overrides = { fetch: ctx.fetch, now: () => ctx.nowMs };
    return ctx.principal === 'service'
      ? createOathweaveServiceVerifier(settings, overrides)(token)
      : createOathweaveVerifier(settings, overrides)(token);
  };
  const strict = await runOathweaveConformance(verify, {
    strictReasons: true,
    only: ['valid-user', 'valid-service', 'expired', 'not-yet-valid', 'wrong-audience', 'wrong-issuer', 'bad-signature', 'unknown-kid',
      'alg-none', 'hs256-confusion', 'lifetime-too-long', 'user-without-session', 'unconfigured-native-issuer'],
  });
  assert.equal(strict.passed, 13);
  // Magnus configures no native issuer, so a native-issuer token is refused for its issuer before
  // its lifetime is looked at, and the valid native-issuer vector is (correctly) refused too.
  const native = await runOathweaveConformance(verify, { only: ['native-service-lifetime-too-long'] });
  assert.equal(native.passed, 1);
  const unconfigured = await runOathweaveConformance(verify, { only: ['valid-native-service'], throwOnFailure: false });
  assert.equal(unconfigured.results[0].actual, 'reject');
});
