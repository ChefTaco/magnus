import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { commandResultSigningPayload, signCommandResult, verifyCommandResult, commandReconciliationSigningPayload, verifyCommandReconciliation } from './command-result-signature.js';

const secret = 'result-signing-test-secret-is-at-least-32-characters';
const result = {
  commandId: 'cmd-1',
  exitCode: 0,
  stdout: 'abcd',
  stderr: 'warn',
  durationMs: 17,
  truncated: false,
};

describe('command result signing', () => {
  it('binds exact stream contents and truncation metadata', () => {
    expect(commandResultSigningPayload(result)).toContain(
      '88d4266fd4e6338d13b845fcf289579d209c897823b9217da3e161936f031589',
    );
    expect(signCommandResult(result, secret)).not.toBe(
      signCommandResult({ ...result, stdout: 'wxyz' }, secret),
    );
    expect(signCommandResult(result, secret)).not.toBe(
      signCommandResult({ ...result, truncated: true }, secret),
    );
  });

  it('fails closed without a strong dedicated key', () => {
    expect(() => signCommandResult(result, '')).toThrow(/at least 32/);
  });

  it('verifies signatures and binds every v2 resource fence field', () => {
    const value = { ...result, coordination: { version: 1 as const, resourceKey: 'node:fixture', fence: '9', expiresAt: 1_800_000_000_000, requestSha256: 'a'.repeat(64) } };
    const signed = { ...value, signature: signCommandResult(value, secret) };
    expect(verifyCommandResult(signed, secret)).toBe(true);
    for (const patch of [{ resourceKey: 'node:other' }, { fence: '10' }, { expiresAt: value.coordination.expiresAt + 1 }, { requestSha256: 'b'.repeat(64) }]) {
      expect(verifyCommandResult({ ...signed, coordination: { ...signed.coordination, ...patch } }, secret)).toBe(false);
    }
    expect(verifyCommandResult({ ...signed, coordination: undefined }, secret)).toBe(false);
  });

  it('binds every v3 completion registry field', () => {
    const value = { ...result, coordination: { version: 1 as const, resourceKey: 'node:fixture', fence: '9',
      expiresAt: 1_800_000_000_000, requestSha256: 'a'.repeat(64) }, completion: { registryVersion: 1 as const,
      registrySha256: 'b'.repeat(64), descriptorId: 'diagnostics-uptime-v1' } };
    const signed = { ...value, signature: signCommandResult(value, secret) };
    expect(verifyCommandResult(signed, secret)).toBe(true);
    for (const completion of [{ ...value.completion, registryVersion: 2 as const },
      { ...value.completion, registrySha256: 'c'.repeat(64) }, { ...value.completion, descriptorId: 'other' }])
      expect(verifyCommandResult({ ...signed, completion }, secret)).toBe(false);
    expect(verifyCommandResult({ ...signed, completion: undefined }, secret)).toBe(false);
  });

  it('binds reconciliation attestations to a separate domain, node, evidence, approval, scope, and expiry', () => {
    const key = 'separate-reconciliation-key-more-than-thirty-two-bytes';
    const value = { nodeFqdn: 'fixture.lab', commandId: 'cmd-1', requestSha256: 'a'.repeat(64),
      coordination: { version: 1 as const, resourceKey: 'node:fixture', fence: '2', expiresAt: 1000 },
      disposition: 'effects_verified' as const, evidenceSha256: 'e'.repeat(64), approvalRef: 'telegram:1', decisionId: 'decision-1', expiresAt: 2000 };
    const signed = { ...value, signature: createHmac('sha256', key).update(commandReconciliationSigningPayload(value)).digest('hex') };
    expect(verifyCommandReconciliation(signed, key)).toBe(true);
    expect(commandReconciliationSigningPayload(value)).toContain('magnus.command-reconciliation.v1');
    for (const patch of [{ nodeFqdn: 'other.lab' }, { commandId: 'cmd-2' }, { requestSha256: 'b'.repeat(64) },
      { evidenceSha256: 'f'.repeat(64) }, { approvalRef: 'telegram:2' }, { decisionId: 'decision-2' },
      { expiresAt: 2001 }, { disposition: 'no_effect_verified' as const }, { coordination: undefined }]) {
      expect(verifyCommandReconciliation({ ...signed, ...patch }, key)).toBe(false);
    }
    expect(verifyCommandReconciliation(signed, secret)).toBe(false);
    expect(verifyCommandReconciliation({ ...signed, signature: signCommandResult(result, key) }, key)).toBe(false);
  });
});
