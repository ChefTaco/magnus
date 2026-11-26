import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeOwnListener } from './self-probe.js';

const signed = () => ({ 'x-magnus-signature': 'fixture-signature' });
let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map(server => new Promise(done => server.close(done))));
  servers = [];
});

function handler(version: string, seen: IncomingMessage[] = []) {
  return (req: IncomingMessage, res: ServerResponse) => {
    seen.push(req);
    if (req.url === '/api/v1/ping') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"success":true}'); return; }
    if (req.url !== '/api/v1/health/check' || !req.headers['x-magnus-signature']) { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: { service: 'magnus-agent', version } }));
  };
}

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  return (server.address() as AddressInfo).port;
}

describe('self-probe of the agent listener before confirming a trial', () => {
  it('passes only when the signed health check answers with this version', async () => {
    const seen: IncomingMessage[] = [];
    const port = await listen(createHttpServer(handler('3.4.0', seen)));
    const listener = { protocol: 'http:' as const, hostname: '0.0.0.0', port };
    expect(await probeOwnListener('3.4.0', { listener, sign: signed, env: {} })).toEqual({ ok: true });
    expect(seen[0]?.url).toBe('/api/v1/health/check');
    expect(seen[0]?.headers['x-magnus-signature']).toBe('fixture-signature');
    expect(await probeOwnListener('3.5.0', { listener, sign: signed, env: {} })).toMatchObject({ ok: false, reason: expect.stringContaining('3.4.0') });
  });

  it('fails when the listener is not up, refuses the request or never started', async () => {
    const port = await listen(createHttpServer((_req, res) => { res.writeHead(500); res.end(); }));
    expect(await probeOwnListener('3.4.0', { listener: { protocol: 'http:', hostname: '127.0.0.1', port }, sign: signed, env: {} }))
      .toMatchObject({ ok: false, reason: 'listener answered 500' });
    const closed = createHttpServer(); const closedPort = await listen(closed); await new Promise(done => closed.close(done)); servers = servers.filter(s => s !== closed);
    expect((await probeOwnListener('3.4.0', { listener: { protocol: 'http:', hostname: '127.0.0.1', port: closedPort }, sign: signed, env: {} })).ok).toBe(false);
    expect(await probeOwnListener('3.4.0', { listener: null, sign: signed, env: {} })).toMatchObject({ ok: false });
    // An HTTPS listener that speaks plain HTTP is broken TLS.
    const plain = await listen(createHttpServer(handler('3.4.0')));
    expect((await probeOwnListener('3.4.0', { listener: { protocol: 'https:', hostname: '127.0.0.1', port: plain }, sign: signed, env: {}, timeoutMs: 2000 })).ok).toBe(false);
  });

  it('falls back to the unauthenticated ping when the node has no bound key', async () => {
    const seen: IncomingMessage[] = [];
    const port = await listen(createHttpServer(handler('3.4.0', seen)));
    expect(await probeOwnListener('3.4.0', { listener: { protocol: 'http:', hostname: '127.0.0.1', port }, sign: () => ({}), env: {} })).toEqual({ ok: true });
    expect(seen.map(req => req.url)).toEqual(['/api/v1/ping']);
  });

  it('checks the TLS handshake and certificate dates over loopback', async (context) => {
    let dir: string;
    try {
      dir = mkdtempSync(join(tmpdir(), 'self-probe-'));
      execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '2',
        '-subj', '/CN=node-1.example.com', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
    } catch { context.skip(); return; }
    try {
      const server = createHttpsServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, handler('3.4.0'));
      const port = await listen(server);
      const listener = { protocol: 'https:' as const, hostname: '0.0.0.0', port };
      expect(await probeOwnListener('3.4.0', { listener, sign: signed, env: {} })).toEqual({ ok: true });
      const later = vi.fn(() => Date.now() + 10 * 24 * 3600_000);
      expect(await probeOwnListener('3.4.0', { listener, sign: signed, env: {}, now: later }))
        .toMatchObject({ ok: false, reason: expect.stringContaining('expired') });
      // An operator self URL is verified in full; a self-signed certificate fails that.
      expect((await probeOwnListener('3.4.0', { listener, sign: signed, env: { MAGNUS_AGENT_SELF_URL: `https://localhost:${port}/` } })).ok).toBe(false);
      expect(await probeOwnListener('3.4.0', { listener, sign: signed,
        env: { MAGNUS_AGENT_SELF_URL: `https://localhost:${port}/`, MAGNUS_AGENT_SELF_CA_PATH: join(dir, 'cert.pem') } }))
        .toMatchObject({ ok: false });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('confirmTrialAfterSelfProbe', () => {
  it('does not confirm while the probe fails', async () => {
    const { confirmTrialAfterSelfProbe } = await import('../agent.js');
    const probe = vi.fn(async () => ({ ok: false as const, reason: 'listener answered 500' }));
    expect(await confirmTrialAfterSelfProbe(probe)).toBe(false);
    expect(probe).toHaveBeenCalledOnce();
  });
});
