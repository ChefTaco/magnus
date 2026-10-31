import { describe, expect, it } from 'vitest';
import { normalizeProxyTarget, proxyTargetHeaders, resolveProxyTarget } from './proxy-target';

describe('proxy target helpers', () => {
  it('normalizes explicit targets', () => {
    expect(normalizeProxyTarget(' https://control.example:4000/// '))
      .toBe('https://control.example:4000');
  });

  it('omits empty browser target headers', () => {
    expect(proxyTargetHeaders('')).toEqual({});
    expect(proxyTargetHeaders('   ')).toEqual({});
    expect(proxyTargetHeaders('https://control.example:4000/')).toEqual({
      'x-proxy-target': 'https://control.example:4000',
    });
  });

  it('uses the server target when the request header is absent or blank', () => {
    expect(resolveProxyTarget(null, 'https://canonical.example:4000/'))
      .toBe('https://canonical.example:4000');
    expect(resolveProxyTarget('   ', 'https://canonical.example:4000/'))
      .toBe('https://canonical.example:4000');
    expect(resolveProxyTarget('https://remote.example:4000/', 'https://canonical.example:4000'))
      .toBe('https://remote.example:4000');
  });
});
