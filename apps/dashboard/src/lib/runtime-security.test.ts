import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCookieHeader } from '../../runtime-cookie.mjs';
import { createSshHostVerifier } from '../../runtime-host-key.mjs';
import { readDashboardEnvironment, validateDashboardEnvironment } from '../../runtime-environment.mjs';
import {
  chooseHermesInstallation,
  cookieHeaderAllowed,
  controlApiTlsOptions,
  controlApiResponseLimit,
  createBoundedMessageQueue,
  createWebSocketBackpressureController,
  hermesSshAddressAllowed,
  hermesWebsocketPathAllowed,
  normalizeHermesInstallations,
  rawWebSocketDataByteLength,
  loadHermesSshAuthorization,
  readHermesSshTrustInventory,
  resolveApprovedHermesSshTarget,
  resolveHermesDashboardForwardTarget,
  websocketOriginAllowed,
} from '../../runtime-hermes-security.mjs';

describe('standalone runtime security utilities', () => {
  it('keeps valid cookies when another pair has malformed encoding', () => {
    expect(parseCookieHeader('broken=%E0%A4%A; magnus_session=valid')).toEqual(
      new Map([['magnus_session', 'valid']]),
    );
  });

  it('requires an inventory-bound SSH host key and rejects a changed key', () => {
    const expected = `SHA256:${createHash('sha256').update(Buffer.from('first-key')).digest('base64').replace(/=+$/, '')}`;
    const verify = createSshHostVerifier('installation:node', { expectedFingerprints: [expected] });
    expect(verify(Buffer.from('first-key'))).toBe(true);
    expect(verify(Buffer.from('first-key'))).toBe(true);
    expect(verify(Buffer.from('changed-key'))).toBe(false);
    expect(() => createSshHostVerifier('installation:node', { expectedFingerprints: [] })).toThrow('required');
  });

  it('allows only active and unexpired overlap keys from version-two inventory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hermes-trust-'));
    const file = join(directory, 'authorizations.json');
    const active = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const overlap = 'SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const expired = 'SHA256:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
    writeFileSync(file, JSON.stringify({
      version: 2,
      generatedAt: '2026-07-28T00:00:00.000Z',
      installations: {
        installation: {
          nodeId: 'node',
          hostname: 'node.example',
          addresses: ['192.0.2.10'],
          keys: [
            { fingerprint: active, state: 'active', firstSeenAt: '2026-07-28T00:00:00.000Z' },
            { fingerprint: overlap, state: 'overlap', expiresAt: '2026-07-30T00:00:00.000Z' },
            { fingerprint: expired, state: 'overlap', expiresAt: '2026-07-28T12:00:00.000Z' },
          ],
        },
      },
    }), { mode: 0o600 });
    const installation = { id: 'installation', nodeId: 'node' };
    expect(loadHermesSshAuthorization(installation, {
      file,
      now: new Date('2026-07-29T00:00:00.000Z'),
    }).hostKeySha256).toEqual([active, overlap]);
    expect(readHermesSshTrustInventory({
      file,
      now: new Date('2026-07-29T00:00:00.000Z'),
    })[0]).toMatchObject({
      rotationState: 'overlap',
      expectedFingerprints: [active, overlap],
      expiredFingerprints: [expired],
    });
    expect(loadHermesSshAuthorization(installation, {
      file,
      now: new Date('2026-07-31T00:00:00.000Z'),
    }).hostKeySha256).toEqual([active]);
    rmSync(directory, { recursive: true, force: true });
  });

  it('fails closed for invalid explicit selectors and ambiguous defaults', () => {
    const installations = [
      { id: 'one', nodeId: 'node-one', status: 'running', dashboardStatus: 'running' },
      { id: 'two', nodeId: 'node-two', status: 'running', dashboardStatus: 'running' },
    ];
    expect(chooseHermesInstallation(installations, 'missing', null, null).error).toBe('installation_not_found');
    expect(chooseHermesInstallation(installations, null, 'missing', null).error).toBe('node_installation_not_found');
    expect(chooseHermesInstallation(installations, null, null, null).error).toBe('installation_required');
    expect(chooseHermesInstallation(installations, 'two', null, null).installation?.id).toBe('two');
  });

  it('rejects absent and foreign WebSocket origins', () => {
    const allowed = 'https://magnus.example,https://backup.example';
    expect(websocketOriginAllowed(undefined, allowed)).toBe(false);
    expect(websocketOriginAllowed('not a url', allowed)).toBe(false);
    expect(websocketOriginAllowed('https://foreign.example', allowed)).toBe(false);
    expect(websocketOriginAllowed('https://magnus.example', allowed)).toBe(true);
  });

  it('rejects oversized cookie headers before session parsing', () => {
    expect(cookieHeaderAllowed('magnus_session=small')).toBe(true);
    expect(cookieHeaderAllowed(`magnus_session=${'x'.repeat(17 * 1024)}`)).toBe(false);
  });

  it('bounds messages queued before the upstream WebSocket opens', () => {
    const queue = createBoundedMessageQueue(5);
    expect(queue.push(Buffer.from('123'), true)).toBe(true);
    expect(queue.push(Buffer.from('456'), true)).toBe(false);
    const sent: string[] = [];
    queue.flush((data) => { sent.push(Buffer.from(data as Buffer).toString()); });
    expect(sent).toEqual(['123']);
    expect(queue.bytes).toBe(0);
  });

  it('accounts for fragmented binary messages and zero-length frames', () => {
    const fragments = [Buffer.from('12'), Buffer.from('345')];
    expect(rawWebSocketDataByteLength(fragments)).toBe(5);
    expect(rawWebSocketDataByteLength(new Uint8Array([1, 2, 3]))).toBe(3);
    expect(rawWebSocketDataByteLength(new ArrayBuffer(0))).toBe(0);

    const queue = createBoundedMessageQueue(5);
    expect(queue.push([], true)).toBe(true);
    expect(queue.bytes).toBe(0);
    expect(queue.push(fragments, true)).toBe(true);
    expect(queue.bytes).toBe(5);
    expect(queue.push([Buffer.alloc(0), Buffer.from('x')], true)).toBe(false);
  });

  it('intercepts only known Hermes WebSocket endpoints', () => {
    expect(hermesWebsocketPathAllowed('/api/pty')).toBe(true);
    expect(hermesWebsocketPathAllowed('/api/console')).toBe(true);
    expect(hermesWebsocketPathAllowed('/api/events')).toBe(true);
    expect(hermesWebsocketPathAllowed('/api/ws')).toBe(true);
    expect(hermesWebsocketPathAllowed('/ws')).toBe(true);
    expect(hermesWebsocketPathAllowed('/api/pty/extra')).toBe(false);
    expect(hermesWebsocketPathAllowed('/unknown')).toBe(false);
  });

  it('allows approved inventory networks and rejects dangerous or public destinations', async () => {
    expect(() => hermesSshAddressAllowed('192.0.2.10')).toThrow('explicitly configured');
    expect(hermesSshAddressAllowed('192.0.2.10', ['192.0.2.10/32'])).toBe(true);
    expect(hermesSshAddressAllowed('10.10.0.2', ['10.10.0.0/24'])).toBe(true);
    expect(hermesSshAddressAllowed('127.0.0.1', ['0.0.0.0/0'])).toBe(false);
    expect(hermesSshAddressAllowed('169.254.169.254', ['0.0.0.0/0'])).toBe(false);
    expect(hermesSshAddressAllowed('8.8.8.8', ['192.0.2.10/32'])).toBe(false);

    const installation = { id: 'installation-1', nodeId: 'node-1', hostname: 'node.example' };
    const authorization = { installationId: 'installation-1', nodeId: 'node-1', addresses: ['192.0.2.10'], hostKeySha256: ['SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'] };
    await expect(resolveApprovedHermesSshTarget(installation, {
      resolver: async () => [{ address: '192.0.2.10' }, { address: '8.8.8.8' }],
      authorization,
    })).rejects.toThrow('unauthorized addresses');
    await expect(resolveApprovedHermesSshTarget(installation, {
      resolver: async () => [{ address: '192.0.2.10' }],
      authorization,
    })).resolves.toMatchObject({ address: '192.0.2.10', addresses: ['192.0.2.10'], authorization });
  });

  it('forwards a private-network dashboard only to its already approved SSH destination', () => {
    const installation = { id: 'installation-2', nodeId: 'node-2', dashboardHost: '192.0.2.69', dashboardPort: 9119 };
    const target = { address: '192.0.2.69', authorization: { installationId: installation.id,
      nodeId: installation.nodeId, addresses: ['192.0.2.69'], hostKeySha256: ['reviewed'] } };
    expect(resolveHermesDashboardForwardTarget(installation, target)).toEqual({ address: target.address, port: 9119 });
    for (const dashboardHost of ['localhost', '127.0.0.1', '0.0.0.0', '']) {
      expect(resolveHermesDashboardForwardTarget({ ...installation, dashboardHost }, target)).toEqual({ address: '127.0.0.1', port: 9119 });
    }
    for (const dashboardHost of ['::', '::1']) {
      expect(resolveHermesDashboardForwardTarget({ ...installation, dashboardHost }, target)).toEqual({ address: '::1', port: 9119 });
    }
  });

  it('rejects inventory tunnel redirection, even to another approved address', () => {
    const installation = { id: 'installation', nodeId: 'node', dashboardHost: '192.0.2.10', dashboardPort: 9119 };
    const target = { address: '192.0.2.10', authorization: { installationId: installation.id,
      nodeId: installation.nodeId, addresses: ['192.0.2.10', '192.0.2.11'], hostKeySha256: ['reviewed'] } };
    for (const dashboardHost of ['other.example', 'node.example', '192.0.2.11', '169.254.169.254',
      '8.8.8.8', 'http://192.0.2.10', '127.0.0.2', '::ffff:127.0.0.1']) {
      expect(() => resolveHermesDashboardForwardTarget({ ...installation, dashboardHost }, target)).toThrow('listener');
    }
    expect(() => resolveHermesDashboardForwardTarget({ ...installation, dashboardPort: 0 }, target)).toThrow('port');
    expect(() => resolveHermesDashboardForwardTarget({ ...installation, nodeId: 'foreign' }, target)).toThrow('approved installation');
    expect(() => resolveHermesDashboardForwardTarget(installation, { ...target, address: '127.0.0.1' })).toThrow('approved installation');
  });

  it('keeps the local DNS self-route denied without creating a second SSH selector', async () => {
    const installation = { id: 'installation-3', nodeId: 'node-3', hostname: 'magnus.example.com' };
    const authorization = { installationId: installation.id, nodeId: installation.nodeId,
      addresses: ['192.0.2.74'], hostKeySha256: ['reviewed'] };
    await expect(resolveApprovedHermesSshTarget(installation, { authorization,
      resolver: async () => [{ address: '127.0.0.1' }],
    })).rejects.toThrow('unauthorized addresses');
  });

  it('bounds both post-connection directions and closes sustained pressure', () => {
    let time = 1_000;
    const controller = createWebSocketBackpressureController({ highWaterMark: 10, maxQueueBytes: 8, maxPressureMs: 100, now: () => time });
    expect(controller.push(Buffer.from('1234'), true)).toBe(true);
    expect(controller.drain(() => undefined, () => 11)).toMatchObject({ pending: true, close: false, peakBytes: 15 });
    time += 101;
    expect(controller.drain(() => undefined, () => 11)).toMatchObject({ pending: true, close: true, durationMs: 101 });
    expect(controller.push(Buffer.from('56789'), true)).toBe(false);
  });

  it('uses certificate verification and validates installation endpoints', () => {
    expect(controlApiTlsOptions({})).toEqual({ rejectUnauthorized: true });
    expect(normalizeHermesInstallations([
      { id: 'ok', nodeId: 'registered-node', hostname: 'node.example', sshPort: 22, dashboardPort: 9119 },
      { id: 'unregistered', nodeId: null, hostname: 'node.example', sshPort: 22, dashboardPort: 9119 },
      { id: 'bad-host', nodeId: 'registered-node', hostname: 'node/command', sshPort: 22, dashboardPort: 9119 },
      { id: 'bad-port', nodeId: 'registered-node', hostname: 'node.example', sshPort: 70000, dashboardPort: 9119 },
    ])).toHaveLength(1);
  });

  it('parses security-sensitive dashboard configuration from the canonical schema', () => {
    expect(readDashboardEnvironment('SESSION_ISSUER', {})).toBe('magnus-dashboard');
    expect(readDashboardEnvironment('DASHBOARD_PUBLIC_ORIGIN', {
      DASHBOARD_PUBLIC_ORIGIN: 'https://magnus.example/',
    })).toBe('https://magnus.example');
    expect(controlApiResponseLimit({ CONTROL_API_MAX_RESPONSE_BYTES: '4096' })).toBe(4096);
    expect(() => controlApiResponseLimit({ CONTROL_API_MAX_RESPONSE_BYTES: '1023' })).toThrow('at least 1024');
    expect(() => validateDashboardEnvironment({
      API_SECRET: 'api-secret',
      CONTROL_NODE_CREDENTIAL_KEY: 'dedicated-control-node-key-32-chars',
      SESSION_SECRET: 'session-secret',
      DASHBOARD_PUBLIC_ORIGIN: 'not-a-url',
    })).toThrow('absolute URL');
  });
});
