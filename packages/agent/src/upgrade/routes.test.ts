import { afterEach, describe, expect, it, vi } from 'vitest';

const stageUpgrade = vi.fn();
vi.mock('./self-upgrade.js', async importOriginal => ({ ...(await importOriginal<typeof import('./self-upgrade.js')>()), stageUpgrade }));
const { agentUpgradeRoutes, RESTART_DELAY_MS } = await import('./routes.js');
const { EXIT_BACKSTOP_MS, SelfUpgradeError } = await import('./self-upgrade.js');

const body = { version: '1.1.3', integrity: `sha512-${'A'.repeat(86)}==`, requestId: 'req-1' };
const post = () => agentUpgradeRoutes.request('/', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

describe('agent upgrade route', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); stageUpgrade.mockReset(); });

  it('answers a repeated request with the current state and does not restart', async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    stageUpgrade.mockResolvedValue({ from: '1.1.2', to: '1.1.3', integrity: body.integrity, requestId: 'req-1', repeated: true, upgrade: { state: 'trial' } });
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { repeated: true, upgrade: { state: 'trial' } } });
    vi.advanceTimersByTime(EXIT_BACKSTOP_MS);
    expect(kill).not.toHaveBeenCalled();
  });

  it('restarts after staging, with an exit backstop', async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    stageUpgrade.mockResolvedValue({ from: '1.1.2', to: '1.1.3', integrity: body.integrity, requestId: 'req-1' });
    expect((await post()).status).toBe(200);
    vi.advanceTimersByTime(RESTART_DELAY_MS);
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    vi.advanceTimersByTime(EXIT_BACKSTOP_MS);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('keeps the error envelope and status of a refusal', async () => {
    stageUpgrade.mockRejectedValue(new SelfUpgradeError('SELF_UPGRADE_TIMEOUT', 'npm install did not finish within 480 s', 504));
    const response = await post();
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ success: false, error: { code: 'SELF_UPGRADE_TIMEOUT', message: 'npm install did not finish within 480 s' } });
  });
});
