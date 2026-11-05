import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OATHWEAVE_STREAM_RECHECK_MS } from '@hivemagnus/magnus-oathweave';
import { ALICE, BOB, clock, FakeShell, get, harness, ISSUER, LIMITS, mint, NODE, now, openSession, passSessionCache, post, settle, type Harness } from '../test/support.js';
import { createApp } from './app.js';
import { createSessionManager, type SessionLimits } from './sessions.js';

let h: Harness;
const build = (limits: Partial<SessionLimits> = {}) => { h = harness(limits); return h; };
beforeEach(() => { clock.offset = 0; build(); });
afterEach(() => h.dispose());
const ended = async (sessionId: string, token: string) => (await (await get(h.app, `/terminal/status?sessionId=${sessionId}`, token)).json()) as { state: string; reason?: string };

describe('authority is re-checked for the life of a session', () => {
  it('re-checks on the same cadence as event streams', () => {
    expect(OATHWEAVE_STREAM_RECHECK_MS).toBe(5_000);
  });

  it('ends the shell when the identity session is revoked, and refuses further use', async () => {
    const token = await mint({ lifetime: 800 });
    const owner = await mint({ lifetime: 800 });
    const sessionId = await openSession(h, token);
    h.revoked.add('oath-subject-alice');
    passSessionCache();
    h.sessions.tick();
    await settle();
    expect(h.sessions.size()).toBe(0);
    expect(h.shells[0]!.terminated).toBe(1);
    expect((await post(h.app, '/terminal/input', owner, { sessionId, data: 'x' })).status).toBe(401);
    expect(h.audits.find((event) => event.action === 'terminal.session.close')).toMatchObject({ outcome: 'token-revoked', sessionId, nodeId: NODE });
  });

  it('ends the shell when the token expires', async () => {
    const token = await mint({ lifetime: 60 });
    const sessionId = await openSession(h, token);
    clock.offset += 61_000;
    h.sessions.tick();
    await settle();
    expect(h.shells[0]!.terminated).toBe(1);
    const fresh = await mint();
    expect(await ended(sessionId, fresh)).toEqual({ state: 'ended', reason: 'token-expired' });
  });

  it('a newer token from the same identity session keeps it alive, with no new step-up', async () => {
    const sessionId = await openSession(h, await mint({ lifetime: 60 }));
    clock.offset += 50_000;
    const renewal = await mint({ lifetime: 600, authAge: 10_000 });
    expect((await post(h.app, '/terminal/renew', renewal, { sessionId })).status).toBe(200);
    clock.offset += 20_000;
    h.sessions.tick();
    await settle();
    expect(h.sessions.size()).toBe(1);
    expect(h.shells[0]!.terminated).toBe(0);
  });

  it('an older token presented later cannot shorten or replace the current one', async () => {
    const older = await mint({ lifetime: 60 });
    const sessionId = await openSession(h, await mint({ lifetime: 600 }));
    expect((await post(h.app, '/terminal/renew', older, { sessionId })).status).toBe(200);
    clock.offset += 61_000;
    h.sessions.tick();
    await settle();
    expect(h.sessions.size()).toBe(1);
  });

  it('losing magnus:terminal ends every session of that identity session at once', async () => {
    const sessionId = await openSession(h, await mint());
    const stripped = await mint({ permissions: ['magnus:view'] });
    expect((await post(h.app, '/terminal/renew', stripped, { sessionId })).status).toBe(403);
    expect(h.shells[0]!.terminated).toBe(1);
    expect(await ended(sessionId, await mint())).toEqual({ state: 'ended', reason: 'authority-lost' });
  });

  it('another person losing authority touches nothing of mine', async () => {
    await openSession(h, await mint());
    await post(h.app, '/terminal/renew', await mint({ subject: BOB, permissions: ['magnus:view'] }), { sessionId: `ts_${'A'.repeat(43)}` });
    expect(h.sessions.size()).toBe(1);
  });

  it('a slow check of a replaced token does not end the session', async () => {
    let finishCheck!: (error: Error) => void;
    const channel = new FakeShell();
    const sessions = createSessionManager({
      authorizer: { authorize: () => new Promise((_resolve, reject) => { finishCheck = reject; }), authorizeOpen: async () => { throw new Error('unused'); } },
      auditor: { required: async () => undefined, bestEffort: async () => undefined },
      limits: LIMITS,
      now,
      connect: async () => ({ channel, work: { workId: 'w', nodeId: NODE, finish: async () => undefined } }),
    });
    const principal = (token: string, expiresAt: number) => ({
      token, ownerKey: 'owner', subjectKey: 'subject',
      link: { issuer: ISSUER, subject: ALICE, localUserId: 'alice', role: 'ADMIN' as const },
      identity: { subject: ALICE, issuer: ISSUER, sessionId: 's', roles: [], permissions: [], displayName: 'a', issuedAt: 1, expiresAt, authTime: 1 },
    });
    const at = Math.floor(now() / 1000);
    const { sessionId } = await sessions.open({ principal: principal('first', at + 60), nodeId: NODE, size: { cols: 80, rows: 24 }, ipAddress: null });
    sessions.attach(sessionId, principal('first', at + 60));
    sessions.tick();
    sessions.renew(sessionId, principal('second', at + 600));
    finishCheck(new Error('revoked'));
    await settle();
    expect(sessions.size()).toBe(1);
    expect(channel.terminated).toBe(0);
    sessions.shutdown();
  });
});

describe('time limits', () => {
  it('ends an idle session, and only input counts as activity', async () => {
    build({ idleTimeoutMs: 1_000 });
    const token = await mint();
    const sessionId = await openSession(h, token);
    await get(h.app, `/terminal/stream?sessionId=${sessionId}`, token);
    clock.offset += 600;
    await post(h.app, '/terminal/input', token, { sessionId, data: 'x' });
    clock.offset += 600;
    h.sessions.tick();
    expect(h.sessions.size()).toBe(1);
    // Output, resizes and renewals do not keep it alive.
    h.shells[0]!.emit('still running');
    await post(h.app, '/terminal/resize', token, { sessionId, cols: 90, rows: 40 });
    await post(h.app, '/terminal/renew', token, { sessionId });
    clock.offset += 500;
    h.sessions.tick();
    expect(await ended(sessionId, token)).toEqual({ state: 'ended', reason: 'idle-timeout' });
  });

  it('ends a session at its maximum lifetime however active it is', async () => {
    build({ maxLifetimeMs: 1_000 });
    const token = await mint();
    const sessionId = await openSession(h, token);
    await get(h.app, `/terminal/stream?sessionId=${sessionId}`, token);
    clock.offset += 900;
    await post(h.app, '/terminal/input', token, { sessionId, data: 'x' });
    clock.offset += 200;
    h.sessions.tick();
    expect(await ended(sessionId, token)).toEqual({ state: 'ended', reason: 'max-lifetime' });
  });

  it('ends a shell nobody is reading, so abandoned opens do not accumulate', async () => {
    build({ detachGraceMs: 1_000 });
    const token = await mint();
    const sessionId = await openSession(h, token);
    clock.offset += 1_100;
    h.sessions.tick();
    expect(await ended(sessionId, token)).toEqual({ state: 'ended', reason: 'detached' });
  });

  it('settles a remote exit as remote-ended and anything else as unknown', async () => {
    const token = await mint();
    await openSession(h, token);
    await openSession(h, token);
    h.shells[0]!.remoteClose(0);
    await settle();
    h.shells[1]!.remoteClose(null);
    await settle();
    expect(h.calls.filter((call) => call === 'participant:finish')).toHaveLength(2);
    expect(h.audits.filter((event) => event.action === 'terminal.session.close').map((event) => event.outcome)).toEqual(['remote-ended', 'connection-lost']);
  });
});

describe('limits', () => {
  it('limits concurrent sessions per subject', async () => {
    const token = await mint();
    for (let index = 0; index < 3; index += 1) await openSession(h, token);
    const response = await post(h.app, '/terminal/open', token, { nodeId: NODE });
    expect(response.status).toBe(429);
    expect((await response.json() as { error: string }).error).toBe('SESSION_LIMIT_REACHED');
    expect(h.shells).toHaveLength(3);
  });

  it('limits sessions overall', async () => {
    build({ maxPerSubject: 100, maxTotal: 2 });
    await openSession(h, await mint());
    await openSession(h, await mint({ subject: BOB }));
    expect((await post(h.app, '/terminal/open', await mint(), { nodeId: NODE })).status).toBe(429);
  });

  it('concurrent opens cannot race past the limit', async () => {
    let release!: () => void;
    h.gate.value = new Promise((resolve) => { release = resolve; });
    const token = await mint();
    const attempts = Array.from({ length: 8 }, () => post(h.app, '/terminal/open', token, { nodeId: NODE }));
    await settle();
    release();
    const statuses = (await Promise.all(attempts)).map((response) => response.status).sort();
    expect(statuses).toEqual([201, 201, 201, 429, 429, 429, 429, 429]);
    expect(h.shells).toHaveLength(3);
  });

  it('a shell finishing its connection during shutdown is ended, not leaked', async () => {
    let release!: () => void;
    h.gate.value = new Promise((resolve) => { release = resolve; });
    const pending = post(h.app, '/terminal/open', await mint(), { nodeId: NODE });
    await settle();
    h.sessions.shutdown();
    release();
    const response = await pending;
    expect(response.status).toBe(503);
    expect((await response.json() as { error: string }).error).toBe('GATEWAY_STOPPING');
    expect(h.shells[0]!.terminated).toBe(1);
    expect(h.sessions.size()).toBe(0);
  });

  it('a refused open gives its slot back', async () => {
    build({ maxPerSubject: 1 });
    const token = await mint();
    h.shellError.value = new Error('refused');
    expect((await post(h.app, '/terminal/open', token, { nodeId: NODE })).status).toBe(502);
    h.shellError.value = null;
    expect((await post(h.app, '/terminal/open', token, { nodeId: NODE })).status).toBe(201);
  });

  it('a closed session gives its slot back', async () => {
    build({ maxPerSubject: 1 });
    const token = await mint();
    const sessionId = await openSession(h, token);
    await post(h.app, '/terminal/close', token, { sessionId });
    expect((await post(h.app, '/terminal/open', token, { nodeId: NODE })).status).toBe(201);
  });

  it('limits how fast one subject can open sessions', async () => {
    build({ opensPerMinute: 2, maxPerSubject: 100, maxTotal: 100 });
    const token = await mint();
    await openSession(h, token);
    await openSession(h, token);
    const response = await post(h.app, '/terminal/open', token, { nodeId: NODE });
    expect((await response.json() as { error: string }).error).toBe('RATE_LIMITED');
    clock.offset += 61_000;
    expect((await post(h.app, '/terminal/open', await mint(), { nodeId: NODE })).status).toBe(201);
  });

  it('limits output held for a slow or absent reader by pausing the shell', async () => {
    build({ maxBufferedBytes: 1_000 });
    const token = await mint();
    const sessionId = await openSession(h, token);
    h.shells[0]!.emit(Buffer.alloc(1_200));
    expect(h.shells[0]!.paused).toBe(true);
    const reader = (await get(h.app, `/terminal/stream?sessionId=${sessionId}`, token)).body!.getReader();
    expect((await reader.read()).value?.byteLength).toBe(1_200);
    expect(h.shells[0]!.paused).toBe(false);
  });

  it('ends a session whose node keeps sending after being paused, so one node cannot exhaust memory', async () => {
    build({ maxBufferedBytes: 1_000 });
    const token = await mint();
    const sessionId = await openSession(h, token);
    h.shells[0]!.emit(Buffer.alloc(1_200));
    expect(h.shells[0]!.paused).toBe(true);
    h.shells[0]!.emit(Buffer.alloc(2_000));
    expect(h.sessions.size()).toBe(1);
    h.shells[0]!.emit(Buffer.alloc(2_000));
    expect(h.sessions.size()).toBe(0);
    expect(h.shells[0]!.terminated).toBe(1);
    expect(await ended(sessionId, token)).toEqual({ state: 'ended', reason: 'output-overflow' });
  });

  it('refuses input while the remote side is not accepting it', async () => {
    const token = await mint();
    const sessionId = await openSession(h, token);
    h.shells[0]!.congested = true;
    const response = await post(h.app, '/terminal/input', token, { sessionId, data: 'x' });
    expect(response.status).toBe(429);
    expect(h.shells[0]!.written).toEqual([]);
  });
});

describe('streaming', () => {
  it('delivers output to the owner byte for byte, queued output first', async () => {
    const token = await mint();
    const sessionId = await openSession(h, token);
    h.shells[0]!.emit('before attach ');
    const response = await get(h.app, `/terminal/stream?sessionId=${sessionId}`, token);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const reader = response.body!.getReader();
    expect(Buffer.from((await reader.read()).value!).toString()).toBe('before attach ');
    h.shells[0]!.emit(Buffer.from([0x1b, 0x5b, 0x41, 0xff]));
    expect([...(await reader.read()).value!]).toEqual([0x1b, 0x5b, 0x41, 0xff]);
  });

  it('a reconnecting owner replaces the previous reader', async () => {
    const token = await mint();
    const sessionId = await openSession(h, token);
    const first = (await get(h.app, `/terminal/stream?sessionId=${sessionId}`, token)).body!.getReader();
    const second = (await get(h.app, `/terminal/stream?sessionId=${sessionId}`, token)).body!.getReader();
    expect((await first.read()).done).toBe(true);
    h.shells[0]!.emit('to the new reader');
    expect(Buffer.from((await second.read()).value!).toString()).toBe('to the new reader');
  });

  it('a remote exit delivers remaining output and then closes cleanly', async () => {
    const token = await mint();
    const sessionId = await openSession(h, token);
    const reader = (await get(h.app, `/terminal/stream?sessionId=${sessionId}`, token)).body!.getReader();
    h.shells[0]!.emit('goodbye');
    h.shells[0]!.remoteClose(0);
    expect(Buffer.from((await reader.read()).value!).toString()).toBe('goodbye');
    expect((await reader.read()).done).toBe(true);
  });

  it('a revocation discards undelivered output instead of flushing it', async () => {
    build({ maxBufferedBytes: 10 * 1024 * 1024 });
    const token = await mint({ lifetime: 800 });
    const sessionId = await openSession(h, token);
    const reader = (await get(h.app, `/terminal/stream?sessionId=${sessionId}`, token)).body!.getReader();
    h.shells[0]!.emit(Buffer.alloc(512 * 1024, 0x61));
    h.shells[0]!.emit(Buffer.alloc(8, 0x62));
    h.revoked.add('oath-subject-alice');
    passSessionCache();
    h.sessions.tick();
    await settle();
    await expect(reader.read()).rejects.toThrow();
  });

  it('a stream disconnect leaves the session for the detach grace, then ends it', async () => {
    build({ detachGraceMs: 1_000 });
    const token = await mint();
    const sessionId = await openSession(h, token);
    const reader = (await get(h.app, `/terminal/stream?sessionId=${sessionId}`, token)).body!.getReader();
    await reader.cancel();
    h.sessions.tick();
    expect(h.sessions.size()).toBe(1);
    clock.offset += 1_100;
    h.sessions.tick();
    expect(h.sessions.size()).toBe(0);
  });
});

describe('audit', () => {
  const SECRET_INPUT = 'mysql -pfixture-input-secret';
  const SECRET_OUTPUT = 'fixture-output-secret';

  it('records who, which node, when, duration and outcome, and no content', async () => {
    const logged: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...values: unknown[]) => { logged.push(values.join(' ')); });
    }
    const token = await mint();
    const sessionId = await openSession(h, token);
    const reader = (await get(h.app, `/terminal/stream?sessionId=${sessionId}`, token)).body!.getReader();
    await post(h.app, '/terminal/input', token, { sessionId, data: SECRET_INPUT });
    h.shells[0]!.emit(SECRET_OUTPUT);
    expect(Buffer.from((await reader.read()).value!).toString()).toBe(SECRET_OUTPUT);
    clock.offset += 1_000;
    await post(h.app, '/terminal/close', token, { sessionId });
    await settle();
    vi.restoreAllMocks();

    expect(h.shells[0]!.written).toEqual([SECRET_INPUT]);
    const [requested, open, close] = h.audits;
    expect(requested).toMatchObject({ action: 'terminal.session.open', subject: ALICE, nodeId: NODE, sessionId, outcome: 'requested' });
    expect(open).toMatchObject({ action: 'terminal.session.open', subject: ALICE, actorId: 'alice', nodeId: NODE, sessionId, outcome: 'opened', durationMs: null });
    expect(close).toMatchObject({ action: 'terminal.session.close', subject: ALICE, nodeId: NODE, sessionId, outcome: 'client-closed' });
    expect(close!.durationMs).toBeGreaterThanOrEqual(1_000);
    expect(Object.keys(open!).sort()).toEqual(['action', 'actorId', 'at', 'durationMs', 'fingerprint', 'ipAddress', 'nodeId', 'outcome', 'sessionId', 'subject']);

    const everything = JSON.stringify(h.audits) + h.lines.join('\n') + logged.join('\n');
    expect(everything).not.toContain(SECRET_INPUT);
    expect(everything).not.toContain(SECRET_OUTPUT);
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(token.split('.')[2]);
  });

  it('reaches no node when the request cannot be recorded, and gives the slot back', async () => {
    build({ maxPerSubject: 1 });
    h.auditFailure.value = true;
    const token = await mint();
    const response = await post(h.app, '/terminal/open', token, { nodeId: NODE });
    expect(response.status).toBe(503);
    expect((await response.json() as { error: string }).error).toBe('AUDIT_UNAVAILABLE');
    expect(h.calls).toEqual([]);
    h.auditFailure.value = false;
    expect((await post(h.app, '/terminal/open', token, { nodeId: NODE })).status).toBe(201);
  });

  it('ends the shell and returns no handle when the opened record fails', async () => {
    let writes = 0;
    const channel = new FakeShell();
    const principal = { token: 't', ownerKey: 'o', subjectKey: 's', link: { issuer: ISSUER, subject: ALICE, localUserId: 'alice', role: 'ADMIN' as const },
      identity: { subject: ALICE, issuer: ISSUER, sessionId: 's', roles: [], permissions: [], displayName: 'a', issuedAt: 1, expiresAt: 2, authTime: 1 } };
    const sessions = createSessionManager({
      authorizer: { authorize: async () => principal, authorizeOpen: async () => principal },
      auditor: { required: async () => { writes += 1; if (writes === 2) throw new Error('down'); }, bestEffort: async () => undefined },
      limits: LIMITS,
      now,
      connect: async () => ({ channel, work: { workId: 'w', nodeId: NODE, finish: async () => undefined } }),
    });
    await expect(sessions.open({ principal, nodeId: NODE, size: { cols: 80, rows: 24 }, ipAddress: null })).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect(channel.terminated).toBe(1);
    expect(sessions.size()).toBe(0);
    sessions.shutdown();
  });

  it('still settles and records locally when the API loses the close event', async () => {
    const token = await mint();
    const sessionId = await openSession(h, token);
    h.auditFailure.value = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await post(h.app, '/terminal/close', token, { sessionId });
    await settle();
    expect(h.lines.at(-1)).toContain('terminal.session.close');
    expect(errors.mock.calls.join()).toContain('audit-delivery-failed');
    errors.mockRestore();
  });

  it('records refusals of verified tokens, without a token', async () => {
    const token = await mint({ subject: 'subject-operator' });
    await post(h.app, '/terminal/open', token, { nodeId: NODE });
    await settle();
    expect(h.audits).toEqual([expect.objectContaining({ action: 'terminal.session.refuse', subject: 'subject-operator', actorId: 'olivia', outcome: 'FORBIDDEN' })]);
    expect(JSON.stringify(h.audits)).not.toContain(token);
  });

  it('a garbage token cannot reach the audit log', async () => {
    await post(h.app, '/terminal/open', 'a.b.c', { nodeId: NODE });
    await settle();
    expect(h.audits).toEqual([]);
    expect(h.lines).toEqual([]);
  });

  it('bounds how many refusals one person can write', async () => {
    const token = await mint({ subject: 'subject-operator' });
    await Promise.all(Array.from({ length: 50 }, () => post(h.app, '/terminal/open', token, { nodeId: NODE })));
    await settle();
    expect(h.audits).toHaveLength(30);
  });

  it('believes X-Forwarded-For only when configured to', async () => {
    const forged = { 'x-forwarded-for': '198.51.100.7' };
    await post(h.app, '/terminal/open', await mint(), { nodeId: NODE }, forged);
    expect(h.audits.map((event) => event.ipAddress)).not.toContain('198.51.100.7');
  });

  it('records only one address the audit schema accepts, so a client cannot make its record fail', async () => {
    build({ maxPerSubject: 10, maxTotal: 10 });
    const app = createApp({ ...h.appDependencies, trustForwardedFor: true });
    const token = await mint();
    for (const value of ['198.51.100.7', '198.51.100.7, 203.0.113.1', 'evil"},{"forged":true', 'fe80::1%eth0']) {
      expect((await post(app, '/terminal/open', token, { nodeId: NODE }, { 'x-forwarded-for': value })).status).toBe(201);
    }
    await settle();
    expect(h.audits.filter((event) => event.outcome === 'requested').map((event) => event.ipAddress)).toEqual(['198.51.100.7', null, null, null]);
    expect(h.lines.join('\n')).not.toContain('forged');
  });

  it('a verified open without the permission ends what that identity session holds', async () => {
    await openSession(h, await mint());
    expect((await post(h.app, '/terminal/open', await mint({ permissions: ['magnus:view'] }), { nodeId: NODE })).status).toBe(403);
    expect(h.shells[0]!.terminated).toBe(1);
  });
});
