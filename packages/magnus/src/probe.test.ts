import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLocalAddress, isLoopbackAddress, probeStatus } from './probe.js';

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

/** A self-signed certificate naming only a public host, like a project generated for its public name. */
function certificate(dir: string, name: string): { key: string; cert: string } {
  const key = join(dir, `${name}.key`); const cert = join(dir, `${name}.crt`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2',
    '-subj', '/CN=magnus.example.com', '-addext', 'subjectAltName=DNS:magnus.example.com'], { stdio: 'ignore' });
  return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') };
}

describe.skipIf(!hasOpenssl)('probeStatus', () => {
  let dir: string; let server: Server; let served: { key: string; cert: string }; let other: { key: string; cert: string }; let url: string;
  const warnings: string[] = [];
  const quiet = { warn: (line: string) => { warnings.push(line); } };
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'magnus-probe-'));
    served = certificate(dir, 'served');
    other = certificate(dir, 'other');
    server = createServer(served, (_req, res) => { res.statusCode = 204; res.end(); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    url = `https://127.0.0.1:${address.port}/api/v1/health`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('verifies the project certificate although it names another host', async () => {
    let fellBack = false;
    const status = await probeStatus(url, { ca: served.cert }, { isLocalAddress: async () => { fellBack = true; return true; }, ...quiet });
    expect(status).toBe(204);
    expect(fellBack).toBe(false);
  });

  it('accepts a certificate issued by a CA when only the served leaf is configured', async () => {
    const ca = certificate(dir, 'ca');
    const key = join(dir, 'leaf.key'); const csr = join(dir, 'leaf.csr'); const leaf = join(dir, 'leaf.crt');
    execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', '/CN=magnus.example.com'], { stdio: 'ignore' });
    execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', join(dir, 'ca.crt'), '-CAkey', join(dir, 'ca.key'), '-CAcreateserial', '-out', leaf, '-days', '2'], { stdio: 'ignore' });
    expect(ca.cert).toContain('BEGIN CERTIFICATE');
    const issued = createServer({ key: readFileSync(key), cert: readFileSync(leaf) }, (_req, res) => { res.statusCode = 200; res.end(); });
    await new Promise<void>((resolve) => issued.listen(0, '127.0.0.1', resolve));
    const address = issued.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    try {
      const status = await probeStatus(`https://127.0.0.1:${address.port}/`, { ca: readFileSync(leaf, 'utf8') }, { isLocalAddress: async () => false, ...quiet });
      expect(status).toBe(200);
    } finally {
      issued.closeAllConnections();
      await new Promise<void>((resolve) => issued.close(() => resolve()));
    }
  });

  it('still answers on this machine when no certificate is known, or the known one differs or is unusable', async () => {
    expect(await probeStatus(url, {}, quiet)).toBe(204);
    expect(await probeStatus(url, { ca: other.cert }, quiet)).toBe(204);
    expect(warnings.some((line) => line.includes('unverified local status probe'))).toBe(true);
    expect(await probeStatus(url, { ca: 'not a certificate' }, quiet)).toBe(204);
  });

  it('never skips verification for an address outside this machine', async () => {
    const remote = { isLocalAddress: async () => false, ...quiet };
    expect(await probeStatus(url, {}, remote)).toBeNull();
    expect(await probeStatus(url, { ca: other.cert }, remote)).toBeNull();
    expect(await probeStatus(url, { ca: served.cert }, remote)).toBe(204);
  });

  it('reports a closed port as no answer, so waiting for a stop still ends', async () => {
    const closed = createServer(served);
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const address = closed.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    expect(await probeStatus(`https://127.0.0.1:${address.port}/`, { ca: served.cert }, quiet)).toBeNull();
  });
});

describe('local address detection', () => {
  it.each(['127.0.0.1', '127.1.2.3', '::1', '[::1]', '::ffff:127.0.0.1', 'localhost'])('treats %s as loopback', (address) => {
    expect(isLoopbackAddress(address)).toBe(true);
  });
  it.each(['192.0.2.1', '2001:db8::1', 'magnus.example.com', '127.example.com'])('does not treat %s as loopback', (address) => {
    expect(isLoopbackAddress(address)).toBe(false);
  });
  it('does not treat a documentation address or an unresolvable name as local', async () => {
    expect(await isLocalAddress('192.0.2.1')).toBe(false);
    expect(await isLocalAddress('no-such-host.invalid')).toBe(false);
    expect(await isLocalAddress('[::1]')).toBe(true);
  });
});
