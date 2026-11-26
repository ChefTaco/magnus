import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn(), chat: vi.fn() }));
vi.mock('../db/index.js', () => ({ getDb: () => ({ aiScheduledOp: { findMany: mocks.findMany, updateMany: mocks.updateMany, update: mocks.update } }) }));
vi.mock('./ai-assistant-service.js', () => ({ chat: mocks.chat }));

const { executeDueOps, startAiScheduler, stopAiScheduler } = await import('./ai-schedule-service.js');

const due = new Date('2026-11-26T10:00:00Z');
const op = { id: 'op-1', cronExpr: '0 * * * *', prompt: 'check disks', type: 'analysis', nodeId: null, nextRunAt: due, enabled: true };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([op]);
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.update.mockResolvedValue({});
  mocks.chat.mockResolvedValue({ content: 'all good' });
});

describe('scheduled AI operations', () => {
  it('claims an occurrence with a compare-and-set on nextRunAt before running it', async () => {
    expect(await executeDueOps(() => new Date('2026-11-26T10:00:30Z'))).toBe(1);
    const claim = mocks.updateMany.mock.calls[0]?.[0];
    expect(claim.where).toEqual({ id: 'op-1', enabled: true, nextRunAt: due });
    expect(claim.data.nextRunAt.getTime()).toBeGreaterThan(due.getTime());
    expect(mocks.updateMany.mock.invocationCallOrder[0]).toBeLessThan(mocks.chat.mock.invocationCallOrder[0]!);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastResult: 'all good', lastError: null }) }));
  });

  it('skips an occurrence another caller already claimed', async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });
    expect(await executeDueOps()).toBe(0);
    expect(mocks.chat).not.toHaveBeenCalled();
  });

  it('runs an occurrence once when two callers race', async () => {
    let claimed = false;
    mocks.updateMany.mockImplementation(async () => { const count = claimed ? 0 : 1; claimed = true; return { count }; });
    await Promise.all([executeDueOps(), executeDueOps()]);
    expect(mocks.chat).toHaveBeenCalledOnce();
  });

  it('records a failure without retrying before the next occurrence', async () => {
    mocks.chat.mockRejectedValue(new Error('provider down'));
    expect(await executeDueOps()).toBe(0);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastError: 'provider down' }) }));
    expect(mocks.updateMany).toHaveBeenCalledOnce();
  });

  it('starts the server-side scheduler only when enabled', () => {
    vi.stubEnv('MAGNUS_AI_SCHEDULER_ENABLED', 'false');
    expect(startAiScheduler()).toBe(false);
    vi.stubEnv('MAGNUS_AI_SCHEDULER_ENABLED', 'true');
    expect(startAiScheduler(60_000)).toBe(true);
    expect(startAiScheduler(60_000)).toBe(false);
    stopAiScheduler();
    vi.unstubAllEnvs();
  });

  it('records a run that stopped at a tool needing approval as not completed', async () => {
    mocks.chat.mockResolvedValue({ content: 'I need to run a command', conversationId: 'conv-9', pendingApproval: { toolName: 'execCommand' } });
    expect(await executeDueOps()).toBe(0);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastError: expect.stringContaining('execCommand') }) }));
  });
});
