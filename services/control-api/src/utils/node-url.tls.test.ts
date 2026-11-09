import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type TLSSocket } from 'node:tls';
import { createServer as createTcpServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repairAgentAddress, verifyAgentTlsHostname } from './node-url.js';

describe('agent callback certificate identity', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'magnus-agent-tls-'));
  const servers: Server[] = [];
  const sockets = new Set<TLSSocket>();
  const received: Buffer[] = [];
  async function listener(name: string, san: string) {
    const key = join(temporary, name + '.key'), certificate = join(temporary, name + '.crt');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
      '-nodes', '-days', '2', '-subj', '/CN=node.example.com', '-addext', 'subjectAltName=' + san,
      '-keyout', key, '-out', certificate], { stdio: 'ignore' });
    const ca = readFileSync(certificate);
    const server = createServer({ key: readFileSync(key), cert: ca }, socket => {
      sockets.add(socket);
      socket.on('data', data => received.push(data));
      socket.once('close', () => sockets.delete(socket));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture listener');
    return { port: address.port, ca };
  }
  let dns: Awaited<ReturnType<typeof listener>>;
  let ipOnly: Awaited<ReturnType<typeof listener>>;
  beforeAll(async () => {
    dns = await listener('dns', 'DNS:node.example.com,IP:127.0.0.1');
    ipOnly = await listener('ip-only', 'DNS:localhost,IP:127.0.0.1');
  });
  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    rmSync(temporary, { recursive: true, force: true });
  });
  it('selects a trusted DNS certificate on the address bound to the heartbeat', async () => {
    expect(await verifyAgentTlsHostname('node.example.com', '127.0.0.1', dns.port, { ca: dns.ca })).toBe(true);
    expect(received).toEqual([]);
  });
  it('keeps the routable IP when the certificate does not cover the reported FQDN', async () => {
    const verified = await verifyAgentTlsHostname('node.example.com', '127.0.0.1', ipOnly.port, { ca: ipOnly.ca });
    expect(verified).toBe(false);
    expect(repairAgentAddress('node.example.com', null, '192.0.2.10', 'node.example.com')).toBe('192.0.2.10');
    expect(received).toEqual([]);
  });
  it('rejects an untrusted certificate even when the name matches', async () => {
    expect(await verifyAgentTlsHostname('node.example.com', '127.0.0.1', dns.port)).toBe(false);
  });
  it('preserves an independently configured endpoint and rejects invalid callback coordinates', async () => {
    expect(repairAgentAddress('custom.example.com', null, '192.0.2.10', 'node.example.com')).toBeNull();
    expect(await verifyAgentTlsHostname('node.example.com', 'not-an-address', 4100)).toBe(false);
    expect(await verifyAgentTlsHostname('node.example.com', '127.0.0.1', 0)).toBe(false);
  });
  it('bounds a stalled handshake instead of blocking heartbeat enrollment', async () => {
    const connections: import('node:net').Socket[] = [];
    const server = createTcpServer(socket => connections.push(socket));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture listener');
    try {
      expect(await verifyAgentTlsHostname('node.example.com', '127.0.0.1', address.port, { timeoutMs: 30 })).toBe(false);
    } finally {
      for (const socket of connections) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
