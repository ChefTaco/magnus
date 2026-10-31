import { describe, expect, it } from 'vitest';
import { schedulerSourceSettlementSchema, schedulerSourceSettlementSigningPayload,
  schedulerSourceSettlementReceiptPayload, cronEnrollmentStageSchema, cronEnrollmentStageSigningPayload,
  cronEnrollmentStageReceiptPayload } from './managed-cron.js';
import { schedulerSourceSettlementSchema as nodeSchema,
  schedulerSourceSettlementSigningPayload as nodeSigningPayload,
  schedulerSourceSettlementReceiptPayload as nodeReceiptPayload,
  cronEnrollmentStageSchema as nodeStageSchema, cronEnrollmentStageSigningPayload as nodeStagePayload,
  cronEnrollmentStageReceiptPayload as nodeStageReceiptPayload } from '../../../../packages/agent/src/executors/managed-scheduler.js';
const assertion = { version: 1 as const, sourceIdentityVersion: 2 as const, nodeId: 'fixture', nodeFqdn: 'fixture.invalid', epoch: 2,
  barrierId: '00000000-0000-4000-8000-000000000001', kind: 'SYSTEM_TIMERS', sourceSha256: 'a'.repeat(64),
  count: 2, disposition: 'no_effect_verified' as const, evidenceSha256: 'b'.repeat(64), approvalRef: 'telegram:fixture',
  decisionId: '00000000-0000-4000-8000-000000000002', expiresAt: 2_000_000_000_000, signature: 'c'.repeat(64) };
describe('managed scheduler wire schemas', () => {
  it('keeps exact scheduler settlement parsing and signing identical on API and node', () => {
    expect(schedulerSourceSettlementSchema.parse(assertion)).toEqual(nodeSchema.parse(assertion));
    const { signature: _signature, ...unsigned } = assertion;
    expect(schedulerSourceSettlementSigningPayload(unsigned)).toBe(nodeSigningPayload(unsigned));
    const receipt = { ...unsigned, settled: true as const, replayed: false };
    expect(schedulerSourceSettlementReceiptPayload(receipt)).toBe(nodeReceiptPayload(receipt));
  });
  it('rejects retargeting, unbounded counts and extra fields', () => {
    expect(schedulerSourceSettlementSchema.safeParse({ ...assertion, nodeFqdn: '' }).success).toBe(false);
    expect(schedulerSourceSettlementSchema.safeParse({ ...assertion, count: 1_000_001 }).success).toBe(false);
    const { sourceIdentityVersion: _sourceIdentityVersion, ...legacy } = assertion;
    expect(schedulerSourceSettlementSchema.safeParse(legacy).success).toBe(false);
    expect(schedulerSourceSettlementSchema.safeParse({ ...assertion, extra: true }).success).toBe(false);
  });
  it('keeps disable-only enrollment staging signatures identical on API and node', () => {
    const spec = { nodeFqdn: 'fixture.invalid', name: 'legacy', revision: 1, schedule: '* * * * *', timezone: 'UTC' as const,
      environment: {}, command: '/usr/bin/true', args: [], timeoutSeconds: 60, expiresAt: 2_000_000_000_000 };
    const stage = { version: 1 as const, nodeId: 'fixture', nodeFqdn: spec.nodeFqdn, spec,
      operationId: '00000000-0000-4000-8000-000000000003', expiresAt: 2_000_000_000_000, signature: 'd'.repeat(64) };
    expect(cronEnrollmentStageSchema.parse(stage)).toEqual(nodeStageSchema.parse(stage));
    const { signature: _signature, ...unsigned } = stage;
    expect(cronEnrollmentStageSigningPayload(unsigned)).toBe(nodeStagePayload(unsigned));
    const receipt = { nodeFqdn: spec.nodeFqdn, name: spec.name, jobId: 'a'.repeat(64), revision: 1,
      specSha256: 'b'.repeat(64), operationId: stage.operationId, staged: true as const, enabled: false as const };
    expect(cronEnrollmentStageReceiptPayload(receipt)).toBe(nodeStageReceiptPayload(receipt));
  });
});
