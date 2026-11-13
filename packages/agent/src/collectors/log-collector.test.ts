import { describe, expect, it, vi } from 'vitest';
import {
  BoundedLogQueue,
  batchRejected,
  parseJournalLine,
  singleFlight,
  type LogEntry,
} from './log-collector.js';

function entry(message: string): LogEntry {
  return {
    nodeId: 'agent.example.test',
    source: 'fixture.service',
    level: 'info',
    message,
    metadata: {},
    timestamp: '2026-08-07T00:00:00.000Z',
  };
}

describe('bounded log forwarding queue', () => {
  it('hard-caps ingress without evicting older unsent entries', () => {
    const queue = new BoundedLogQueue(2);
    expect(queue.enqueue(entry('oldest'))).toBe(true);
    expect(queue.enqueue(entry('next'))).toBe(true);
    expect(queue.enqueue(entry('newest'))).toBe(false);
    expect(queue.length).toBe(2);
    expect(queue.take(10).map((item) => item.message)).toEqual(['oldest', 'next']);
  });

  it('restores a failed batch at the front and remains bounded during retry', () => {
    const queue = new BoundedLogQueue(3);
    queue.enqueue(entry('failed-one'));
    queue.enqueue(entry('failed-two'));
    const failed = queue.take(2);

    queue.enqueue(entry('new-one'));
    queue.enqueue(entry('new-two'));
    queue.enqueue(entry('new-three'));
    const dropped = queue.requeueFront(failed);

    expect(queue.length).toBe(3);
    expect(queue.take(3).map((item) => item.message)).toEqual([
      'failed-one',
      'failed-two',
      'new-one',
    ]);
    expect(dropped.map((item) => item.message).sort()).toEqual(['new-three', 'new-two']);
  });
});

describe('log flush single flight', () => {
  it('shares one operation across timer and threshold triggers', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const operation = vi.fn(async () => gate);
    const flush = singleFlight(operation);

    const threshold = flush();
    const timer = flush();
    expect(timer).toBe(threshold);
    expect(operation).toHaveBeenCalledTimes(1);

    release();
    await threshold;
    await flush();
    expect(operation).toHaveBeenCalledTimes(2);
  });
});

describe('journal line parsing', () => {
  it('decodes a message journalctl printed as a byte array', () => {
    const bytes = [...Buffer.from('\u001b[31mfailed\u001b[0m')];
    const parsed = parseJournalLine(JSON.stringify({ MESSAGE: bytes, _SYSTEMD_UNIT: 'fixture.service', PRIORITY: '3' }));
    expect(parsed).toMatchObject({ message: '\u001b[31mfailed\u001b[0m', source: 'fixture.service', level: 'error' });
  });

  it('drops entries without a text message and bounds long ones', () => {
    expect(parseJournalLine(JSON.stringify({ MESSAGE: null }))).toBeNull();
    expect(parseJournalLine(JSON.stringify({ MESSAGE: { nested: true } }))).toBeNull();
    expect(parseJournalLine('not json')).toBeNull();
    expect(parseJournalLine(JSON.stringify({ MESSAGE: `a\u0000${'b'.repeat(40_000)}` }))?.message).toHaveLength(16_384);
  });
});

describe('rejected batches', () => {
  it('treats only a refusal of the batch itself as final', () => {
    expect(batchRejected({ response: { status: 400 } })).toBe(true);
    expect(batchRejected({ response: { status: 413 } })).toBe(true);
    expect(batchRejected({ response: { status: 401 } })).toBe(false);
    expect(batchRejected({ response: { status: 503 } })).toBe(false);
    expect(batchRejected(new Error('fetch failed'))).toBe(false);
  });
});
