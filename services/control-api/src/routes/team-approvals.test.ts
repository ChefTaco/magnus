import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../utils/env.js', () => ({
  IAM_CORE_URL: '', IAM_TOKEN_ISSUER: '', IAM_TOKEN_AUDIENCE: '',
  JWT_SECRET: 'isolated-jwt-fixture-secret-at-least-32', API_SECRET: 'isolated-api-fixture-secret-at-least-32',
  MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON: JSON.stringify({
    approvals: '36ee70390b50c30a79e1de2eb5433856657f668498ce68a925bbbf53e941b3d5',
    magnus: '4cd2cd8ce912b646598abfc7c79e8fd745b31d27e953cbc3eaca9bc6d11cc561',
  }), MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256: '', MAGNUS_FLEET_CHECK_TOKEN_SHA256: '', MAGNUS_COLLECTOR_TOKEN_SHA256: '',
  MAGNUS_PLUGIN_API_ENABLED: true, MAGNUS_APPROVAL_BRIDGE_CONSUMER: 'approvals',
}));
vi.mock('../services/credential-rotation-service.js', () => ({ verifyWithRotation: (_: string, expected: string, actual: string) => expected === actual }));
const storage = vi.hoisted(() => ({ transaction: vi.fn(), findMany: vi.fn(async () => []) }));
vi.mock('../db/index.js', () => ({ getDb: () => ({ $transaction: storage.transaction, remediationExecution: { findMany: storage.findMany } }) }));
import { teamApprovalRouter } from './team-approvals.js';
import { errorHandler } from '../middleware/error-handler.js';
const app = new Hono().route('/api/v1/team-approvals', teamApprovalRouter).onError(errorHandler);
const token = 'approvals-plugin-read-token-for-unit-tests';
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe('approval bridge HTTP boundary', () => {
  it('allows only the scoped approval bridge discovery and denies anonymous/general service access', async () => {
    expect((await app.request('/api/v1/team-approvals/plans', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect(storage.findMany).toHaveBeenCalledOnce();
    expect((await app.request('/api/v1/team-approvals/plans')).status).toBe(401);
    expect((await app.request('/api/v1/team-approvals/plans', { headers: { 'x-api-secret': 'isolated-api-fixture-secret-at-least-32' } })).status).toBe(403);
  });
  it('cannot turn a valid read credential into an operator decision', async () => {
    vi.stubEnv('APPROVAL_TELEGRAM_ACTOR_SHA256', 'b'.repeat(64));
    const payload = { version: 2, proposal_id: 'remediation:fixture', proposal_revision: 1,
      plan_sha256: 'a'.repeat(64), decision: 'approve', decision_id: 'fixture-decision',
      decided_at: Date.now(), expires_at: Date.now() + 60_000, actor_binding_sha256: 'b'.repeat(64), execution_id: 'fixture-execution' };
    const response = await app.request('/api/v1/team-approvals/decisions', { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ payload, signature: 'A'.repeat(86) }) });
    expect(response.status).toBe(403);
    expect(storage.transaction).not.toHaveBeenCalled();
  });
});
