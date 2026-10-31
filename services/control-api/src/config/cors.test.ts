import { describe, expect, it } from 'vitest';
import { resolveCorsConfiguration } from './cors.js';

describe('Control API CORS configuration', () => {
  it('rejects a production wildcard from every supported source', () => {
    expect(() => resolveCorsConfiguration({ NODE_ENV: 'production', CORS_ORIGIN: '*' })).toThrow(/wildcard/);
    expect(() => resolveCorsConfiguration({ NODE_ENV: 'production', DASHBOARD_ORIGIN: '*' })).toThrow(/wildcard/);
    expect(() => resolveCorsConfiguration({
      NODE_ENV: 'production',
      PUBLIC_DASHBOARD_URL: 'https://dashboard.example.test,*',
    })).toThrow(/wildcard/);
  });

  it('uses exact production origins with credentials', () => {
    expect(resolveCorsConfiguration({
      NODE_ENV: 'production',
      CORS_ORIGIN: 'https://one.example.test, https://two.example.test',
    })).toEqual({
      origin: ['https://one.example.test', 'https://two.example.test'],
      credentials: true,
    });
  });

  it('permits wildcard CORS only outside production without credentials', () => {
    expect(resolveCorsConfiguration({ NODE_ENV: 'development' })).toEqual({
      origin: '*',
      credentials: false,
    });
  });
});
