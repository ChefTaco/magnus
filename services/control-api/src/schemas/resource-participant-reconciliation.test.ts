import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  participantWorkReconciliationSchema,
  participantWorkReconciliationSigningPayload,
  participantWorkRequestDigest,
} from './resource-participant-reconciliation.js';

const identity = { participant: 'dashboard' as const, workId: '1c538fc4-4d17-40c0-8d01-c30884ea32a4',
  nodeId: 'node-fixture', nodeFqdn: 'fixture.invalid', ownerId: 'cd3078e3-a891-44dd-bb1c-32ce61b51e28',
  kind: 'hermes-http' as const, epoch: 4, barrierId: '63ce1108-dfeb-48e9-bc33-a906145a740e',
  operationSha256: 'd'.repeat(64), fence: '7', deadline: 1_800_000_000_000 };

describe('participant work reconciliation wire contract', () => {
  it('binds every reservation identity field and uses a separate signing domain', () => {
    const requestSha256 = participantWorkRequestDigest(identity);
    expect(requestSha256).toMatch(/^[a-f0-9]{64}$/);
    for (const [key, value] of Object.entries(identity)) {
      const changed = { ...identity, [key]: typeof value === 'number' ? value + 1 : key === 'barrierId'
        ? '743d07c5-86cf-4551-a25a-eb052cc44a14' : `${value}-other` } as typeof identity;
      expect(participantWorkRequestDigest(changed)).not.toBe(requestSha256);
    }
    const unsigned = { version: 1 as const, ...identity, requestSha256, disposition: 'effects_verified' as const,
      evidenceSha256: 'a'.repeat(64), approvalRef: 'telegram:decision', decisionId: 'decision-one',
      expiresAt: Date.now() + 60_000 };
    const payload = participantWorkReconciliationSigningPayload(unsigned);
    expect(payload).toContain('magnus.resource-participant-reconciliation.v1');
    expect(payload).not.toContain('magnus.command-reconciliation.v1');
    expect(participantWorkReconciliationSchema.parse({ ...unsigned,
      signature: createHmac('sha256', 'fixture-key-at-least-32-characters').update(payload).digest('hex') })).toBeTruthy();
  });
  it('rejects extra fields and malformed exact bindings', () => {
    const base = { version: 1, ...identity, requestSha256: 'a'.repeat(64), disposition: 'no_effect_verified',
      evidenceSha256: 'b'.repeat(64), approvalRef: 'review:one', decisionId: 'decision-one', expiresAt: Date.now() + 1,
      signature: 'c'.repeat(64) };
    expect(participantWorkReconciliationSchema.safeParse({ ...base, release: true }).success).toBe(false);
    expect(participantWorkReconciliationSchema.safeParse({ ...base, requestSha256: 'A'.repeat(64) }).success).toBe(false);
    expect(participantWorkReconciliationSchema.safeParse({ ...base, participant: 'agent' }).success).toBe(false);
  });
});
