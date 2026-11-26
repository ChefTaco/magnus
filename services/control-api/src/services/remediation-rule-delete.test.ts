import { beforeEach, describe, expect, it, vi } from 'vitest';

const tx = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  remediationExecution: { count: vi.fn() },
  remediationRule: { delete: vi.fn() },
}));
vi.mock('../db/index.js', () => ({
  getDb: () => ({ $transaction: (work: (client: typeof tx) => Promise<unknown>) => work(tx) }),
}));

const { deleteRule } = await import('./remediation-service.js');

beforeEach(() => {
  vi.clearAllMocks();
  tx.$queryRaw.mockResolvedValue([{ id: 'rule-1' }]);
  tx.remediationExecution.count.mockResolvedValue(0);
  tx.remediationRule.delete.mockResolvedValue({});
});

describe('remediation rule deletion', () => {
  it('deletes a rule that never ran, under a row lock', async () => {
    await deleteRule('rule-1');
    expect(String(tx.$queryRaw.mock.calls[0]?.[0]?.join('?'))).toMatch(/FOR UPDATE/);
    expect(tx.remediationRule.delete).toHaveBeenCalledWith({ where: { id: 'rule-1' } });
  });

  it('keeps a rule with executions, so approvals and history survive', async () => {
    tx.remediationExecution.count.mockResolvedValue(3);
    await expect(deleteRule('rule-1')).rejects.toMatchObject({ status: 409, code: 'RULE_HAS_EXECUTIONS' });
    expect(tx.remediationRule.delete).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown rule', async () => {
    tx.$queryRaw.mockResolvedValue([]);
    await expect(deleteRule('missing')).rejects.toMatchObject({ status: 404 });
    expect(tx.remediationRule.delete).not.toHaveBeenCalled();
  });
});
