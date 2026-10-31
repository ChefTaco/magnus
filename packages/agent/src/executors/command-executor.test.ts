import { describe, expect, it } from 'vitest';
import { ByteBoundedOutput, commandRoutes } from './command-executor.js';

describe('byte-bounded command output', () => {
  it('reassembles a multibyte code point split across chunks', () => {
    const output = new ByteBoundedOutput(5);
    const euro = Buffer.from('€', 'utf8');

    output.append(Buffer.concat([Buffer.from('ab'), euro.subarray(0, 1)]));
    output.append(euro.subarray(1));

    expect(output.byteLength).toBe(5);
    expect(output.truncated).toBe(false);
    expect(output.toString()).toBe('ab€');
  });

  it('marks a crossing chunk immediately and never emits above the byte cap', () => {
    const stdout = new ByteBoundedOutput(4);
    stdout.append('ab');
    stdout.append('€');

    expect(stdout.truncated).toBe(true);
    expect(stdout.byteLength).toBe(4);
    expect(Buffer.byteLength(stdout.toString(), 'utf8')).toBeLessThanOrEqual(4);
    expect(stdout.toString()).toBe('ab');

    const stderr = new ByteBoundedOutput(3);
    stderr.append('abc');
    expect(stderr.truncated).toBe(false);
    stderr.append('d');
    expect(stderr.truncated).toBe(true);
    expect(stderr.toString()).toBe('abc');
  });
});

describe('retired command stream', () => {
  it('returns 410 without parsing a body or starting a command', async () => {
    const response = await commandRoutes.request('/stream', { method: 'POST' });
    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: 'GONE' },
    });
  });
});

describe('command request identifiers', () => {
  it.each([
    '../outside',
    'nested/path',
    'command id',
    `a${'b'.repeat(128)}`,
  ])('rejects unsafe commandId %j before execution', async (commandId) => {
    const response = await commandRoutes.request('/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId, command: 'true' }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: 'VALIDATION_ERROR' },
    });
  });
});
