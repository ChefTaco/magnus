import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ active: false, restarts: 0, calls: [] as string[][] }));
vi.mock('node:child_process', () => ({
  execFile: (_command: string, args: string[], _options: unknown, done: (error: Error | null, value: unknown) => void) => {
    state.calls.push(args);
    if (args.includes('restart')) state.active = true;
    if (args.includes('try-restart') && state.active) state.restarts++;
    done(null, { stdout: args.includes('-u') && args.length === 2 ? '1000\n' : '', stderr: '' });
  },
}));
process.env['MAGNUS_AGENT_RENEWAL_UNITS'] = 'hermes-gateway.service, ardent@example.service,magnus-control-api.service';
import { restartCredentialConsumer } from './credential-renewal.js';

describe('credential renewal preserves consumer ownership', () => {
  beforeEach(() => { state.active = false; state.restarts = 0; state.calls = []; });
  it('keeps a disabled, stopped user gateway stopped', async () => {
    await restartCredentialConsumer({ unit: 'hermes-gateway.service', user: 'operator' });
    expect(state.active).toBe(false);
    expect(state.restarts).toBe(0);
    expect(state.calls.length).toBe(2);
  });
  it('reloads credentials in an already active Ardent consumer', async () => {
    state.active = true;
    await restartCredentialConsumer({ unit: 'ardent@example.service', user: 'operator' });
    expect(state.active).toBe(true);
    expect(state.restarts).toBe(1);
  });
  it('also preserves a stopped system consumer', async () => {
    await restartCredentialConsumer({ unit: 'magnus-control-api.service' });
    expect(state.active).toBe(false);
    expect(state.restarts).toBe(0);
  });
  it('rejects an unapproved unit without executing anything', async () => {
    await expect(restartCredentialConsumer({ unit: 'sshd.service' })).rejects.toThrow('Unsupported restart unit');
    expect(state.calls).toEqual([]);
  });
});

describe('credential renewal allowlists', () => {
  it('rejects every unit when none are configured', async () => {
    const saved = process.env['MAGNUS_AGENT_RENEWAL_UNITS'];
    delete process.env['MAGNUS_AGENT_RENEWAL_UNITS'];
    try {
      await expect(restartCredentialConsumer({ unit: 'hermes-gateway.service' })).rejects.toThrow('Unsupported restart unit');
    } finally { process.env['MAGNUS_AGENT_RENEWAL_UNITS'] = saved; }
  });
});
