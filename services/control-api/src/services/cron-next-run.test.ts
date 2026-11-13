import { describe, expect, it } from 'vitest';
import { isCronExpression, nextCronRun } from './cron-next-run.js';

// Local-time constructor: the schedule is evaluated in the server's local time.
const at = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0) => new Date(year, month - 1, day, hour, minute, second);

describe('nextCronRun', () => {
  // 2026-11-13 is a Friday.
  const now = at(2026, 11, 13, 10, 7, 30);

  it.each([
    ['* * * * *', at(2026, 11, 13, 10, 8)],
    ['*/15 * * * *', at(2026, 11, 13, 10, 15)],
    ['0 */6 * * *', at(2026, 11, 13, 12, 0)],
    ['30 9 * * *', at(2026, 11, 14, 9, 30)],
    ['0 9-17 * * *', at(2026, 11, 13, 11, 0)],
    ['0,30 * * * *', at(2026, 11, 13, 10, 30)],
    ['5/20 * * * *', at(2026, 11, 13, 10, 25)],
    ['0 3 * * 1', at(2026, 11, 16, 3, 0)],
    ['0 3 * * 7', at(2026, 11, 15, 3, 0)],
    ['0 0 1 * *', at(2026, 12, 1, 0, 0)],
    ['0 0 1 1 *', at(2027, 1, 1, 0, 0)],
    ['0 0 29 2 *', at(2028, 2, 29, 0, 0)],
    // Both day fields restricted: either one matches (the 15th is a Sunday, the 16th a Monday).
    ['0 0 16 * 0', at(2026, 11, 15, 0, 0)],
  ])('%s', (expression, expected) => {
    expect(nextCronRun(expression, now)).toEqual(expected);
  });

  it('is strictly after the reference time', () => {
    expect(nextCronRun('7 10 * * *', at(2026, 11, 13, 10, 7, 0))).toEqual(at(2026, 11, 14, 10, 7));
  });

  it('answers null for a date that never occurs', () => {
    expect(nextCronRun('0 0 31 2 *', now)).toBeNull();
  });

  it.each(['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8',
    '*/0 * * * *', '5-1 * * * *', '* * * * MON', '@daily', 'a b c d e', '1,,2 * * * *', '-1 * * * *'])('refuses %j', (expression) => {
    expect(isCronExpression(expression)).toBe(false);
    expect(nextCronRun(expression, now)).toBeNull();
  });
});
