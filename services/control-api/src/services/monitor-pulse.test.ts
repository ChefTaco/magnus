import { describe, expect, it, vi } from 'vitest';
import { monitorsHealthy, recordMonitorPulse } from './monitor-pulse.js';
describe('independent monitor pulse', () => {
  it('fails closed until every loop reports progress and detects one stalled loop', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(monitorsHealthy(now)).toBe(false);
    for (const name of ['commands','webhooks','rollouts','applications','nodes'] as const) recordMonitorPulse(name);
    expect(monitorsHealthy(now)).toBe(true);
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    for (const name of ['commands','rollouts','applications','nodes'] as const) recordMonitorPulse(name);
    expect(monitorsHealthy(now + 61_000)).toBe(false);
    recordMonitorPulse('webhooks');
    expect(monitorsHealthy(now + 61_000)).toBe(true);
    vi.restoreAllMocks();
  });
});
