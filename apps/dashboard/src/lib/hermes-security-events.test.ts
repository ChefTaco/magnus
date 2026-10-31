import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flushHermesSecurityEvents, normalizeHermesSecurityEvent, readHermesSecurityEvents, recordHermesSecurityEvent, summarizeHermesSecurityEvents } from '../../runtime-hermes-security-events.mjs';

describe('Hermes proxy security events', () => {
  it('records correlation evidence asynchronously and summarizes security counters', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hermes-security-')), 'events.jsonl');
    recordHermesSecurityEvent({ type: 'rejected_origin', correlationId: 'origin-1' }, { path });
    recordHermesSecurityEvent({ type: 'blocked_destination', correlationId: 'target-1' }, { path });
    recordHermesSecurityEvent({ type: 'queue_pressure', correlationId: 'queue-1' }, { path });
    recordHermesSecurityEvent({ type: 'connection_closed', correlationId: 'connection-1', durationMs: 250 }, { path });
    await flushHermesSecurityEvents({ path });

    const events = readHermesSecurityEvents({ path });
    expect(events.map((event) => event.correlationId)).toEqual(['connection-1', 'queue-1', 'target-1', 'origin-1']);
    expect(summarizeHermesSecurityEvents(events)).toMatchObject({
      rejectedOrigins: 1,
      blockedDestinations: 1,
      queuePressure: 1,
      connectionsClosed: 1,
      averageConnectionDurationMs: 250,
    });
  });

  it('normalizes paths and origins, redacts credentials, and bounds fields', () => {
    expect(normalizeHermesSecurityEvent({
      type: 'blocked_destination',
      correlationId: 'safe-id',
      path: '/api/ws?token=secret\nvalue',
      origin: 'https://user:pass@example.com/private?token=secret',
      hostname: 'user:password@host.example?token=secret',
      reason: `authorization=Bearer-secret ${'x'.repeat(400)}`,
      ignored: 'must not persist',
    })).toMatchObject({
      type: 'blocked_destination',
      correlationId: 'safe-id',
      path: '/api/ws',
      origin: 'https://example.com',
      hostname: '[REDACTED_HOST]',
      reason: expect.stringContaining('[REDACTED]'),
    });
    expect(normalizeHermesSecurityEvent({ type: 'unknown' })).toBeNull();
  });
});
