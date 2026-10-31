import { describe, expect, it } from 'vitest';
import { parseCookie } from './terminal-ws';

describe('parseCookie', () => {
  it('decodes valid cookie values', () => {
    expect(parseCookie('foo=bar%20baz; answer=42')).toEqual(
      new Map([
        ['foo', 'bar baz'],
        ['answer', '42'],
      ]),
    );
  });

  it('ignores malformed percent-encoded cookie values', () => {
    expect(() => parseCookie('x=%E0%A4%A; session=ok')).not.toThrow();
    expect(parseCookie('x=%E0%A4%A; session=ok')).toEqual(new Map([['session', 'ok']]));
  });
});
