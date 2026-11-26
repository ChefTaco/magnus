import { describe, expect, it } from 'vitest';
import { normalizeAddress, parseTrustedProxies, resolveClientAddress } from '../../runtime-client-address.mjs';

describe('trusted-proxy client addresses', () => {
  it('uses the socket peer when no proxy is trusted, ignoring X-Forwarded-For', () => {
    expect(resolveClientAddress('192.0.2.10', '203.0.113.7', null)).toBe('192.0.2.10');
    expect(resolveClientAddress('::ffff:192.0.2.10', undefined, null)).toBe('192.0.2.10');
    expect(resolveClientAddress(undefined, '203.0.113.7', null)).toBe('unverified');
  });

  it('takes the right-most untrusted hop when the peer is a listed proxy', () => {
    const { list, errors } = parseTrustedProxies('127.0.0.1, 10.0.0.0/8, ::1');
    expect(errors).toEqual([]);
    expect(resolveClientAddress('127.0.0.1', '203.0.113.7', list)).toBe('203.0.113.7');
    // A client-supplied left-most entry cannot override what the proxies appended.
    expect(resolveClientAddress('127.0.0.1', '198.51.100.1, 203.0.113.7, 10.1.2.3', list)).toBe('203.0.113.7');
    expect(resolveClientAddress('::1', ['203.0.113.7'], list)).toBe('203.0.113.7');
    // Not from a listed proxy: the header is ignored.
    expect(resolveClientAddress('192.0.2.10', '203.0.113.7', list)).toBe('192.0.2.10');
    // Only proxies, or a malformed hop: attribute to the peer.
    expect(resolveClientAddress('127.0.0.1', '10.0.0.5', list)).toBe('127.0.0.1');
    expect(resolveClientAddress('127.0.0.1', 'not-an-ip', list)).toBe('127.0.0.1');
  });

  it('reports malformed entries', () => {
    expect(parseTrustedProxies(undefined)).toEqual({ list: null, errors: [] });
    expect(parseTrustedProxies('proxy.example.com').errors).toHaveLength(1);
    expect(parseTrustedProxies('10.0.0.0/33').errors).toHaveLength(1);
    expect(parseTrustedProxies('10.0.0.0/8/1').errors).toHaveLength(1);
    expect(normalizeAddress('[2001:db8::1]')).toBe('2001:db8::1');
  });
});
