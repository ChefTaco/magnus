import { describe, expect, it } from 'vitest';
import { errorText, redactSecretText, redactUnknown } from './redact.js';

// Built at run time so the repository secret scan does not see a key block.
const KEY_BLOCK = ['-----BEGIN', 'PRIVATE KEY-----\nfixture\n-----END', 'PRIVATE KEY-----'].join(' ');
const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const JWT = `${segment({ alg: 'RS256' })}.${segment({ sub: 'fixture-user' })}.fixture-signature`;

describe('redactUnknown', () => {
  it('masks every key Magnus masked before, whatever the value type', () => {
    const input = {
      apiKey: 'fixture-value', api_key: 'fixture-value', 'api-key': 'fixture-value', nodeToken: 'fixture-value', tokenCount: 7,
      clientSecret: { nested: 'fixture-value' }, password: 123456, PASSWD: true, private_key: ['fixture-value'], privateKey: 'fixture-value',
    };
    const output = redactUnknown(input) as Record<string, unknown>;
    for (const key of Object.keys(input)) expect(output[key], key).toBe('[REDACTED]');
  });

  it('also masks HiveCommon\'s wider names, keeping their non-secret scalars', () => {
    expect(redactUnknown({ authorization: 'Basic fixture', cookie: 'sid=fixture', credential: 'fixture', signature: 'fixture', signingKey: 'fixture', hasCredential: true }))
      .toEqual({ authorization: '[REDACTED]', cookie: '[REDACTED]', credential: '[REDACTED]', signature: '[REDACTED]', signingKey: '[REDACTED]', hasCredential: true });
  });

  it('scrubs strings everywhere and keeps ordinary fields', () => {
    expect(redactUnknown({ method: 'GET', status: 200, note: `Authorization: Bearer ${JWT}`, list: ['NODE_TOKEN=fixture-node-token'], url: 'https://admin:fixture@example.com/x' }))
      .toEqual({ method: 'GET', status: 200, note: 'Authorization: Bearer [REDACTED]', list: ['NODE_[REDACTED]'], url: 'https://[REDACTED]@example.com/x' });
  });

  it('survives cycles', () => {
    const value: Record<string, unknown> = { name: 'loop' };
    value['self'] = value;
    expect(redactUnknown(value)).toEqual({ name: 'loop', self: '[Circular]' });
  });
});

describe('redactSecretText', () => {
  it('masks assignments, bearer tokens, JWTs, provider keys, private keys and URL credentials', () => {
    const text = redactSecretText([
      'db_password: hunter2-fixture', 'token=abc123', `Bearer ${JWT}`, JWT, 'sk-fixture000000000000', 'ghp_fixture0000000000000000000000',
      KEY_BLOCK, 'postgres://magnus:fixture-pass@db.example.com/magnus',
    ].join(' | '));
    for (const secret of ['hunter2-fixture', 'abc123', JWT, 'sk-fixture', 'ghp_fixture', 'fixture\n', 'fixture-pass']) expect(text, secret).not.toContain(secret);
  });

  it('keeps errorText to one bounded line', () => {
    expect(errorText(new Error('failed\nwith token=abc123'))).toBe('Error: failed with [REDACTED]');
    expect(errorText('x'.repeat(600))).toHaveLength(500);
  });
});
