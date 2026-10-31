import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ add: vi.fn(), getJob: vi.fn(), findMany: vi.fn() }));
vi.mock('bullmq', () => ({ Queue: class { add = mocks.add; getJob = mocks.getJob }, Worker: class {} }));
vi.mock('../db/index.js', () => ({ getDb: () => ({webhookDelivery:{findMany:mocks.findMany}}) }));
import { reconcileWebhookDeliveries } from './webhook-service.js';
beforeEach(() => vi.clearAllMocks());
describe('durable webhook queue admission', () => {
  it('reuses the persisted identity after queue loss while retaining the one-send Mattermost policy', async () => {
    mocks.findMany.mockResolvedValue([{id:'durable-delivery',endpointId:'private-channel',endpoint:{type:'mattermost',retries:10}}]);
    mocks.add.mockRejectedValueOnce(Error('Redis unavailable')).mockResolvedValue(undefined);
    await expect(reconcileWebhookDeliveries()).rejects.toThrow('Redis unavailable');
    await reconcileWebhookDeliveries();
    expect(mocks.add).toHaveBeenNthCalledWith(2,'deliver',{endpointId:'private-channel'},expect.objectContaining({jobId:'durable-delivery',attempts:1}));
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({where:{status:'pending',attempts:0,endpoint:{active:true}}}));
  });
});
