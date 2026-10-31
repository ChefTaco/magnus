import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ admitted: true, systemd: true, calls: [] as string[], effects: 0 }));
vi.mock('node:fs/promises', () => ({ constants: { F_OK: 0 }, access: vi.fn(async () => undefined),
  readFile: vi.fn(async () => "CONTROL_API_VERSION = 'fixture'; AGENT_VERSION = 'fixture'") }));
vi.mock('node:child_process', () => ({ execFile: vi.fn((command: string, args: string[], _options: unknown, callback: (error: Error | null, output?: object) => void) => {
  state.calls.push([command, ...args].join(' '));
  if (command === 'systemctl' && args[0] === 'is-active' && !state.systemd) return callback(new Error('fixture unavailable'));
  callback(null, { stdout: command === 'git' && args[0] === 'rev-parse' ? 'fixture' : 'Already up to date', stderr: '' });
}) }));
vi.mock('./api-local-work.js', () => ({
  reserveApiLocalWork: vi.fn(async () => ({ workId: 'fixture-work', run: async (operation: () => Promise<unknown>) => {
    if (!state.admitted) throw new Error('Drain won'); state.effects++; return operation();
  } })),
  withApiLocalWork: vi.fn(async (_kind: string, operation: () => Promise<object>) => {
    if (!state.admitted) throw new Error('Drain won'); state.effects++; return { ...await operation(), workId: 'fixture-work' };
  }),
}));
import { checkForUpdates, performSelfUpdate, scheduleRestart } from './self-update-service.js';

describe('local self-update execution boundary', () => {
  beforeEach(() => { state.admitted = true; state.systemd = true; state.calls = []; state.effects = 0; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it('denies fetch and install before any mutating subprocess when drain rejects', async () => {
    state.admitted = false;
    await expect(checkForUpdates()).rejects.toThrow('Drain won');
    await expect(performSelfUpdate()).rejects.toThrow('Drain won');
    expect(state.calls).toEqual([]);
  });
  it('wraps fetch and full git/npm sequence in durable admission', async () => {
    expect(await checkForUpdates()).toMatchObject({ available: false, workId: 'fixture-work' });
    expect(await performSelfUpdate()).toMatchObject({ success: true, workId: 'fixture-work' });
    expect(state.calls).toContain('git fetch origin'); expect(state.calls).toContain('npm ci'); expect(state.calls).toContain('npm run build');
    expect(state.effects).toBe(2);
  });
  it('returns a reservation immediately and checks admission only when delayed restart executes', async () => {
    expect(await scheduleRestart()).toEqual({ scheduled: true, method: 'systemd', workId: 'fixture-work' });
    expect(state.effects).toBe(0); state.admitted = false; vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await vi.advanceTimersByTimeAsync(3000);
    expect(state.calls).toEqual(['systemctl is-active magnus-control-api']); expect(state.effects).toBe(0);
  });
  it('runs an admitted systemd restart once without replay', async () => {
    await scheduleRestart(); await vi.advanceTimersByTimeAsync(3000); await vi.advanceTimersByTimeAsync(10000);
    expect(state.calls.filter(call => call === 'systemctl restart magnus-control-api')).toHaveLength(1); expect(state.effects).toBe(1);
  });
  it('applies the same delayed guard to the process-manager fallback', async () => {
    state.systemd = false; const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('Unexpected real exit'); });
    expect(await scheduleRestart()).toMatchObject({ method: 'process.exit' }); state.admitted = false;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined); await vi.advanceTimersByTimeAsync(3000);
    expect(exit).not.toHaveBeenCalled();
  });
});
