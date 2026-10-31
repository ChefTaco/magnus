import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveHermesDashboardForwardTarget } from '../../runtime-hermes-security.mjs';
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
const installation = { id: 'installation-fixture', nodeId: 'node-fixture', hostname: 'node-1.example.com', sshPort: 22, dashboardHost: '192.0.2.69', dashboardPort: 9119 };
const approved = { address: '192.0.2.69', authorization: { installationId: installation.id, nodeId: installation.nodeId, addresses: ['192.0.2.69'], hostKeySha256: ['SHA256:fixture'] } };
beforeEach(() => { fixture.clients.length = 0; fixture.requests.length = 0; fixture.begin.mockReset().mockResolvedValue({ workId: 'fixture', finish: fixture.finish }); fixture.finish.mockReset().mockResolvedValue({ state: 'unknown' }); fixture.approved.mockReset().mockResolvedValue(approved); });
const tick = () => new Promise(resolve => setImmediate(resolve));

// Load exact production bridge functions without evaluating server bootstrap
// (which reads production certs and opens listeners). All bridge control flow,
// resolver invocation, admission ordering and forwardOut calls remain native.
function websocketFixture(selected: typeof installation, enabled = true) {
  const path = new URL('../../server-tls.mjs', import.meta.url);
  const text = readFileSync(path, 'utf8');
  const ast = ts.createSourceFile(path.pathname, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = ['openHermesDashboardTunnel', 'attachHermesWebSocketBridge'];
  const source = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? '')).map(node => node.getText(ast)).join('\n');
  if (source.length < 100) throw Error('production bridge functions missing');
  const stream = new EventEmitter();
  const ssh = Object.assign(new EventEmitter(), { forwardOut: vi.fn((_a, _b, _host, _port, cb) => cb(null, stream)), end: vi.fn() });
  const upgraded = vi.fn(); const connect = vi.fn(async () => ssh);
  const bindings = {
    randomUUID: () => 'fixture', websocketPathFor: () => '/ws', isHermesUpgradeNamespace: () => true, isHermesWebSocketUpgrade: () => true,
    cookieHeaderAllowed: () => true, websocketOriginAllowed: () => true, websocketAllowedOrigins: 'https://fixture', verifyDashboardSession: async () => true,
    recordHermesSecurityEvent: vi.fn(), resolveHermesInstallation: async () => ({ installation: selected }),
    resolveApprovedHermesSshTarget: fixture.approved, resolveHermesDashboardForwardTarget,
    beginManagedSshWork: fixture.begin, observeManagedSshEnd: vi.fn(), connectSsh: connect,
    hermesWss: { handleUpgrade: upgraded }, hermesEnabled: () => enabled, console: { warn: vi.fn(), error: vi.fn() },
  };
  const attach = new Function(...Object.keys(bindings), `${source}\nreturn attachHermesWebSocketBridge;`)(...Object.values(bindings));
  const server = new EventEmitter(); attach(server);
  const socket = { destroyed: false, write: vi.fn(), destroy: vi.fn() };
  server.emit('upgrade', { headers: {}, url: '/api/hermes/dashboard/ws' }, socket, Buffer.alloc(0));
  return { ssh, stream, socket, connect, upgraded };
}
describe('actual Hermes HTTP/WebSocket forwarding selection', () => {
  it('WebSocket bridge refuses upgrades while the Hermes integration is disabled', async () => {
    const ws = websocketFixture(installation, false); await tick();
    expect(ws.socket.write).toHaveBeenCalledWith(expect.stringContaining('503 Service Unavailable'));
    expect(ws.connect).not.toHaveBeenCalled();
    expect(fixture.begin).not.toHaveBeenCalled();
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
