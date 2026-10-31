import { afterEach, describe, expect, it, vi } from 'vitest';
import { approvalDigest } from '../security/approval-assertion.js';
import { forwardSecurityFusionApproval, listSecurityFusionApprovalPlans } from './security-fusion-approvals.js';

function plan() {
  const value = { plan_id: 'containment:action-1', revision: 1, action: 'security.containment.host_isolation',
    targets: ['node-1'], steps: ['Isolate node'], risk: 'Connectivity loss', rollback: 'Automatic release',
    evidence: ['security-case:case-1'], expires_at: Date.now() + 60_000 };
  return { ...value, plan_sha256: approvalDigest(value) };
}
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('Security Fusion approval proxy', () => {
  it('is disabled when unconfigured and validates exact remote plan digests', async () => {
    expect(await listSecurityFusionApprovalPlans()).toEqual([]);
    vi.stubEnv('SECURITY_FUSION_API_URL', 'https://guard.example:4101');
    vi.stubEnv('SECURITY_APPROVAL_BRIDGE_TOKEN', 'b'.repeat(40));
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { plans: [plan()] } })));
    vi.stubGlobal('fetch', fetcher);
    expect((await listSecurityFusionApprovalPlans())[0]).toMatchObject({ plan_id: 'containment:action-1' });
    expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({ Authorization: `Bearer ${'b'.repeat(40)}` });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true,
      data: { plans: [{ ...plan(), plan_sha256: '0'.repeat(64) }] } }))));
    await expect(listSecurityFusionApprovalPlans()).rejects.toThrow('digest is invalid');
  });
  it('forwards the original signed assertion only to the fixed decision endpoint', async () => {
    vi.stubEnv('SECURITY_FUSION_API_URL', 'https://guard.example:4101');
    vi.stubEnv('SECURITY_APPROVAL_BRIDGE_TOKEN', 'b'.repeat(40));
    const assertion = { payload: { version: 2 }, signature: 'signed' };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { decision_id: 'd1' } })));
    vi.stubGlobal('fetch', fetcher);
    expect(await forwardSecurityFusionApproval(assertion)).toEqual({ decision_id: 'd1' });
    expect(fetcher.mock.calls[0]![0]).toBe('https://guard.example:4101/api/v1/security-fusion/approval-decisions');
    expect(fetcher.mock.calls[0]![1]?.body).toBe(JSON.stringify(assertion));
  });
});
