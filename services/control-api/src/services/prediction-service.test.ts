import { describe, expect, it, vi } from 'vitest';

const findMany = vi.hoisted(() => vi.fn(async () => []));
vi.mock('../db/index.js', () => ({ getDb: () => ({ healthSnapshot: { findMany } }) }));
vi.mock('./notification-service.js', () => ({ createNotification: vi.fn() }));
vi.mock('./event-bus.js', () => ({ eventBus: { publish: vi.fn() }, EventChannels: { ALERT_FIRED: 'alert:fired' } }));

const { evaluatePredictionsForHeartbeat } = await import('./prediction-service.js');

describe('heartbeat prediction throttle', () => {
  it('reads snapshots at most once per node per interval', async () => {
    const start = 1_000_000;
    expect(await evaluatePredictionsForHeartbeat('node-a', 'a', start)).toEqual([]);
    expect(await evaluatePredictionsForHeartbeat('node-a', 'a', start + 30_000)).toBeNull();
    expect(await evaluatePredictionsForHeartbeat('node-b', 'b', start + 30_000)).toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(await evaluatePredictionsForHeartbeat('node-a', 'a', start + 5 * 60_000)).toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(3);
  });
});
