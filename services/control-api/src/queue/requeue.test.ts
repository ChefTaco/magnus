import { describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import { addDurableJob } from './requeue.js';

function queueWith(state: string | null) {
  const remove = vi.fn().mockResolvedValue(undefined);
  const add = vi.fn().mockResolvedValue(undefined);
  const getJob = vi.fn().mockResolvedValue(state === null ? undefined : { getState: async () => state, remove });
  return { queue: { add, getJob } as unknown as Queue<{ id: string }>, add, remove };
}

describe('durable job requeue', () => {
  it('removes a retained completed job so a reconciler requeue actually schedules', async () => {
    const { queue, add, remove } = queueWith('completed');
    await addDurableJob(queue, 'execute', { id: 'c1' }, { jobId: 'cmd-c1' });
    expect(remove).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledWith('execute', { id: 'c1' }, { jobId: 'cmd-c1' });
  });

  it.each(['active', 'waiting', 'delayed'])('leaves a %s job untouched', async state => {
    const { queue, add, remove } = queueWith(state);
    await addDurableJob(queue, 'execute', { id: 'c1' }, { jobId: 'cmd-c1' });
    expect(remove).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it('keeps failed jobs when only completed jobs are replaceable', async () => {
    const { queue, add, remove } = queueWith('failed');
    await addDurableJob(queue, 'deliver', { id: 'd1' }, { jobId: 'd1' }, ['completed']);
    expect(remove).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it('adds a job when none is retained', async () => {
    const { queue, add } = queueWith(null);
    await addDurableJob(queue, 'execute', { id: 'c2' }, { jobId: 'cmd-c2' });
    expect(add).toHaveBeenCalledOnce();
  });
});
