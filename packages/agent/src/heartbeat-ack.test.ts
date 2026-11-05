import { expect, it } from 'vitest';
import { parseHeartbeatAcknowledgement } from './heartbeat-ack.js';
it('requires explicit control-plane acceptance before recording a successful heartbeat', () => {
  for (const value of [
    { success: true },
    { data: {} },
    { data: { accepted: false } },
    { data: { accepted: 'true' } },
    null,
  ])
    expect(() => parseHeartbeatAcknowledgement(value)).toThrow();
  expect(
    parseHeartbeatAcknowledgement({
      success: true,
      data: { accepted: true, expectedVersion: '2.0.0', updateAvailable: false },
      privateDiagnostic: 'not returned',
    }),
  ).toEqual({ data: { accepted: true, expectedVersion: '2.0.0', updateAvailable: false } });
});
