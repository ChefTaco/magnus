import { randomUUID, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clock, DRAIN_KEY, get, harness, mint, NODE, ORIGIN, openSession, post, type Harness } from '../test/support.js';
import { MAX_INPUT_BYTES } from './app.js';
import { canonicalDrainJson, createResourceParticipant, type ParticipantRequest } from './participant.js';

let h: Harness;
beforeEach(() => { clock.offset = 0; h = harness(); });
afterEach(() => h.dispose());
const session = `ts_${'A'.repeat(43)}`;

describe('cross-origin requests', () => {
  it.each(['https://evil.example.com', 'http://console.example.com', 'null', `${ORIGIN}.evil.example.com`, `${ORIGIN}:8443`])('refuses the origin %s', async (origin) => {
    const response = await post(h.app, '/terminal/open', await mint(), { nodeId: NODE }, { origin });
    expect(response.status).toBe(403);
    expect((await response.json() as { error: string }).error).toBe('CROSS_ORIGIN_REJECTED');
    expect(h.calls).toEqual([]);
  });

  it.each(['cross-site', 'same-site'])('refuses Sec-Fetch-Site: %s', async (site) => {
    expect((await post(h.app, '/terminal/open', await mint(), { nodeId: NODE }, { 'sec-fetch-site': site })).status).toBe(403);
    expect(h.calls).toEqual([]);
  });

  it('accepts the console origin', async () => {
    expect((await post(h.app, '/terminal/open', await mint(), { nodeId: NODE }, { origin: ORIGIN, 'sec-fetch-site': 'same-origin' })).status).toBe(201);
  });

  it('answers no preflight and never sends a CORS header', async () => {
    const preflight = await h.app.request('/terminal/open', { method: 'OPTIONS', headers: { 'access-control-request-method': 'POST', origin: ORIGIN } });
    expect(preflight.status).toBe(404);
    const token = await mint();
    const responses = [
      preflight,
      await post(h.app, '/terminal/open', token, { nodeId: NODE }, { origin: ORIGIN }),
      await post(h.app, '/terminal/open', token, { nodeId: NODE }, { origin: 'https://evil.example.com' }),
      await get(h.app, '/health', null, { origin: ORIGIN }),
    ];
    for (const response of responses) {
      for (const name of response.headers.keys()) expect(name.toLowerCase()).not.toMatch(/^access-control-/);
    }
  });

  it('never serves the machine route to a browser', async () => {
    const response = await h.app.request('/internal/resource-enrollment/drain', { method: 'POST', headers: { origin: ORIGIN, 'x-resource-drain-key': DRAIN_KEY }, body: '{}' });
    expect(response.status).toBe(403);
  });
});

describe('request limits', () => {
  it('refuses another content type, which also rules out a simple cross-site form post', async () => {
    const token = await mint();
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/json, text/plain']) {
      const response = await h.app.request('/terminal/open', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': type }, body: JSON.stringify({ nodeId: NODE }) });
      expect(response.status).toBe(415);
    }
  });

  it('refuses a declared oversize body before reading it', async () => {
    const response = await post(h.app, '/terminal/open', await mint(), { nodeId: NODE, padding: 'x'.repeat(2_000) });
    expect(response.status).toBe(413);
  });

  it('bounds a streamed body without trusting Content-Length', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(2_048)); },
      cancel() { cancelled = true; },
    });
    const response = await h.app.request('/terminal/open', {
      method: 'POST', duplex: 'half', body, headers: { authorization: `Bearer ${await mint()}`, 'content-type': 'application/json' },
    } as RequestInit);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
  });

  it('caps one input request in bytes, counting multi-byte characters', async () => {
    const token = await mint();
    const sessionId = await openSession(h, token);
    expect((await post(h.app, '/terminal/input', token, { sessionId, data: 'x'.repeat(MAX_INPUT_BYTES) })).status).toBe(200);
    expect((await post(h.app, '/terminal/input', token, { sessionId, data: 'x'.repeat(MAX_INPUT_BYTES + 1) })).status).toBe(400);
    expect((await post(h.app, '/terminal/input', token, { sessionId, data: '€'.repeat(MAX_INPUT_BYTES) })).status).toBe(413);
    expect(h.shells[0]!.written).toHaveLength(1);
  });

  it('accepts control characters at the limit even though JSON spells them long', async () => {
    const token = await mint();
    const sessionId = await openSession(h, token);
    expect((await post(h.app, '/terminal/input', token, { sessionId, data: '\u0001'.repeat(MAX_INPUT_BYTES) })).status).toBe(200);
  });

  it.each([[{ sessionId: session }], [{ sessionId: session, data: '' }], [{ sessionId: session, data: 7 }], [{ sessionId: 'nope', data: 'x' }], [{ sessionId: session, data: 'x', host: 'attacker.example.com' }]])(
    'refuses the input body %j', async (body) => expect((await post(h.app, '/terminal/input', await mint(), body)).status).toBe(400),
  );

  it('refuses malformed JSON', async () => expect((await post(h.app, '/terminal/open', await mint(), '{nope')).status).toBe(400));

  it.each([[0, 10], [501, 10], [10, 0], [10, 201], [1.5, 10]])('refuses the resize %j x %j', async (cols, rows) => {
    const token = await mint();
    const sessionId = await openSession(h, token);
    expect((await post(h.app, '/terminal/resize', token, { sessionId, cols, rows })).status).toBe(400);
  });

  it('HEAD cannot attach a reader or replace a live one', async () => {
    const token = await mint();
    const sessionId = await openSession(h, token);
    const live = (await get(h.app, `/terminal/stream?sessionId=${sessionId}`, token)).body!.getReader();
    const head = await h.app.request(`/terminal/stream?sessionId=${sessionId}`, { method: 'HEAD', headers: { authorization: `Bearer ${token}` } });
    expect(head.status).toBe(404);
    h.shells[0]!.emit('still mine');
    expect(Buffer.from((await live.read()).value!).toString()).toBe('still mine');
  });

  it('a duplicated or unknown stream parameter is refused', async () => {
    const token = await mint();
    expect((await get(h.app, `/terminal/stream?sessionId=${session}&sessionId=${session}`, token)).status).toBe(400);
    expect((await get(h.app, `/terminal/stream?sessionId=${session}&host=x`, token)).status).toBe(400);
    expect((await get(h.app, `/terminal/stream?sessionId=${session}&access_token=${token}`, null)).status).toBe(400);
  });
});

describe('responses', () => {
  it('a hostile session id reaches no header and no body', async () => {
    const token = await mint();
    const hostile = encodeURIComponent('ts_x\r\nSet-Cookie: pwned=1');
    const response = await get(h.app, `/terminal/stream?sessionId=${hostile}`, token);
    expect(response.status).toBe(400);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).not.toContain('pwned');
  });

  it('every response carries the hardening headers', async () => {
    for (const response of [await get(h.app, '/health', null), await get(h.app, '/terminal/stream', null), await get(h.app, '/nope', null)]) {
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
    }
  });

  it('health says nothing about the fleet', async () => {
    expect(await (await get(h.app, '/health', null)).json()).toEqual({ status: 'ok' });
  });

  it('an unexpected failure answers a fixed sentence', async () => {
    h.shellError.value = Object.assign(new Error('deploy@10.0.0.5 key /run/secrets/key'), { name: 'Error' });
    const body = await (await post(h.app, '/terminal/open', await mint(), { nodeId: NODE })).text();
    expect(body).not.toMatch(/deploy|10\.0\.0\.5|secrets/);
  });

  it('unauthenticated refusals are the same whichever route', async () => {
    for (const response of [await get(h.app, `/terminal/stream?sessionId=${session}`, null), await post(h.app, '/terminal/close', null, { sessionId: session })]) {
      expect(response.status).toBe(401);
      expect((await response.json() as { error: string }).error).toBe('UNAUTHORIZED');
    }
  });
});

const descriptorFor = () => ({
  version: 1, participant: 'dashboard', nodeId: NODE, nodeFqdn: 'node-1.example.com', epoch: 2,
  barrierId: randomUUID(), challengeId: randomUUID(), expiresAt: Date.now() + 60_000,
});

function ledger(descriptor: ReturnType<typeof descriptorFor>, counts = { activeCount: 0, unknownCount: 0 }) {
  const calls: string[] = [];
  const request: ParticipantRequest = async (path, body) => {
    calls.push(path);
    const input = body as { nonce: string };
    return {
      version: 1, nodeId: descriptor.nodeId, nodeFqdn: descriptor.nodeFqdn, nonce: input.nonce, state: 'draining', epoch: descriptor.epoch,
      barrierId: descriptor.barrierId, challenge: { challengeId: descriptor.challengeId, expiresAt: descriptor.expiresAt }, ...counts, evidenceSha256: 'a'.repeat(64),
    };
  };
  return { calls, request };
}

describe('resource drain', () => {
  it('signs the exact challenge over the API ledger, keeping the wire contract', async () => {
    const descriptor = descriptorFor();
    const { signature, ...receipt } = await createResourceParticipant(DRAIN_KEY, ledger(descriptor).request).drain(descriptor, DRAIN_KEY);
    expect(receipt).toMatchObject({ ...descriptor, status: 'drained', activeCount: 0, unknownCount: 0 });
    expect(signature).toBe(createHmac('sha256', DRAIN_KEY).update(`magnus.resource-enrollment.v1\n${canonicalDrainJson(receipt)}`).digest('hex'));
  });

  it('reports pending from durable counts, whichever process holds the work', async () => {
    const descriptor = descriptorFor();
    expect(await createResourceParticipant(DRAIN_KEY, ledger(descriptor, { activeCount: 1, unknownCount: 0 }).request).drain(descriptor, DRAIN_KEY)).toMatchObject({ status: 'pending', activeCount: 1 });
    expect(await createResourceParticipant(DRAIN_KEY, ledger(descriptor, { activeCount: 0, unknownCount: 2 }).request).drain(descriptor, DRAIN_KEY)).toMatchObject({ status: 'pending', unknownCount: 2 });
  });

  it.each(['epoch', 'barrierId', 'challengeId', 'expiresAt', 'nodeFqdn'])('rejects a challenge whose %s disagrees with the API', async (key) => {
    const descriptor = descriptorFor();
    const stale = { ...descriptor, [key]: key === 'epoch' ? 3 : key === 'expiresAt' ? Date.now() + 120_000 : key === 'nodeFqdn' ? 'other.example.com' : randomUUID() };
    await expect(createResourceParticipant(DRAIN_KEY, ledger(descriptor).request).drain(stale, DRAIN_KEY)).rejects.toThrow();
  });

  it('checks the credential before contacting the API', async () => {
    const descriptor = descriptorFor();
    const { calls, request } = ledger(descriptor);
    await expect(createResourceParticipant(DRAIN_KEY, request).drain(descriptor, 'wrong')).rejects.toThrow('authentication');
    await expect(createResourceParticipant(DRAIN_KEY, request).drain(descriptor, 'é'.repeat(DRAIN_KEY.length))).rejects.toThrow('authentication');
    expect(calls).toEqual([]);
  });

  it('does not treat a bearer token or a cookie as drain authority', async () => {
    const token = await mint();
    for (const headers of [{ authorization: `Bearer ${token}` }, { cookie: `session=${token}` }]) {
      const response = await h.app.request('/internal/resource-enrollment/drain', { method: 'POST', headers, body: JSON.stringify(descriptorFor()) });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'Drain proof unavailable' });
    }
  });

  it('bounds the body without trusting Content-Length', async () => {
    let cancelled = false;
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4_097)); }, cancel() { cancelled = true; } });
    const response = await h.app.request('/internal/resource-enrollment/drain', { method: 'POST', duplex: 'half', body } as RequestInit);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
  });

  it('expired challenges are refused', async () => {
    const descriptor = { ...descriptorFor(), expiresAt: Date.now() - 1 };
    await expect(createResourceParticipant(DRAIN_KEY, ledger(descriptor).request).drain(descriptor, DRAIN_KEY)).rejects.toThrow('expired');
  });
});
