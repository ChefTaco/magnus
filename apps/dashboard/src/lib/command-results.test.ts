import { afterEach, expect, test, vi } from 'vitest';
import { commandOutput, watchCommandResults, type CommandObservation } from './command-results';

afterEach(() => { vi.useRealTimers(); });

test('follows queued and running commands to their recorded result without redispatch', async () => {
  vi.useFakeTimers();
  const load = vi.fn().mockResolvedValueOnce({ id: 'fixture', status: 'QUEUED' })
    .mockResolvedValueOnce({ id: 'fixture', status: 'RUNNING' })
    .mockResolvedValueOnce({ id: 'fixture', status: 'COMPLETED', result: { stdout: 'Linux\n', stderr: '', exitCode: 0 } });
  const updates: CommandObservation[] = [];
  const stop = watchCommandResults(['fixture'], load, value => updates.push(value), vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(commandOutput(updates.at(-1))).toContain('waiting for result');
  await vi.advanceTimersByTimeAsync(3000);
  expect(updates.map(value => value.status)).toEqual(['QUEUED', 'RUNNING', 'COMPLETED']);
  expect(commandOutput(updates.at(-1))).toContain('Exit: 0');
  expect(commandOutput(updates.at(-1))).toContain('Linux');
  await vi.advanceTimersByTimeAsync(6000);
  expect(load).toHaveBeenCalledTimes(3);
  stop();
});

test('a read failure retries without fabricating command failure or replaying work', async () => {
  vi.useFakeTimers();
  const load = vi.fn().mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce({ id: 'fixture', status: 'failed', result: { stdout: '', stderr: 'Refused', exitCode: -1 } });
  const update = vi.fn(), failed = vi.fn();
  const stop = watchCommandResults(['fixture'], load, update, failed);
  await vi.advanceTimersByTimeAsync(0);
  expect(update).not.toHaveBeenCalled();
  expect(failed).toHaveBeenCalledWith('fixture', expect.any(Error));
  await vi.advanceTimersByTimeAsync(1500);
  expect(commandOutput(update.mock.calls[0]![0])).toContain('Refused');
  expect(commandOutput(update.mock.calls[0]![0])).toContain('Exit: -1');
  stop();
});

test('cancellation and switching views suppress late responses and stop all polling', async () => {
  vi.useFakeTimers();
  let resolve!: (value: CommandObservation) => void;
  const load = vi.fn(() => new Promise<CommandObservation>(done => { resolve = done; }));
  const update = vi.fn(), failed = vi.fn();
  const stop = watchCommandResults(['fixture'], load, update, failed);
  stop();
  resolve({ id: 'fixture', status: 'COMPLETED' });
  await vi.advanceTimersByTimeAsync(10000);
  expect(update).not.toHaveBeenCalled();
  expect(failed).not.toHaveBeenCalled();
  expect(load).toHaveBeenCalledTimes(1);
});

test('responses for another command cannot replace the selected output', async () => {
  vi.useFakeTimers();
  const update = vi.fn(), failed = vi.fn();
  const stop = watchCommandResults(['fixture'], async () => ({ id: 'other', status: 'COMPLETED' }), update, failed);
  await vi.advanceTimersByTimeAsync(0);
  expect(update).not.toHaveBeenCalled();
  expect(failed).toHaveBeenCalledWith('fixture', expect.any(Error));
  stop();
  expect(commandOutput({ id: 'fixture', status: 'CANCELLED' })).toBe('CANCELLED: no output was recorded.');
});
