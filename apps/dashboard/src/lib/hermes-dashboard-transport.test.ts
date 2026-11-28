import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBoundedMessageQueue, createWebSocketBackpressureController, resolveHermesDashboardForwardTarget } from '../../runtime-hermes-security.mjs';
import { FRAME_TOKEN_PLACEHOLDER, resetFrameState, frameSessionState, peekFrameSessionState, swapFrameToken } from '../../runtime-embed-isolation.mjs';
const fixture = vi.hoisted(() => ({ begin: vi.fn(), finish: vi.fn(), approved: vi.fn(), clients: [] as any[], requests: [] as any[] }));
vi.mock('../../runtime-resource-participant.mjs', async original => ({ ...(await original<any>()), beginManagedSshWork: fixture.begin }));
vi.mock('../../runtime-dashboard-credentials.mjs', () => ({ resolveDashboardSshCredentials: () => ({ username: 'fixture', password: 'fixture' }) }));
vi.mock('../../runtime-host-key.mjs', () => ({ createSshHostVerifier: () => () => true }));
vi.mock('../../runtime-hermes-security-events.mjs', () => ({ recordHermesSecurityEvent: vi.fn() }));
vi.mock('../../runtime-hermes-security.mjs', async original => ({ ...(await original<any>()), resolveApprovedHermesSshTarget: fixture.approved }));
vi.mock('ssh2', () => ({ Client: class extends EventEmitter {
  connect = vi.fn(() => { queueMicrotask(() => this.emit('ready')); return this; });
  end = vi.fn(() => this.emit('close'));
  stream = new EventEmitter();
  forwardOut = vi.fn((_src: string, _srcPort: number, _host: string, _port: number, cb: Function) => cb(null, this.stream));
  constructor() { super(); fixture.clients.push(this); }
} }));
vi.mock('node:http', () => ({ request: (options: any, callback: Function) => {
  fixture.requests.push(options);
  const response = Object.assign(new EventEmitter(), { statusCode: 200, statusMessage: 'OK', headers: {} });
  return Object.assign(new EventEmitter(), { end: () => { callback(response); queueMicrotask(() => { response.emit('data', Buffer.from('fixture')); response.emit('end'); }); }, write: vi.fn(), destroy: vi.fn() });
} }));
import { requestHermesDashboardOverSsh } from './hermes-ssh-proxy';
import { parseRequestTarget, rejectUpgrade } from '../../runtime-upgrade.mjs';
const installation = { id: 'installation-fixture', nodeId: 'node-fixture', hostname: 'node-1.example.com', sshPort: 22, dashboardHost: '192.0.2.69', dashboardPort: 9119 };
const approved = { address: '192.0.2.69', authorization: { installationId: installation.id, nodeId: installation.nodeId, addresses: ['192.0.2.69'], hostKeySha256: ['SHA256:fixture'] } };
beforeEach(() => { fixture.clients.length = 0; fixture.requests.length = 0; fixture.begin.mockReset().mockResolvedValue({ workId: 'fixture', finish: fixture.finish }); fixture.finish.mockReset().mockResolvedValue({ state: 'unknown' }); fixture.approved.mockReset().mockResolvedValue(approved); });
const tick = () => new Promise(resolve => setImmediate(resolve));

// Load exact production bridge functions without evaluating server bootstrap
// (which reads production certs and opens listeners). All bridge control flow,
// resolver invocation, admission ordering and forwardOut calls remain native.
class FakeSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  close = vi.fn((code?: number) => { this.readyState = 3; this.emit('close', code); });
  send = vi.fn();
  constructor(public url = '') { super(); }
}
type FixtureOptions = { frame?: boolean; grant?: boolean; origin?: string; open?: boolean; alive?: () => Promise<boolean>; path?: string };
function websocketFixture(selected: typeof installation, enabled = true, options: FixtureOptions = {}) {
  const path = new URL('../../server-tls.mjs', import.meta.url);
  const text = readFileSync(path, 'utf8');
  const ast = ts.createSourceFile(path.pathname, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = ['openHermesDashboardTunnel', 'attachHermesWebSocketBridge'];
  const source = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? '')).map(node => node.getText(ast)).join('\n');
  if (source.length < 100) throw Error('production bridge functions missing');
  const stream = new EventEmitter();
  const ssh = Object.assign(new EventEmitter(), { forwardOut: vi.fn((_a, _b, _host, _port, cb) => cb(null, stream)), end: vi.fn() });
  const client = new FakeSocket();
  const upstreams: FakeSocket[] = [];
  const upgraded = vi.fn((_req, _socket, _head, done: (client: FakeSocket) => void) => { if (options.open) done(client); });
  const connect = vi.fn(async () => ssh);
  const bindings = {
    parseRequestTarget, rejectUpgrade,
    randomUUID: () => 'fixture', websocketPathFor: () => options.path ?? '/ws', isHermesUpgradeNamespace: () => true, isHermesWebSocketUpgrade: () => true,
    cookieHeaderAllowed: () => true, websocketOriginAllowed: (origin: string | undefined) => origin === 'https://fixture', websocketAllowedOrigins: 'https://fixture',
    hermesFrameFor: () => (options.frame ?? true) ? { app: 'hermes', grant: 'fixture-grant', upstreamPath: '/ws' } : null,
    verifyFrameGrant: async (grant: string) => (options.grant ?? true) && grant === 'fixture-grant'
      ? { app: 'hermes', installationId: selected.id, username: 'admin', sessionId: 'session-fixture' } : null,
    frameSessionAlive: options.alive ?? (async () => true), FRAME_SESSION_RECHECK_MS: 5, peekFrameSessionState, swapFrameToken,
    createBoundedMessageQueue, createWebSocketBackpressureController,
    WebSocket: class extends FakeSocket { constructor(url: string) { super(url); upstreams.push(this); } },
    setInterval, clearInterval,
    recordHermesSecurityEvent: vi.fn(), resolveHermesInstallation: async () => ({ installation: selected }),
    resolveApprovedHermesSshTarget: fixture.approved, resolveHermesDashboardForwardTarget,
    beginManagedSshWork: fixture.begin, observeManagedSshEnd: vi.fn(), connectSsh: connect,
    hermesWss: { handleUpgrade: upgraded }, hermesEnabled: () => enabled, console: { warn: vi.fn(), error: vi.fn() },
  };
  const attach = new Function(...Object.keys(bindings), `${source}\nreturn attachHermesWebSocketBridge;`)(...Object.values(bindings));
  const server = new EventEmitter(); attach(server);
  const socket = { destroyed: false, write: vi.fn(), destroy: vi.fn() };
  server.emit('upgrade', { headers: { origin: options.origin ?? 'null' }, url: '/api/hermes/dashboard/_frame/fixture-grant/ws' }, socket, Buffer.alloc(0));
  return { ssh, stream, socket, connect, upgraded, client, upstreams };
}
describe('actual Hermes HTTP/WebSocket forwarding selection', () => {
  it('WebSocket bridge refuses upgrades while the Hermes integration is disabled', async () => {
    const ws = websocketFixture(installation, false); await tick();
    expect(ws.socket.write).toHaveBeenCalledWith(expect.stringContaining('503 Service Unavailable'));
    expect(ws.connect).not.toHaveBeenCalled();
    expect(fixture.begin).not.toHaveBeenCalled();
  });
  it('WebSocket bridge needs a valid frame grant, never a console cookie', async () => {
    for (const options of [{ frame: false }, { grant: false }]) {
      const ws = websocketFixture(installation, true, options); await tick();
      expect(ws.socket.write).toHaveBeenCalledWith(expect.stringContaining('401 Unauthorized'));
      expect(ws.connect).not.toHaveBeenCalled();
      expect(ws.upgraded).not.toHaveBeenCalled();
    }
  });
  it('WebSocket bridge accepts the sandboxed page (Origin: null) and configured origins only', async () => {
    const foreign = websocketFixture(installation, true, { origin: 'https://evil.example.com' }); await tick();
    expect(foreign.socket.write).toHaveBeenCalledWith(expect.stringContaining('403 Forbidden'));
    expect(foreign.connect).not.toHaveBeenCalled();
    const configured = websocketFixture(installation, true, { origin: 'https://fixture' }); await tick();
    expect(configured.upgraded).toHaveBeenCalledOnce();
  });
  it('WebSocket bridge closes an open socket once its console session ends', async () => {
    let alive = true;
    const ws = websocketFixture(installation, true, { open: true, alive: async () => alive });
    await vi.waitFor(() => expect(ws.upgraded).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(ws.client.close).not.toHaveBeenCalled();
    alive = false;
    await vi.waitFor(() => expect(ws.client.close).toHaveBeenCalledWith(1008, 'Console session ended'));
    expect(ws.upstreams[0]!.close).toHaveBeenCalled();
  });
  it('WebSocket bridge closes the socket when the session cannot be verified twice running', async () => {
    const ws = websocketFixture(installation, true, { open: true, alive: async () => { throw new Error('store down'); } });
    await vi.waitFor(() => expect(ws.client.close).toHaveBeenCalledWith(1011, 'Console session unverifiable'));
  });
  it('WebSocket bridge sends the real dashboard token upstream, never the placeholder', async () => {
    resetFrameState();
    frameSessionState({ sessionId: 'session-fixture', username: 'admin', sessionExpiresAt: Math.floor(Date.now() / 1000) + 600 }).hermesTokens.set(installation.id, 'real-token');
    const ws = websocketFixture(installation, true, { open: true, path: `/api/pty?token=${FRAME_TOKEN_PLACEHOLDER}&cols=80` });
    await vi.waitFor(() => expect(ws.upstreams).toHaveLength(1));
    expect(ws.upstreams[0]!.url).toBe('ws://127.0.0.1:9119/api/pty?token=real-token&cols=80');
    ws.client.close(1000);
    resetFrameState();
  });
  it('HTTP forwards to approved observed private listener after durable admission', async () => {
    const response = await requestHermesDashboardOverSsh({ installation: installation as any, req: { headers: new Headers(), nextUrl: { protocol: 'https:' }, method: 'GET' } as any, upstreamPath: '/', search: '' });
    expect(response.status).toBe(200);
    expect(fixture.begin).toHaveBeenCalledWith('node-1.example.com', 'hermes-http');
    expect(fixture.clients[0].forwardOut).toHaveBeenCalledWith('127.0.0.1', 0, '192.0.2.69', 9119, expect.any(Function));
    expect(fixture.requests[0].createConnection()).toBe(fixture.clients[0].stream);
  });
  it('HTTP rejects foreign inventory before reserving or opening SSH', async () => {
    await expect(requestHermesDashboardOverSsh({ installation: { ...installation, dashboardHost: 'other.example' } as any, req: {} as any, upstreamPath: '/', search: '' })).rejects.toThrow('destination denied');
    expect(fixture.begin).not.toHaveBeenCalled(); expect(fixture.clients).toHaveLength(0);
  });
  it('WebSocket bridge forwards actual tunnel to same approved observed listener', async () => {
    const ws = websocketFixture(installation); await tick();
    expect(fixture.begin).toHaveBeenCalledWith('node-1.example.com', 'hermes-ws');
    expect(ws.connect).toHaveBeenCalledWith(installation, approved.address, approved.authorization, 'fixture');
    expect(ws.ssh.forwardOut).toHaveBeenCalledWith('127.0.0.1', 0, '192.0.2.69', 9119, expect.any(Function));
    expect(ws.upgraded).toHaveBeenCalledOnce();
  });
  it('WebSocket rejects foreign inventory before reservation/connect/upgrade', async () => {
    const ws = websocketFixture({ ...installation, dashboardHost: '192.0.2.70' }); await tick();
    expect(fixture.begin).not.toHaveBeenCalled(); expect(ws.connect).not.toHaveBeenCalled(); expect(ws.upgraded).not.toHaveBeenCalled();
    expect(ws.socket.write).toHaveBeenCalledWith(expect.stringContaining('403 Forbidden'));
  });
});
