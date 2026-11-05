import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clock, FINGERPRINT, harness, mint, NODE, NODE_HOST, post, type Harness } from '../test/support.js';
import { GatewayError } from './errors.js';
import { approveNewNode, createKnownHosts, hostKeyFingerprint, listNodes, removeNode, rotateKey } from './known-hosts.js';
import { ParticipantRefused } from './control-api.js';
import { isRefusedAddress, isUsableHostSyntax } from './target.js';

let h: Harness;
beforeEach(() => { clock.offset = 0; h = harness(); });
afterEach(() => h.dispose());
const open = async (nodeId = NODE) => post(h.app, '/terminal/open', await mint(), { nodeId });
const codeOf = async (response: Response) => (await response.json() as { error: string }).error;

describe('node resolution', () => {
  it('refuses a node the API does not know', async () => {
    const response = await open('node-unknown');
    expect(response.status).toBe(404);
    expect(await codeOf(response)).toBe('NODE_NOT_FOUND');
    expect(h.calls).toEqual(['resolve']);
  });

  it('refuses a node with no approved host key, before any admission or SSH', async () => {
    h.inventory.set('node-2', { nodeId: 'node-2', hostname: 'node-2.example.com', ipAddress: '10.0.0.6', status: 'ONLINE' });
    const response = await open('node-2');
    expect(await codeOf(response)).toBe('HOST_KEY_UNTRUSTED');
    expect(h.calls).toEqual(['resolve']);
  });

  it('does not mistake an Object.prototype name for an approved node', async () => {
    h.inventory.set('constructor', { nodeId: 'constructor', hostname: 'x.example.com', ipAddress: '10.0.0.6', status: 'ONLINE' });
    expect(await codeOf(await open('constructor'))).toBe('HOST_KEY_UNTRUSTED');
  });

  it('refuses when the inventory no longer names the approved host', async () => {
    h.inventory.set(NODE, { nodeId: NODE, hostname: 'attacker.example.com', ipAddress: '203.0.113.9', status: 'ONLINE' });
    expect(await codeOf(await open())).toBe('NODE_TARGET_CHANGED');
    expect(h.calls).toEqual(['resolve']);
  });

  it('refuses a decommissioned node and an API answer about another node', async () => {
    h.inventory.set(NODE, { nodeId: NODE, hostname: NODE_HOST, ipAddress: '10.0.0.5', status: 'DECOMMISSIONED' });
    expect(await codeOf(await open())).toBe('NODE_TARGET_REFUSED');
    h.inventory.set(NODE, { nodeId: 'node-9', hostname: NODE_HOST, ipAddress: '10.0.0.5', status: 'ONLINE' });
    expect(await codeOf(await open())).toBe('NODE_TARGET_REFUSED');
  });

  it.each(['127.0.0.1', '169.254.169.254', '0.0.0.0', '::1', '::', 'fe80::1', 'fe80::1%eth0', '10.0.0.5%eth0', '::127.0.0.1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '64:ff9b::7f00:1', '2002:7f00:1::', '224.0.0.1', '255.255.255.255', '100.100.100.200', '168.63.129.16', 'fd00:ec2::254', 'not-an-address', ''])(
    'never dials %s', (address) => expect(isRefusedAddress(address)).toBe(true),
  );

  it.each(['10.0.0.5', '192.168.1.5', '172.16.0.5', '100.64.0.5', '203.0.113.5', '2001:db8::5', 'fd12::5'])(
    'allows the fleet address %s', (address) => expect(isRefusedAddress(address)).toBe(false),
  );

  it.each([[['127.0.0.1']], [['10.0.0.5', '169.254.169.254']], [[]]])('refuses a name resolving to %j', async (addresses) => {
    h.addresses.set(NODE_HOST, addresses);
    expect(await codeOf(await open())).toBe('NODE_TARGET_REFUSED');
    expect(h.calls).toEqual(['resolve']);
  });

  it.each(['localhost', 'LOCALHOST.', 'a.localhost', 'bad_name.example.com', 'bad name', '-leading.example.com', 'x'.repeat(254)])('refuses the unusable host %s even when approved', async (host) => {
    expect(isUsableHostSyntax(host)).toBe(false);
    h.inventory.set(NODE, { nodeId: NODE, hostname: host, ipAddress: '10.0.0.5', status: 'ONLINE' });
    writeFileSync(h.knownHostsFile, JSON.stringify({ version: 1, nodes: [{ nodeId: NODE, trust: { host, port: 22, keys: [{ fingerprint: FINGERPRINT, approvedBy: 'a', approvalRef: 'r', approvedAt: new Date().toISOString() }] } }] }));
    const response = await open();
    expect([409, 503]).toContain(response.status);
    expect(h.calls).not.toContain('shell');
  });

  it('refuses a name that does not resolve', async () => {
    h.addresses.delete(NODE_HOST);
    expect(await codeOf(await open())).toBe('NODE_TARGET_REFUSED');
  });

  it('dials the address it validated, not the name, so DNS cannot change afterwards', async () => {
    h.addresses.set(NODE_HOST, ['192.168.7.7', '192.168.7.8']);
    expect((await open()).status).toBe(201);
    expect(h.targets[0]!.address).toBe('192.168.7.7');
  });
});

describe('admission order', () => {
  it('finishes durable admission before any SSH connection', async () => {
    expect((await open()).status).toBe(201);
    expect(h.calls).toEqual(['resolve', 'participant:reserve', 'participant:start', 'shell']);
  });

  it('reports a refused reservation by its own code and never connects', async () => {
    h.refuseAdmission(new ParticipantRefused('RESOURCE_SSH_UNAVAILABLE'));
    const response = await open();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'RESOURCE_ADMISSION_REFUSED', reason: 'RESOURCE_SSH_UNAVAILABLE' });
    expect(h.shells).toHaveLength(0);
    expect(h.calls).not.toContain('shell');
  });

  it('settles work as unknown when SSH fails after admission, and never leaks why', async () => {
    h.shellError.value = new Error('connect ECONNREFUSED 10.0.0.5:22');
    const response = await open();
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('10.0.0.5');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.calls).toEqual(['resolve', 'participant:reserve', 'participant:start', 'shell', 'participant:finish']);
  });

  it('reports a changed host key with its own code and audits what was presented', async () => {
    const changed = new GatewayError('HOST_KEY_CHANGED');
    changed.observedFingerprint = `SHA256:${'B'.repeat(43)}`;
    h.shellError.value = changed;
    const response = await open();
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text).toContain('HOST_KEY_CHANGED');
    expect(text).not.toContain('BBBB');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.audits.at(-1)).toMatchObject({ action: 'terminal.session.refuse', outcome: 'HOST_KEY_CHANGED', nodeId: NODE, fingerprint: changed.observedFingerprint });
  });
});

describe('host-key store', () => {
  let directory: string;
  let file: string;
  const approval = (fingerprint = FINGERPRINT) => ({ fingerprint, approvedBy: 'admin', approvalRef: 'change-7', approvedAt: new Date().toISOString() });
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'fleet-gateway-store-'));
    mkdirSync(join(directory, 'trust'), { mode: 0o700 });
    file = join(directory, 'trust', 'known-hosts.json');
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  const unavailable = () => {
    expect(() => createKnownHosts(file).lookup(NODE)).toThrowError(expect.objectContaining({ code: 'TRUST_STORE_UNAVAILABLE' }) as Error);
  };

  it('formats a fingerprint as OpenSSH does', () => {
    expect(hostKeyFingerprint(Buffer.from('fixture'))).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it('knows nothing until an operator approves, and a lookup never writes', () => {
    expect(createKnownHosts(file).lookup(NODE)).toBeUndefined();
    expect(listNodes(file)).toEqual([]);
    approveNewNode(file, NODE, NODE_HOST, 22, approval());
    const before = readFileSync(file, 'utf8');
    expect(createKnownHosts(file).lookup(NODE)?.keys[0]?.fingerprint).toBe(FINGERPRINT);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses a second first-trust, so replacing a key is always deliberate', () => {
    approveNewNode(file, NODE, NODE_HOST, 22, approval());
    expect(() => approveNewNode(file, NODE, 'other.example.com', 22, approval())).toThrow('already has an approved');
  });

  it('rotates only a key the operator names exactly', () => {
    approveNewNode(file, NODE, NODE_HOST, 22, approval());
    const next = `SHA256:${'C'.repeat(43)}`;
    expect(() => rotateKey(file, NODE, `SHA256:${'D'.repeat(43)}`, approval(next))).toThrow('not approved');
    rotateKey(file, NODE, FINGERPRINT, approval(next));
    expect(createKnownHosts(file).lookup(NODE)?.keys.map((key) => key.fingerprint)).toEqual([next]);
  });

  it('removes a node', () => {
    approveNewNode(file, NODE, NODE_HOST, 22, approval());
    expect(removeNode(file, NODE)).toBe(true);
    expect(createKnownHosts(file).lookup(NODE)).toBeUndefined();
  });

  it('fails closed on a damaged store', () => {
    approveNewNode(file, NODE, NODE_HOST, 22, approval());
    writeFileSync(file, '{ not json');
    unavailable();
    writeFileSync(file, JSON.stringify({ version: 2, nodes: [] }));
    unavailable();
    writeFileSync(file, JSON.stringify({ version: 1, nodes: [{ nodeId: NODE, trust: { host: 'h', port: 22, keys: [] } }] }));
    unavailable();
  });

  it('fails closed when the store is readable by others', () => {
    approveNewNode(file, NODE, NODE_HOST, 22, approval());
    chmodSync(file, 0o644);
    unavailable();
    chmodSync(file, 0o600);
    chmodSync(join(directory, 'trust'), 0o755);
    unavailable();
  });

  it('fails closed on a symlinked store', () => {
    approveNewNode(file, NODE, NODE_HOST, 22, approval());
    const elsewhere = join(directory, 'trust', 'elsewhere.json');
    writeFileSync(elsewhere, readFileSync(file), { mode: 0o600 });
    rmSync(file);
    symlinkSync(elsewhere, file);
    unavailable();
  });

  it('a damaged store refuses a real open with 503, never connecting', async () => {
    writeFileSync(h.knownHostsFile, 'garbage');
    const response = await open();
    expect(response.status).toBe(503);
    expect(await codeOf(response)).toBe('TRUST_STORE_UNAVAILABLE');
    expect(h.calls).toEqual(['resolve']);
  });
});
