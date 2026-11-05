import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { ALICE, BOB, clock, foreignKey, get, harness, ISSUER, mint, NODE, openSession, post, type Harness } from '../test/support.js';
import { STEP_UP_WINDOW_SECONDS } from './authorize.js';

let h: Harness;
beforeEach(() => { clock.offset = 0; h = harness(); });
afterEach(() => h.dispose());
const open = (token: string | null, body: unknown = { nodeId: NODE }) => post(h.app, '/terminal/open', token, body);

describe('token verification', () => {
  it.each([
    ['another issuer', { issuer: 'https://other.example.com' }],
    ['another audience', { audience: 'cindertrace' }],
    ['another signing key', { key: foreignKey }],
    ['a service actor', { actorType: 'SERVICE_ACCOUNT' }],
    ['an over-long lifetime', { lifetime: 901 }],
  ])('refuses %s', async (_name, options) => {
    expect((await open(await mint(options))).status).toBe(401);
    expect(h.calls).toEqual([]);
  });

  it('refuses an expired token', async () => {
    const token = await mint({ lifetime: 60 });
    clock.offset += 61_000;
    expect((await open(token)).status).toBe(401);
  });

  it('refuses a token whose identity session was revoked', async () => {
    h.revoked.add('oath-subject-alice');
    expect((await open(await mint())).status).toBe(401);
  });

  it('refuses an unsigned token and a symmetric one', async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const claims = { sub: ALICE, iss: ISSUER, aud: 'magnus', actorType: 'USER', permissions: ['magnus:terminal'], auth_time: Math.floor(Date.now() / 1000) };
    expect((await open(`${encode({ alg: 'none' })}.${encode(claims)}.`)).status).toBe(401);
    const symmetric = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('5m').setJti('x').sign(new TextEncoder().encode('x'.repeat(64)));
    expect((await open(symmetric)).status).toBe(401);
  });

  it('reads the credential only from the Authorization header', async () => {
    const token = await mint();
    expect((await open(null)).status).toBe(401);
    expect((await post(h.app, '/terminal/open', null, { nodeId: NODE }, { cookie: `token=${token}` })).status).toBe(401);
    expect((await post(h.app, `/terminal/open?access_token=${token}`, null, { nodeId: NODE })).status).toBe(400);
    expect((await post(h.app, `/terminal/open?token=${token}`, token, { nodeId: NODE })).status).toBe(400);
    expect((await post(h.app, '/terminal/open', null, { nodeId: NODE }, { authorization: `Basic ${token}` })).status).toBe(401);
    expect(h.calls).toEqual([]);
  });
});

describe('terminal authority', () => {
  it.each([
    ['no account link', { subject: 'subject-unlinked' }],
    ['an OPERATOR link', { subject: 'subject-operator' }],
    ['a VIEWER link', { subject: 'subject-viewer' }],
    ['a duplicated link', { subject: 'subject-duplicate' }],
    ['an ADMIN link without magnus:terminal', { permissions: ['magnus:admin', 'magnus:operate', 'magnus:view'] }],
    ['a prefixed permission', { permissions: ['magnus:terminal:read'] }],
  ])('refuses %s as FORBIDDEN, never asking for step-up', async (_name, options) => {
    const response = await open(await mint({ ...options, authAge: 100_000 }));
    expect(response.status).toBe(403);
    expect((await response.json() as { error: string }).error).toBe('FORBIDDEN');
    expect(h.calls).toEqual([]);
  });

  it('applies the same authority to every call on an existing session', async () => {
    const sessionId = await openSession(h, await mint());
    const weak = await mint({ subject: 'subject-operator' });
    expect((await post(h.app, '/terminal/input', weak, { sessionId, data: 'x' })).status).toBe(403);
    expect((await get(h.app, `/terminal/stream?sessionId=${sessionId}`, weak)).status).toBe(403);
    expect(h.shells[0]!.written).toEqual([]);
  });
});

describe('step-up', () => {
  /** HiveXUI's transport matches exactly this shape: 403 with a top-level string `error`. */
  const expectStepUp = async (response: Response) => {
    expect(response.status).toBe(403);
    expect((await response.json() as { error: unknown }).error).toBe('STEP_UP_REQUIRED');
    expect(h.calls).toEqual([]);
  };

  it('uses a five minute window', () => expect(STEP_UP_WINDOW_SECONDS).toBe(300));
  it('refuses a stale verification', async () => expectStepUp(await open(await mint({ authAge: STEP_UP_WINDOW_SECONDS + 2 }))));
  it('refuses a token with no auth_time', async () => expectStepUp(await open(await mint({ authAge: null }))));
  it.each(['1700000000', 1.5, 0, null])('refuses the unusable auth_time %j', async (authTime) => expectStepUp(await open(await mint({ authTime }))));
  it('refuses an auth_time from the future', async () => expectStepUp(await open(await mint({ authAge: -120 }))));

  it('accepts a verification inside the window', async () => {
    expect((await open(await mint({ authAge: STEP_UP_WINDOW_SECONDS - 5 }))).status).toBe(201);
  });

  it('asks again only to open: calls on a live session survive the window passing', async () => {
    const token = await mint({ lifetime: 800 });
    const sessionId = await openSession(h, token);
    clock.offset += (STEP_UP_WINDOW_SECONDS + 60) * 1000;
    expect((await post(h.app, '/terminal/input', token, { sessionId, data: 'x' })).status).toBe(200);
    expect((await open(token)).status).toBe(403);
  });
});

describe('client input never selects a destination', () => {
  it.each(['host', 'hostname', 'ipAddress', 'port', 'username', 'user', 'command', 'cmd', 'exec', 'env', 'term', 'privateKey', 'password'])(
    'refuses a body naming %s', async (field) => {
      expect((await open(await mint(), { nodeId: NODE, [field]: 'attacker.example.com' })).status).toBe(400);
      expect(h.calls).toEqual([]);
    },
  );

  it.each(['', '../etc', 'a b', 'node\r\nX-Injected: 1', '-oProxyCommand=sh', 'x'.repeat(129), 7, null])('refuses the node id %j', async (nodeId) => {
    expect((await open(await mint(), { nodeId })).status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it('refuses a host in the query string', async () => {
    expect((await post(h.app, '/terminal/open?host=attacker.example.com', await mint(), { nodeId: NODE })).status).toBe(400);
  });

  it.each([[0, 30], [501, 30], [80, 0], [80, 201], [1.5, 30], ['80', 30]])('refuses the PTY size %j x %j', async (cols, rows) => {
    expect((await open(await mint(), { nodeId: NODE, cols, rows })).status).toBe(400);
  });

  it('dials the address the trust record and inventory agree on', async () => {
    expect((await open(await mint(), { nodeId: NODE, cols: 90, rows: 40 })).status).toBe(201);
    expect(h.targets[0]).toEqual({ nodeId: NODE, host: 'node-1.example.com', address: '10.0.0.5', port: 22, fingerprints: [expect.stringMatching(/^SHA256:/)] });
    expect(h.shells[0]!.sizes[0]).toEqual({ cols: 90, rows: 40 });
  });
});

describe('sessions belong to one person', () => {
  it('hides another subject\'s session from every verb, exactly as an unknown id', async () => {
    const sessionId = await openSession(h, await mint());
    const bob = await mint({ subject: BOB });
    const unknown = `ts_${'A'.repeat(43)}`;
    const verbs = (id: string) => [
      get(h.app, `/terminal/stream?sessionId=${id}`, bob),
      get(h.app, `/terminal/status?sessionId=${id}`, bob),
      post(h.app, '/terminal/input', bob, { sessionId: id, data: 'whoami\n' }),
      post(h.app, '/terminal/resize', bob, { sessionId: id, cols: 10, rows: 10 }),
      post(h.app, '/terminal/renew', bob, { sessionId: id }),
      post(h.app, '/terminal/close', bob, { sessionId: id }),
    ];
    const foreign = await Promise.all(verbs(sessionId));
    const absent = await Promise.all(verbs(unknown));
    for (const [index, response] of foreign.entries()) {
      expect(response.status).toBe(404);
      expect(await response.text()).toBe(await absent[index]!.text());
    }
    expect(h.shells[0]!.written).toEqual([]);
    expect(h.shells[0]!.sizes).toHaveLength(1);
    expect(h.shells[0]!.terminated).toBe(0);
    expect(h.sessions.size()).toBe(1);
  });

  it('a second identity session of the same person cannot attach either', async () => {
    const sessionId = await openSession(h, await mint({ sessionId: 'laptop' }));
    expect((await post(h.app, '/terminal/input', await mint({ sessionId: 'phone' }), { sessionId, data: 'x' })).status).toBe(404);
  });

  it('after a session ends, its reason stays private to its owner', async () => {
    const token = await mint();
    const sessionId = await openSession(h, token);
    expect((await post(h.app, '/terminal/close', token, { sessionId })).status).toBe(200);
    expect((await get(h.app, `/terminal/status?sessionId=${sessionId}`, await mint({ subject: BOB }))).status).toBe(404);
    expect(await (await get(h.app, `/terminal/status?sessionId=${sessionId}`, token)).json()).toEqual({ state: 'ended', reason: 'client-closed' });
  });

  it('a foreign token can never extend someone else\'s session', async () => {
    const token = await mint({ lifetime: 100 });
    const sessionId = await openSession(h, token);
    await post(h.app, '/terminal/renew', await mint({ subject: BOB, lifetime: 800 }), { sessionId });
    clock.offset += 101_000;
    h.sessions.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.sessions.size()).toBe(0);
  });
});
