import { describe, expect, it } from 'vitest';
import type { Context } from 'hono';
import { heartbeatPeerAddress } from './heartbeat-peer.js';

function fakeContext(remoteAddress: string | undefined, forwardedFor?: string): Context {
  return {
    env: remoteAddress
      ? { server: { incoming: { socket: { remoteAddress } } } }
      : {},
    req: {
      header: (name: string) => name === 'x-forwarded-for' ? forwardedFor : undefined,
    },
  } as unknown as Context;
}

describe('heartbeatPeerAddress', () => {
  it('reads the Node adapter server binding and normalizes mapped IPv4', () => {
    expect(heartbeatPeerAddress(fakeContext('::ffff:127.0.0.1'))).toBe('127.0.0.1');
  });

  it('does not let a forwarded header override the socket peer', () => {
    expect(heartbeatPeerAddress(fakeContext('100.64.0.10', '127.0.0.1'))).toBe('100.64.0.10');
  });

  it('uses the forwarded address only when adapter connection data is absent', () => {
    expect(heartbeatPeerAddress(fakeContext(undefined, '100.64.0.20, 10.0.0.1'))).toBe('100.64.0.20');
  });
});
