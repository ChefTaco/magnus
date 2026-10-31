import type { JobsOptions, Queue } from 'bullmq';

type FinishedState = 'completed' | 'failed';

/**
 * Add a job under a durable, deterministic job ID. BullMQ silently ignores
 * `add()` while a job with the same ID is retained, including retained
 * finished jobs, so a durable reconciler's requeue would never run again.
 * A retained job in one of `replaceFinished` states is removed first; waiting,
 * delayed, and active jobs are left untouched so the add stays a no-op for them.
 * The database CAS claim in each worker remains the execution boundary.
 */
export async function addDurableJob<T>(
  queue: Queue<T>,
  name: string,
  data: T,
  opts: JobsOptions & { jobId: string },
  replaceFinished: readonly FinishedState[] = ['completed', 'failed'],
): Promise<void> {
  const existing = await queue.getJob(opts.jobId);
  if (existing) {
    const state = await existing.getState();
    if (state !== 'unknown' && !(replaceFinished as readonly string[]).includes(state)) return;
    if (state !== 'unknown') try {
      await existing.remove();
    } catch {
      // A concurrent reconciler or worker changed the job; the add below is
      // then ignored and the next reconciliation pass retries.
    }
  }
  // BullMQ's generic name/data typing is stricter than the runtime contract.
  await (queue as unknown as Queue).add(name, data, opts);
}
