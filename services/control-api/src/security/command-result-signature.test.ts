import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  commandResultSigningPayload,
  type SignedCommandResult,
  verifyCommandResultSignature,
} from './command-result-signature.js';

const secret = 'result-signing-test-secret-is-at-least-32-characters';

function signed(overrides: Partial<SignedCommandResult> = {}): SignedCommandResult {
  const unsigned = {
    commandId: 'cmd-1',
    exitCode: 0,
    stdout: 'abcd',
    stderr: 'warn',
    durationMs: 17,
    truncated: false,
    ...overrides,
  };
  return {
    ...unsigned,
    signature: createHmac('sha256', secret).update(commandResultSigningPayload(unsigned)).digest('hex'),
  };
}

describe('command result verification', () => {
  it('accepts only an exact signed result', () => {
    const result = signed();
    expect(verifyCommandResultSignature(result, secret)).toBe(true);
    expect(verifyCommandResultSignature({ ...result, stdout: 'wxyz' }, secret)).toBe(false);
    expect(verifyCommandResultSignature({ ...result, truncated: true }, secret)).toBe(false);
    expect(verifyCommandResultSignature({ ...result, signature: '' }, secret)).toBe(false);
    expect(verifyCommandResultSignature(result, '')).toBe(false);
  });

  it('accepts a bounded previous signer without accepting an unrelated purpose key', () => {
    const previous = 'previous-result-signing-secret-is-at-least-32-characters';
    const unsigned = { ...signed(), signature: undefined };
    const previousResult = {
      ...unsigned,
      signature: createHmac('sha256', previous)
        .update(commandResultSigningPayload(unsigned))
        .digest('hex'),
    } as SignedCommandResult;
    expect(verifyCommandResultSignature(previousResult, secret, previous)).toBe(true);
    expect(verifyCommandResultSignature(previousResult, secret, 'node-manager-purpose-secret-is-at-least-32-characters')).toBe(false);
  });
});
