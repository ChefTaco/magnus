/**
 * Real SSH against a disposable local sshd container: the real app, session manager, host-key
 * checks and ssh2 client. Only the Magnus API and the identity service are doubles. Run it with
 * `npm run test:ssh -w @hivemagnus/magnus-fleet-gateway`. It needs Docker.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { utils } from 'ssh2';
import { OATHWEAVE_STREAM_RECHECK_MS } from '@hivemagnus/magnus-oathweave';
import { BOB, identityService, LINKS, mint, ORIGIN, type TokenOptions } from '../test/support.js';
import { createApp } from './app.js';
import { createAuditor, createRefusalAuditor } from './audit.js';
import { createAuthorizer } from './authorize.js';
import { createConnect } from './connect.js';
import type { AuditEvent, ControlApi, NodeRecord } from './control-api.js';
import { approveNewNode, createKnownHosts, removeNode, rotateKey } from './known-hosts.js';
import { createResourceParticipant, type ParticipantRequest } from './participant.js';
import { createSessionManager } from './sessions.js';
import { loadSshIdentity, scanHostKey, sshConnector } from './ssh.js';

const NAME = `magnus-fleet-gateway-sshd-${randomBytes(4).toString('hex')}`;
const IMAGE = `${NAME}:test`;
const NODE = 'sshd-fixture';
const USER = 'deploy';
const WRONG_NODE = 'sshd-unapproved';

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

const DOCKERFILE = `FROM alpine:3.21
RUN apk add --no-cache openssh-server && adduser -D -s /bin/sh ${USER} && passwd -u ${USER} && mkdir -p /home/${USER}/.ssh && ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key
RUN printf 'HostKey /etc/ssh/ssh_host_ed25519_key\\nPasswordAuthentication no\\nPermitRootLogin no\\nAllowTcpForwarding no\\nX11Forwarding no\\n' > /etc/ssh/sshd_config
CMD ["/usr/sbin/sshd", "-D", "-e"]
`;

let directory: string;
let knownHosts: string;
let address: string;
let fingerprint: string;
let base: string;
let server: ServerType;
let revoked: Set<string>;
let sessions: ReturnType<typeof createSessionManager>;
const audits: AuditEvent[] = [];
const logLines: string[] = [];
const inventory = new Map<string, NodeRecord>();
const work: Array<{ path: string; body: Record<string, unknown> }> = [];

const hostKey = () => docker('exec', NAME, 'ssh-keygen', '-lf', '/etc/ssh/ssh_host_ed25519_key.pub').split(/\s+/)[1]!;

async function waitForSshd(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      fingerprint = await scanHostKey(address, 22, USER);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error('sshd did not start');
}

const approve = (key: string) => approveNewNode(knownHosts, NODE, address, 22, { fingerprint: key, approvedBy: 'admin', approvalRef: 'test-1', approvedAt: new Date().toISOString() });

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'fleet-gateway-ssh-'));
  writeFileSync(join(directory, 'Dockerfile'), DOCKERFILE);
  docker('build', '-q', '-t', IMAGE, directory);
  docker('run', '-d', '--rm', '--name', NAME, IMAGE);
  address = docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', NAME);

  const keys = utils.generateKeyPairSync('ed25519');
  const keyPath = join(directory, 'gateway-key');
  writeFileSync(keyPath, keys.private, { mode: 0o400 });
  writeFileSync(join(directory, 'authorized_keys'), `${keys.public}\n`);
  docker('cp', join(directory, 'authorized_keys'), `${NAME}:/home/${USER}/.ssh/authorized_keys`);
  docker('exec', NAME, 'sh', '-c', `chown -R ${USER}:${USER} /home/${USER}/.ssh && chmod 700 /home/${USER}/.ssh && chmod 600 /home/${USER}/.ssh/authorized_keys`);
  await waitForSshd();

  const trustDirectory = join(directory, 'known-hosts');
  mkdirSync(trustDirectory, { mode: 0o700 });
  chmodSync(trustDirectory, 0o700);
  knownHosts = join(trustDirectory, 'known-hosts.json');

  inventory.set(NODE, { nodeId: NODE, hostname: address, ipAddress: address, status: 'ONLINE' });
  inventory.set(WRONG_NODE, { nodeId: WRONG_NODE, hostname: address, ipAddress: address, status: 'ONLINE' });

  const participantRequest: ParticipantRequest = async (path, body) => {
    const input = body as Record<string, unknown>;
    work.push({ path, body: input });
    if (path === '/work/reserve') return { ...input, participant: 'dashboard', nodeId: NODE, nodeFqdn: address, state: 'reserved', epoch: 0, barrierId: null, requestSha256: 'b'.repeat(64), fence: '1' };
    if (path.endsWith('/start')) return { ...input, workId: path.split('/')[2], participant: 'dashboard', kind: 'terminal-http', nodeId: NODE, nodeFqdn: address, state: 'running' };
    return { state: 'unknown' };
  };
  const api: ControlApi = {
    resolveNode: async (nodeId) => inventory.get(nodeId) ?? null,
    audit: async (event) => { audits.push(event); },
    participant: participantRequest,
  };
  const identity = identityService();
  revoked = identity.revoked;
  const authorizer = createAuthorizer(identity.verify, LINKS);
  const auditor = createAuditor(api, (line) => logLines.push(line));
  const participant = createResourceParticipant('fixture-resource-participant-secret-32', participantRequest);
  sessions = createSessionManager({
    authorizer,
    auditor,
    limits: {
      idleTimeoutMs: 900_000, maxLifetimeMs: 3_600_000, detachGraceMs: 60_000, recheckMs: OATHWEAVE_STREAM_RECHECK_MS,
      maxPerSubject: 3, maxTotal: 16, maxBufferedBytes: 1024 * 1024, opensPerMinute: 1_000,
    },
    connect: createConnect({ api, knownHosts: createKnownHosts(knownHosts), participant, shell: sshConnector(loadSshIdentity(USER, keyPath)) }),
  });
  const app = createApp({ publicOrigin: ORIGIN, authorizer, sessions, participant, auditRefusal: createRefusalAuditor(auditor) });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  sessions?.shutdown();
  server?.close();
  try { docker('rm', '-f', NAME); } catch { /* it may never have started */ }
  try { docker('rmi', '-f', IMAGE); } catch { /* it may never have been built */ }
  rmSync(directory, { recursive: true, force: true });
});

const call = (path: string, token: string, body: unknown) => fetch(`${base}${path}`, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const open = async (token: string, nodeId = NODE) => call('/terminal/open', token, { nodeId, cols: 100, rows: 30 });

/** Reads a live terminal stream until it holds the expected text. */
class Screen {
  text = '';
  ended: Promise<void>;
  constructor(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    this.ended = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          this.text += decoder.decode(value, { stream: true });
        }
      } catch { /* a refused or errored stream also counts as ended */ }
    })();
  }
  async waitFor(needle: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.text.includes(needle)) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for terminal output');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

/** Ending a session must end the remote login, not just this side's view of it. */
async function expectNoRemoteProcesses(): Promise<void> {
  const remaining = () => docker('exec', NAME, 'sh', '-c', `ps -o user,comm | grep -c '^${USER}' || true`);
  const deadline = Date.now() + 5_000;
  while (remaining() !== '0' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  expect(remaining()).toBe('0');
}

async function shell(options: TokenOptions = {}) {
  const token = await mint(options);
  const response = await open(token);
  expect(response.status).toBe(201);
  const { sessionId } = await response.json() as { sessionId: string };
  const stream = await fetch(`${base}/terminal/stream?sessionId=${sessionId}`, { headers: { authorization: `Bearer ${token}` } });
  expect(stream.status).toBe(200);
  return { token, sessionId, screen: new Screen(stream.body!) };
}

describe('against a real sshd', () => {
  beforeEach(() => {
    audits.length = 0;
    logLines.length = 0;
    work.length = 0;
    removeNode(knownHosts, NODE);
    approve(fingerprint);
  });

  it('the fingerprint matches what the node itself reports, as an operator would compare', () => {
    expect(hostKey()).toBe(fingerprint);
  });

  it('runs a real interactive shell as the configured user with a real PTY', async () => {
    const { token, sessionId, screen } = await shell();
    await call('/terminal/input', token, { sessionId, data: 'echo "ok-$(id -un)-$(tty | cut -c1-8)-$TERM"; stty size\n' });
    await screen.waitFor(`ok-${USER}-/dev/pts-xterm-256color`);
    await screen.waitFor('30 100');
    expect((await call('/terminal/resize', token, { sessionId, cols: 111, rows: 44 })).status).toBe(200);
    await call('/terminal/input', token, { sessionId, data: 'stty size\n' });
    await screen.waitFor('44 111');
    expect((await call('/terminal/close', token, { sessionId })).status).toBe(200);
    await screen.ended;
    expect(work.map((entry) => entry.path.split('/').pop())).toEqual(['reserve', 'start', 'finish']);
  });

  it('a remote exit closes the stream and settles the work', async () => {
    const { token, sessionId, screen } = await shell();
    await call('/terminal/input', token, { sessionId, data: 'exit 3\n' });
    await screen.ended;
    const status = await fetch(`${base}/terminal/status?sessionId=${sessionId}`, { headers: { authorization: `Bearer ${token}` } });
    expect(await status.json()).toEqual({ state: 'ended', reason: 'remote-ended' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(work.at(-1)?.body['disposition']).toBe('remote-ended');
  });

  it('a dropped stream can reattach within the grace, and gets what it missed', async () => {
    const token = await mint();
    const opened = await open(token);
    const { sessionId } = await opened.json() as { sessionId: string };
    const headers = { authorization: `Bearer ${token}` };
    const abort = new AbortController();
    const first = await fetch(`${base}/terminal/stream?sessionId=${sessionId}`, { headers, signal: abort.signal });
    const screen = new Screen(first.body!);
    await screen.waitFor('$');
    abort.abort();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await call('/terminal/input', token, { sessionId, data: 'echo while-away\n' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const second = new Screen((await fetch(`${base}/terminal/stream?sessionId=${sessionId}`, { headers })).body!);
    await second.waitFor('while-away');
    await call('/terminal/close', token, { sessionId });
    await second.ended;
  });

  it('refuses a node with no approved key without connecting', async () => {
    const response = await open(await mint(), WRONG_NODE);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'HOST_KEY_UNTRUSTED' });
    expect(work).toEqual([]);
  });

  it('refuses a changed host key, and the fingerprint rotates only by explicit approval', async () => {
    const before = fingerprint;
    docker('exec', NAME, 'sh', '-c', 'rm -f /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub && ssh-keygen -q -t ed25519 -N "" -f /etc/ssh/ssh_host_ed25519_key && kill -HUP 1');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await waitForSshd();
    expect(fingerprint).not.toBe(before);
    expect(hostKey()).toBe(fingerprint);

    const stale = readFileSync(knownHosts, 'utf8');
    const refused = await open(await mint());
    expect(refused.status).toBe(409);
    const body = await refused.json() as { error: string; message: string };
    expect(body.error).toBe('HOST_KEY_CHANGED');
    expect(JSON.stringify(body)).not.toContain(fingerprint);
    // Nothing is learned from the connection.
    expect(readFileSync(knownHosts, 'utf8')).toBe(stale);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(audits.at(-1)).toMatchObject({ action: 'terminal.session.refuse', outcome: 'HOST_KEY_CHANGED', fingerprint });

    rotateKey(knownHosts, NODE, before, { fingerprint, approvedBy: 'admin', approvalRef: 'test-2', approvedAt: new Date().toISOString() });
    const token = await mint();
    const approved = await open(token);
    expect(approved.status).toBe(201);
    const { sessionId } = await approved.json() as { sessionId: string };
    expect((await call('/terminal/close', token, { sessionId })).status).toBe(200);
    await expectNoRemoteProcesses();
  });

  it('ends a live session within the revocation window, the moment logout takes effect', async () => {
    const sessionId = `oath-revocation-${randomBytes(4).toString('hex')}`;
    const { token, sessionId: id, screen } = await shell({ sessionId, lifetime: 800 });
    await call('/terminal/input', token, { sessionId: id, data: 'echo alive\n' });
    await screen.waitFor('alive');
    const startedAt = Date.now();
    revoked.add(sessionId);
    await screen.ended;
    const elapsed = Date.now() - startedAt;
    // 10 s of cached session answer plus the 5 s re-check.
    expect(elapsed).toBeLessThanOrEqual(15_500);
    expect((await call('/terminal/input', token, { sessionId: id, data: 'echo after\n' })).status).toBe(401);
    await expectNoRemoteProcesses();
    expect(audits.find((event) => event.action === 'terminal.session.close' && event.sessionId === id)).toMatchObject({ outcome: 'token-revoked' });
  }, 30_000);

  it('ends a live session when its token expires', async () => {
    const { sessionId, screen } = await shell({ sessionId: `oath-expiry-${randomBytes(4).toString('hex')}`, lifetime: 3 });
    await screen.ended;
    expect(audits.find((event) => event.action === 'terminal.session.close' && event.sessionId === sessionId)).toMatchObject({ outcome: 'token-expired' });
  }, 30_000);

  it('refuses a second subject on every verb, leaving the shell untouched', async () => {
    const { token, sessionId, screen } = await shell({ sessionId: `oath-owner-${randomBytes(4).toString('hex')}` });
    const bob = await mint({ subject: BOB });
    const headers = { authorization: `Bearer ${bob}` };
    expect((await fetch(`${base}/terminal/stream?sessionId=${sessionId}`, { headers })).status).toBe(404);
    expect((await call('/terminal/input', bob, { sessionId, data: 'touch /tmp/bob-was-here\n' })).status).toBe(404);
    expect((await call('/terminal/resize', bob, { sessionId, cols: 10, rows: 10 })).status).toBe(404);
    expect((await call('/terminal/close', bob, { sessionId })).status).toBe(404);
    await call('/terminal/input', token, { sessionId, data: 'echo "owner-$(stty size)-$(test -e /tmp/bob-was-here && echo bad || echo clean)"\n' });
    await screen.waitFor('owner-30 100-clean');
    await call('/terminal/close', token, { sessionId });
    await screen.ended;
  });

  it('never writes terminal input, output or tokens to the audit or logs', async () => {
    const secret = `fixture-secret-${randomBytes(6).toString('hex')}`;
    const { token, sessionId, screen } = await shell({ sessionId: `oath-audit-${randomBytes(4).toString('hex')}` });
    await call('/terminal/input', token, { sessionId, data: `echo ${secret}\n` });
    await screen.waitFor(secret);
    await call('/terminal/close', token, { sessionId });
    await screen.ended;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const recorded = JSON.stringify(audits) + logLines.join('\n');
    expect(recorded).toContain('terminal.session.open');
    expect(recorded).toContain('terminal.session.close');
    expect(recorded).not.toContain(secret);
    expect(recorded).not.toContain(token);
  });

  it('the SSH key never reaches a client or a record', async () => {
    const key = readFileSync(join(directory, 'gateway-key'), 'utf8').split('\n')[1]!;
    const { token, sessionId, screen } = await shell({ sessionId: `oath-key-${randomBytes(4).toString('hex')}` });
    await call('/terminal/close', token, { sessionId });
    await screen.ended;
    expect(JSON.stringify(audits) + logLines.join('\n') + screen.text).not.toContain(key);
  });
});
