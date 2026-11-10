import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveNewNode } from './known-hosts.js';

/** The built CLI under real Node, because vitest's module loading hides CommonJS import errors. */
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const run = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { PATH: process.env['PATH'], ...env } });

describe('built CLI', () => {
  it('loads and prints usage for an unknown command', () => {
    const result = run(['bogus']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: magnus-fleet-gateway');
  });

  it('refuses to start without configuration, naming settings and no values', () => {
    const secret = 'fixture-short-secret-value';
    const result = run(['start'], { FLEET_GATEWAY_API_TOKEN: secret });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid configuration');
    expect(result.stderr).toContain('FLEET_GATEWAY_API_TOKEN');
    expect(result.stderr).not.toContain(secret);
  });

  it('refuses a scan without a host', () => {
    const result = run(['trust', 'scan']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--host is required');
  });

  it('checks an approver before removing an approval', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fleet-gateway-cli-'));
    try {
      const trust = join(directory, 'trust');
      mkdirSync(trust, { mode: 0o700 });
      const file = join(trust, 'known-hosts.json');
      approveNewNode(file, 'node-1', 'node-1.example.com', 22, { fingerprint: `SHA256:${'A'.repeat(43)}`, approvedBy: 'admin', approvalRef: 'r-1', approvedAt: new Date().toISOString() });
      const before = readFileSync(file, 'utf8');
      const issuer = 'https://identity.example.com';
      const result = run(['trust', 'remove', '--node-id', 'node-1'], {
        TLS_CERT_PATH: '/t', TLS_KEY_PATH: '/t', FLEET_GATEWAY_PUBLIC_ORIGIN: 'https://console.example.com',
        OATHWEAVE_ISSUER: issuer, OATHWEAVE_JWKS_URL: `${issuer}/j`, OATHWEAVE_USERINFO_URL: `${issuer}/u`, MAGNUS_OATHWEAVE_IDENTITIES_JSON: '[]',
        CONTROL_API_URL: 'https://magnus.example.com', FLEET_GATEWAY_API_TOKEN: 'a'.repeat(32), RESOURCE_ENROLLMENT_DASHBOARD_SECRET: 'b'.repeat(32),
        FLEET_GATEWAY_SSH_USERNAME: 'deploy', FLEET_GATEWAY_SSH_PRIVATE_KEY_PATH: '/k', FLEET_GATEWAY_KNOWN_HOSTS_FILE: file,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--approved-by is required');
      expect(readFileSync(file, 'utf8')).toBe(before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});


describe('built healthcheck TLS identity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fleet-gateway-health-'));
  const key = join(directory, 'server.key'), certificate = join(directory, 'server.crt');
  const foreignCertificate = join(directory, 'foreign.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:192.0.2.42'], { stdio: 'ignore' });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'foreign.key'), '-out', foreignCertificate, '-days', '1', '-subj', '/CN=foreign.example.com'], { stdio: 'ignore' });
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (_request, response) => response.end('healthy'));
  let port: number;
  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  async function health(identity: string, ca = certificate): Promise<number | null> {
    const child = spawn(process.execPath, [CLI, 'healthcheck'], {
      env: { PATH: process.env['PATH'], FLEET_GATEWAY_PORT: String(port), FLEET_GATEWAY_TLS_NAME: identity, TLS_CERT_PATH: ca },
      stdio: 'ignore',
    });
    return new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  }
  for (const identity of ['localhost', '192.0.2.42']) {
    it(`accepts a trusted ${identity} certificate over loopback`, async () => {
      expect(await health(identity)).toBe(0);
    });
  }
  for (const identity of ['wrong.example.com', '192.0.2.43']) {
    it(`refuses a certificate that does not match ${identity}`, async () => {
      expect(await health(identity)).toBe(1);
    });
  }
  it('refuses an untrusted CA for an IP identity', async () => {
    expect(await health('192.0.2.42', foreignCertificate)).toBe(1);
  });
});
