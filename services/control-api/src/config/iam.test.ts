import { describe, expect, it } from 'vitest';
import { iamCoreUrlProblem } from './iam.js';

describe('iamCoreUrlProblem', () => {
  it.each(['https://iam.example.com', 'https://iam.example.com/api/iam/', 'http://localhost:4001', 'http://127.0.0.1:4001', 'http://[::1]:4001'])(
    'accepts %s',
    (url) => expect(iamCoreUrlProblem(url, false)).toBeNull(),
  );

  it.each(['http://iam.example.com', 'http://192.0.2.10:4001', 'http://localhost.example.com', 'ftp://iam.example.com', 'not a url', 'https://user:pass@iam.example.com'])(
    'refuses %s',
    (url) => expect(iamCoreUrlProblem(url, false)).toMatch(/IAM_CORE_URL/),
  );

  it('accepts cleartext to any host only with the development flag', () => {
    expect(iamCoreUrlProblem('http://iam.example.com', true)).toBeNull();
    expect(iamCoreUrlProblem('https://user:pass@iam.example.com', true)).toMatch(/credentials/);
  });
});
