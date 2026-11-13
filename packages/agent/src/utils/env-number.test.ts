import { describe, expect, it } from 'vitest';
import { positiveIntegerEnv } from './env-number.js';

describe('positiveIntegerEnv', () => {
  it('uses the fallback for unset, empty, non-numeric and non-positive values', () => {
    for (const value of [undefined, '', ' ', '30s', 'NaN', '0', '-5', '1.5']) {
      expect(positiveIntegerEnv('X', 30_000, value === undefined ? {} : { X: value })).toBe(30_000);
    }
  });

  it('accepts a positive integer', () => {
    expect(positiveIntegerEnv('X', 30_000, { X: ' 5000 ' })).toBe(5000);
  });
});
