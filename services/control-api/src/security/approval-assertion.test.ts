import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approvalAssertionDomains, approvalCanonicalJson, requireFreshApproval, verifyApprovalAssertion, type ApprovalPayload } from './approval-assertion.js';
import { approvalSignerPublicKeyB64, signApprovalAssertion } from './approval-assertion-test-fixture.js';

const actor = 'b'.repeat(64);
const payload = (): ApprovalPayload => ({ version: 2, proposal_id: 'remediation:test', proposal_revision: 1,
  plan_sha256: 'a'.repeat(64), decision: 'approve', decision_id: 'decision-1', decided_at: Date.now(),
  expires_at: Date.now()+60_000, actor_binding_sha256: actor, execution_id: 'execution-1' });

beforeEach(() => {
  vi.stubEnv('APPROVAL_SIGNER_PUBLIC_KEY_B64', approvalSignerPublicKeyB64);
  vi.stubEnv('APPROVAL_TELEGRAM_ACTOR_SHA256', actor);
});
afterEach(() => vi.unstubAllEnvs());

describe('isolated native Telegram decision assertion', () => {
  it('matches compact Python ASCII JSON including supplementary Unicode', () => {
    expect(approvalCanonicalJson('\x7f')).toBe('"\\u007f"');
    expect(approvalCanonicalJson({ text: 'résumé 🚀', values: [true, null] }))
      .toBe('{"text":"r\\u00e9sum\\u00e9 \\ud83d\\ude80","values":[true,null]}');
  });
  it('verifies only the exact Ed25519 decision and configured operator binding', () => {
    const message = signApprovalAssertion(payload());
    expect(verifyApprovalAssertion(message).payload).toEqual(message.payload);
    for (const change of [{ decision: 'reject', execution_id: null }, { plan_sha256: 'c'.repeat(64) },
      { actor_binding_sha256: 'd'.repeat(64) }, { proposal_revision: 2 }, { execution_id: 'different' }])
      expect(() => verifyApprovalAssertion({ ...message, payload: { ...message.payload, ...change } })).toThrow();
  });
  it('verifies v3 iPhone decisions against the separate iPhone actor binding', () => {
    const iphone = { ...payload(), version: 3 as const, source_channel: 'iphone' as const };
    vi.stubEnv('APPROVAL_IPHONE_ACTOR_SHA256', actor);
    const message = signApprovalAssertion(iphone);
    expect(verifyApprovalAssertion(message).payload).toEqual(iphone);
    vi.stubEnv('APPROVAL_IPHONE_ACTOR_SHA256', 'c'.repeat(64));
    expect(() => verifyApprovalAssertion(message)).toThrow('authentication failed');
  });
  it('rejects legacy HMAC v1, missing public key, extra fields and caller-authored approver', () => {
    const current = signApprovalAssertion(payload());
    expect(() => verifyApprovalAssertion({ payload: { ...payload(), version: 1 }, signature: 'f'.repeat(64) })).toThrow();
    expect(() => verifyApprovalAssertion({ ...current, approver: 'operator' })).toThrow();
    expect(() => verifyApprovalAssertion({ payload: { ...payload(), approvedBy: 'operator' }, signature: 'A'.repeat(86) })).toThrow();
    vi.stubEnv('APPROVAL_SIGNER_PUBLIC_KEY_B64', '');
    expect(() => verifyApprovalAssertion(current)).toThrow('authentication failed');
  });
  it('rejects expired, future or excessively long first-use decisions', () => {
    requireFreshApproval(payload());
    for (const change of [{ expires_at: Date.now()-1 }, { decided_at: Date.now()+40_000 },
      { expires_at: Date.now()+16*60_000 }])
      expect(() => requireFreshApproval({ ...payload(), ...change })).toThrow();
  });
});

describe('configurable approval signature domains', () => {
  it('defaults to the current domain and validates the configured list', () => {
    expect(approvalAssertionDomains(undefined)).toEqual(['magnus.approval-assertion']);
    expect(approvalAssertionDomains(' magnus.approval-assertion , legacy.approval,legacy.approval ')).toEqual(['magnus.approval-assertion', 'legacy.approval']);
    for (const invalid of [',', 'Legacy.Approval', 'legacy approval', 'legacy\nx', '.legacy', 'legacy.', 'legacy_approval', 'x'.repeat(101)])
      expect(() => approvalAssertionDomains(invalid), invalid).toThrow(/MAGNUS_APPROVAL_ASSERTION_DOMAINS/);
  });
  it('rejects a legacy signer domain unless it is configured', () => {
    const legacy = signApprovalAssertion(payload(), 'legacy.approval');
    expect(() => verifyApprovalAssertion(legacy)).toThrow('authentication failed');
    vi.stubEnv('MAGNUS_APPROVAL_ASSERTION_DOMAINS', 'magnus.approval-assertion,legacy.approval');
    expect(verifyApprovalAssertion(legacy).payload).toEqual(legacy.payload);
    expect(verifyApprovalAssertion(signApprovalAssertion(payload())).payload.decision).toBe('approve');
    expect(() => verifyApprovalAssertion(signApprovalAssertion(payload(), 'other.approval'))).toThrow('authentication failed');
  });
  it('stops accepting the default domain when the list omits it', () => {
    vi.stubEnv('MAGNUS_APPROVAL_ASSERTION_DOMAINS', 'legacy.approval');
    expect(() => verifyApprovalAssertion(signApprovalAssertion(payload()))).toThrow('authentication failed');
    expect(verifyApprovalAssertion(signApprovalAssertion(payload(), 'legacy.approval')).payload.version).toBe(2);
  });
  it('fails closed when the configured list is malformed', () => {
    vi.stubEnv('MAGNUS_APPROVAL_ASSERTION_DOMAINS', 'bad domain');
    expect(() => verifyApprovalAssertion(signApprovalAssertion(payload()))).toThrow('authentication failed');
  });
});
