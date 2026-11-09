import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createControlApi, httpsTransport, ParticipantRefused, type ControlApiTransport } from './control-api.js';
import { GatewayError } from './errors.js';
import { createResourceParticipant } from './participant.js';
import { loadSshIdentity } from './ssh.js';

const ISSUER = 'https://identity.example.com';
const env = {
  TLS_CERT_PATH: '/run/tls/server.crt',
  TLS_KEY_PATH: '/run/tls/server.key',
  FLEET_GATEWAY_PUBLIC_ORIGIN: 'https://console.example.com',
  OATHWEAVE_ISSUER: ISSUER,
  OATHWEAVE_JWKS_URL: `${ISSUER}/jwks`,
  OATHWEAVE_USERINFO_URL: `${ISSUER}/userinfo`,
  MAGNUS_OATHWEAVE_IDENTITIES_JSON: JSON.stringify([{ issuer: ISSUER, subject: 'alice', localUserId: 'alice', role: 'ADMIN' }]),
  CONTROL_API_URL: 'https://magnus.example.com:4000',
  FLEET_GATEWAY_API_TOKEN: 'fixture-gateway-api-token-at-least-32-chars',
  RESOURCE_ENROLLMENT_DASHBOARD_SECRET: 'fixture-drain-secret-distinct-at-least-32',
  FLEET_GATEWAY_SSH_USERNAME: 'deploy',
  FLEET_GATEWAY_SSH_PRIVATE_KEY_PATH: '/run/secrets/fleet-gateway-ssh-key',
};

describe('configuration', () => {
  it('applies the documented limits by default', () => {
    expect(loadConfig(env)).toMatchObject({
      FLEET_GATEWAY_PORT: 4310, FLEET_GATEWAY_IDLE_TIMEOUT_SECONDS: 900, FLEET_GATEWAY_MAX_LIFETIME_SECONDS: 3_600,
      FLEET_GATEWAY_MAX_SESSIONS_PER_SUBJECT: 3, FLEET_GATEWAY_MAX_SESSIONS: 32,
    });
  });

  it.each(Object.keys(env))('stops without %s', (name) => {
    const incomplete: Record<string, string | undefined> = { ...env };
    delete incomplete[name];
    expect(() => loadConfig(incomplete)).toThrow(name);
  });

  it('names a bad setting without echoing its value', () => {
    try {
      loadConfig({ ...env, FLEET_GATEWAY_API_TOKEN: 'short-secret-value' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('FLEET_GATEWAY_API_TOKEN');
      expect((error as Error).message).not.toContain('short-secret-value');
    }
  });

  it.each([
    ['plain HTTP to the API', { CONTROL_API_URL: 'http://magnus.example.com:4000' }],
    ['plain HTTP to identity', { OATHWEAVE_JWKS_URL: 'http://identity.example.com/jwks' }],
    ['credentials in a URL', { CONTROL_API_URL: 'https://user:pass@magnus.example.com' }],
    ['a console origin with a path', { FLEET_GATEWAY_PUBLIC_ORIGIN: 'https://console.example.com/fleet' }],
    ['a wildcard origin', { FLEET_GATEWAY_PUBLIC_ORIGIN: '*' }],
    ['one secret for two purposes', { FLEET_GATEWAY_API_TOKEN: env.RESOURCE_ENROLLMENT_DASHBOARD_SECRET }],
    ['a max lifetime above an hour', { FLEET_GATEWAY_MAX_LIFETIME_SECONDS: '3601' }],
    ['an idle timeout of zero', { FLEET_GATEWAY_IDLE_TIMEOUT_SECONDS: '0' }],
    ['a link from another issuer', { MAGNUS_OATHWEAVE_IDENTITIES_JSON: JSON.stringify([{ issuer: 'https://other.example.com', subject: 'a', localUserId: 'a', role: 'ADMIN' }]) }],
    ['unreadable links', { MAGNUS_OATHWEAVE_IDENTITIES_JSON: 'not json' }],
  ])('refuses %s', (_name, change) => {
    expect(() => loadConfig({ ...env, ...change })).toThrow('Invalid configuration');
  });
});

describe('SSH identity', () => {
  let directory: string | undefined;
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });
  const keyFile = (mode: number) => {
    directory = mkdtempSync(join(tmpdir(), 'fleet-gateway-key-'));
    const file = join(directory, 'key');
    // ssh2 key generation strips leading zero public-key bytes, occasionally making an invalid key.
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'fixture', '-f', file]);
    chmodSync(file, mode);
    return file;
  };

  it('loads a private key', () => {
    expect(loadSshIdentity('deploy', keyFile(0o400)).username).toBe('deploy');
  });

  it.each([0o644, 0o604, 0o660])('refuses mode %o', (mode) => {
    expect(() => loadSshIdentity('deploy', keyFile(mode))).toThrow('must not be');
  });

  it('refuses a missing key and something that is not a key', () => {
    expect(() => loadSshIdentity('deploy', '/nonexistent/key')).toThrow();
    directory = mkdtempSync(join(tmpdir(), 'fleet-gateway-key-'));
    const file = join(directory, 'key');
    writeFileSync(file, 'not a key', { mode: 0o400 });
    expect(() => loadSshIdentity('deploy', file)).toThrow('usable');
  });

  it.each(['root; rm -rf /', '-oProxyCommand=sh', 'a b', 'Admin', ''])('refuses the account name %j', (username) => {
    expect(() => loadSshIdentity(username, keyFile(0o400))).toThrow('account name');
  });
});

describe('Magnus API client', () => {
  const answer = (status: number, body: unknown): ControlApiTransport => async () => ({ status, body });
  const api = (send: ControlApiTransport) => createControlApi(send, 'gateway-token', 'drain-key');
  const node = { nodeId: 'n', hostname: 'h.example.com', ipAddress: '10.0.0.1', status: 'ONLINE' };

  it('retries only the read-only target lookup against older strict APIs', async () => {
    const calls: unknown[] = [];
    const node = { nodeId: 'n', hostname: 'node.example.com', ipAddress: '192.0.2.10', status: 'ONLINE' };
    const result = await api(async (_path, _credential, body) => {
      calls.push(body); return calls.length === 1 ? { status: 400, body: {} } : { status: 200, body: { success: true, data: node } };
    }).resolveNode('n');
    expect(result).toEqual(node); expect(calls).toEqual([{ nodeId: 'n', managedTerminalProtocol: 1 }, { nodeId: 'n' }]);
  });

  it('refuses anything but plain verified HTTPS', () => {
    expect(() => httpsTransport('http://magnus.example.com', undefined)).toThrow('HTTPS');
    expect(() => httpsTransport('https://u:p@magnus.example.com', undefined)).toThrow('HTTPS');
  });

  it('uses a fixed path and the gateway credential, negotiating the managed terminal protocol', async () => {
    let seen: unknown[] = [];
    await api(async (...args) => { seen = args; return { status: 200, body: { success: true, data: node } }; }).resolveNode('n');
    expect(seen).toEqual(['/api/v1/fleet-gateway/target', { header: 'x-fleet-gateway-token', value: 'gateway-token' }, { nodeId: 'n', managedTerminalProtocol: 1 }]);
  });

  it('treats 404 as unknown and everything else as unavailable, never as a target', async () => {
    expect(await api(answer(404, null)).resolveNode('n')).toBeNull();
    for (const send of [answer(500, null), answer(302, null), answer(200, { success: true, data: { ...node, extra: 1 } }), answer(200, { success: true }), answer(200, 'no'), async () => { throw new Error('down'); }]) {
      await expect(api(send).resolveNode('n')).rejects.toBeInstanceOf(GatewayError);
    }
  });

  it('keeps only a well-formed upstream refusal code', async () => {
    const refused = async (body: unknown) => { try { await api(answer(409, body)).participant('/work/reserve', {}); } catch (error) { return error as ParticipantRefused; } throw new Error('unreachable'); };
    expect((await refused({ error: { code: 'RESOURCE_DRAIN_REQUIRED' } })).upstreamCode).toBe('RESOURCE_DRAIN_REQUIRED');
    expect((await refused({ error: { code: 'x\r\nSet-Cookie: a=1' } })).upstreamCode).toBeNull();
    expect((await refused('nope')).upstreamCode).toBeNull();
  });
});

describe('resource participant', () => {
  const SECRET = 'fixture-drain-secret-distinct-at-least-32';
  const reservation = (body: Record<string, unknown>, nodeId = 'node-1') => ({ ...body, participant: 'dashboard', nodeId, nodeFqdn: 'h.example.com', state: 'reserved', epoch: 0, barrierId: null, requestSha256: 'b'.repeat(64), fence: '1' });

  it('releases the reservation when the name resolved to another node, and never starts', async () => {
    const paths: string[] = [];
    const finish: unknown[] = [];
    const participant = createResourceParticipant(SECRET, async (path, body) => {
      paths.push(path);
      if (path === '/work/reserve') return reservation(body as Record<string, unknown>, 'node-other');
      finish.push(body);
      return {};
    });
    await expect(participant.begin('h.example.com', 'node-1', 60_000)).rejects.toThrow();
    expect(paths.some((path) => path.endsWith('/start'))).toBe(false);
    expect(finish).toEqual([expect.objectContaining({ disposition: 'not-started' })]);
  });

  it('refuses a reservation that does not bind this exact work', async () => {
    const participant = createResourceParticipant(SECRET, async (_path, body) => ({ ...reservation(body as Record<string, unknown>), fence: 'not-a-fence' }));
    await expect(participant.begin('h.example.com', 'node-1', 60_000)).rejects.toThrow('Invalid managed SSH reservation');
  });

  it('settles once however many closes compete', async () => {
    let finishes = 0;
    const participant = createResourceParticipant(SECRET, async (path, body) => {
      const input = body as Record<string, unknown>;
      if (path === '/work/reserve') return reservation(input);
      if (path.endsWith('/start')) return { ...input, workId: path.split('/')[2], participant: 'dashboard', kind: 'terminal-http', nodeId: 'node-1', nodeFqdn: 'h.example.com', state: 'running' };
      finishes += 1;
      return {};
    });
    const work = await participant.begin('h.example.com', 'node-1', 60_000);
    await Promise.all([work.finish('unknown'), work.finish('remote-ended')]);
    expect(finishes).toBe(1);
  });

  it('never asks for a deadline the API would refuse', async () => {
    let requested = 0;
    const participant = createResourceParticipant(SECRET, async (_path, body) => { requested = (body as { deadline: number }).deadline; throw new Error('stop'); });
    await expect(participant.begin('h.example.com', 'node-1', 3_600_000)).rejects.toThrow('stop');
    expect(requested - Date.now()).toBeLessThanOrEqual(59 * 60_000);
  });
});
