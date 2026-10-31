import { afterEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { networkInfoRoutes } from './network-info.js';

vi.mock('node:child_process', () => ({ execSync: vi.fn() }));

afterEach(() => vi.resetAllMocks());

describe('network information collection', () => {
  it('reads state-filtered ss connections without a State column', async () => {
    vi.mocked(execSync)
      .mockReturnValueOnce('State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\nLISTEN 0 128 0.0.0.0:5432 0.0.0.0:* users:(("postgres",pid=42,fd=3))\n')
      .mockReturnValueOnce([
        'Recv-Q Send-Q Local Address:Port Peer Address:Port',
        '0 0 192.0.2.10:52000 192.0.2.20:5432',
        '0 0 [2001:db8::10]:52001 [2001:db8::20]:6379',
        '0 0 127.0.0.1:52002 127.0.0.1:5432',
        '0 0 [::1]:52003 [::1]:5432',
        'malformed row',
      ].join('\n'));

    const response = await networkInfoRoutes.request('/');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      listeningPorts: [{ port: 5432, protocol: 'tcp', process: 'postgres', pid: 42 }],
      connections: [
        { localPort: 52000, remoteIp: '192.0.2.20', remotePort: 5432, state: 'ESTABLISHED' },
        { localPort: 52001, remoteIp: '2001:db8::20', remotePort: 6379, state: 'ESTABLISHED' },
      ],
    });
  });

  it('preserves the first headerless netstat connection and listening process', async () => {
    vi.mocked(execSync)
      .mockReturnValueOnce([
        'Active Internet connections (only servers)',
        'Proto Recv-Q Send-Q Local Address Foreign Address State PID/Program name',
        'tcp 0 0 0.0.0.0:5432 0.0.0.0:* LISTEN 42/postgres',
        'tcp6 0 0 :::5432 :::* LISTEN 42/postgres',
      ].join('\n'))
      .mockReturnValueOnce('tcp 0 0 192.0.2.10:52000 192.0.2.20:5432 ESTABLISHED\n');

    expect(await (await networkInfoRoutes.request('/')).json()).toMatchObject({
      listeningPorts: [{ port: 5432, protocol: 'tcp', process: 'postgres', pid: 42 }],
      connections: [{ localPort: 52000, remoteIp: '192.0.2.20', remotePort: 5432, state: 'ESTABLISHED' }],
    });
  });

  it('returns empty collections when socket commands are unavailable', async () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('tools unavailable'); });
    expect(await (await networkInfoRoutes.request('/')).json()).toMatchObject({
      listeningPorts: [], connections: [],
    });
  });
});
