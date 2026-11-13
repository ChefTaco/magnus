import { describe, expect, it } from 'vitest';
import { intQuery, pagination } from './query.js';

const context = (query: Record<string, string>) => ({ req: { query: (name: string) => query[name] } });

describe('numeric query parameters', () => {
  it.each([
    [{}, 25],
    [{ limit: '' }, 25],
    [{ limit: 'abc' }, 25],
    [{ limit: 'Infinity' }, 25],
    [{ limit: '10' }, 10],
    [{ limit: '10.9' }, 10],
    [{ limit: '0' }, 1],
    [{ limit: '-5' }, 1],
    [{ limit: '5000' }, 100],
  ])('intQuery(%j) is %d', (query, expected) => {
    expect(intQuery(context(query), 'limit', { fallback: 25, min: 1, max: 100 })).toBe(expected);
  });

  it('never yields a negative offset or an unbounded page', () => {
    expect(pagination(context({ page: '0', pageSize: '100000' }), { pageSize: 50, maxPageSize: 200 })).toEqual({ page: 1, pageSize: 200 });
    expect(pagination(context({ page: 'x', pageSize: '-1' }), { pageSize: 50, maxPageSize: 200 })).toEqual({ page: 1, pageSize: 1 });
    expect(pagination(context({ page: '3' }), { pageSize: 50, maxPageSize: 200 })).toEqual({ page: 3, pageSize: 50 });
  });

  it('reads the page size from another parameter when a route names it differently', () => {
    expect(pagination(context({ limit: '7', pageSize: '99' }), { pageSize: 20, maxPageSize: 100, pageSizeParam: 'limit' })).toEqual({ page: 1, pageSize: 7 });
  });
});
