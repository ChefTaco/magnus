import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ begin: vi.fn(), finish: vi.fn(), clients: [] as any[] }));
vi.mock('../../runtime-resource-participant.mjs', async original => ({ ...(await original<any>()), beginManagedSshWork: fixture.begin }));
vi.mock('../../runtime-dashboard-credentials.mjs', () => ({ resolveDashboardSshCredentials: () => ({ username: 'fixture', password: 'fixture' }) }));
vi.mock('@/lib/auth', () => ({ COOKIE_NAME: 'magnus_session', verifySessionToken: async () => ({ userId: 'fixture-user', username: 'fixture' }) }));
vi.mock('ssh2', () => ({ Client: class extends EventEmitter {
  connect = vi.fn(); end = vi.fn(() => this.emit('close'));
  stream = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), close: vi.fn(), write: vi.fn(), setWindow: vi.fn() });
  shell(_opts: unknown, callback: Function) { callback(null, this.stream); }
  constructor() { super(); fixture.clients.push(this); }
} }));
import { openSession, closeSession, sessions } from './terminal-sessions';
import { attachWebSocketTerminal } from './terminal-ws';

beforeEach(() => { fixture.clients.length = 0; fixture.begin.mockReset(); fixture.finish.mockReset().mockResolvedValue({ state: 'unknown' }); fixture.begin.mockResolvedValue({ workId: 'fixture', finish: fixture.finish }); });
afterEach(() => { for (const id of sessions.keys()) closeSession(id); });
const turn = () => new Promise(resolve => setImmediate(resolve));

describe('native terminal ownership lifecycle', () => {
  it('does not construct or connect SSH until durable admission acknowledgment', async () => {
    let admit!: Function;
    fixture.begin.mockImplementation(() => new Promise(resolve => { admit = resolve; }));
    const pending = openSession({ host: 'fixture.lab', ownerId: 'fixture-user' });
    await turn(); expect(fixture.clients).toHaveLength(0);
    admit({ workId: 'fixture', finish: fixture.finish }); await turn();
    const client = fixture.clients[0]; expect(client.connect).toHaveBeenCalledTimes(1);
    client.emit('ready'); const id = await pending;
    expect(sessions.has(id)).toBe(true);
    client.stream.emit('close', 0); await turn();
    expect(fixture.finish).toHaveBeenCalledWith('remote-ended');
  });
  it('denied admission never connects and lost SSH status remains unknown', async () => {
    fixture.begin.mockRejectedValueOnce(Error('draining'));
    await expect(openSession({ host: 'fixture.lab', ownerId: 'fixture-user' })).rejects.toThrow('draining');
    expect(fixture.clients).toHaveLength(0);
    const pending = openSession({ host: 'fixture.lab', ownerId: 'fixture-user' }); await turn();
    fixture.clients[0].emit('ready'); await pending;
    fixture.clients[0].stream.emit('close'); await turn();
    expect(fixture.finish).toHaveBeenCalledWith('unknown');
  });
  it('SSH error before ready records unknown without admitting a shell', async () => {
    const pending = openSession({ host: 'fixture.lab', ownerId: 'fixture-user' });
    const rejection = expect(pending).rejects.toThrow('connection lost'); await turn();
    fixture.clients[0].emit('error', Error('connection lost')); await rejection;
    expect(fixture.finish).toHaveBeenCalledWith('unknown');
  });
  it('WebSocket disconnect during handshake retains unknown ownership', async () => {
    const server = new EventEmitter();
    const wss = attachWebSocketTerminal(server as any);
    const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, send: vi.fn(), close: vi.fn(), ping: vi.fn() });
    wss.emit('connection', ws, { url: '/api/terminal/ws?host=fixture.lab', headers: { cookie: 'magnus_session=fixture' } });
    await turn(); expect(fixture.begin).toHaveBeenCalledWith('fixture.lab', 'terminal-ws');
    ws.emit('close'); await turn();
    expect(fixture.finish).toHaveBeenCalledWith('unknown');
    expect(fixture.clients[0].end).toHaveBeenCalled();
  });
});
