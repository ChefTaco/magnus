import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/control-api-fetch', () => ({ controlApiFetch: fetch }));
import { assertTerminalResourceAdmission } from './terminal-resource-admission';
beforeEach(() => { fetch.mockReset(); vi.stubEnv('CONTROL_API_URL', 'https://fixture.control'); vi.stubEnv('API_SECRET', 'fixture-private-server-secret'); });
afterEach(() => { vi.unstubAllEnvs(); });
describe('terminal resource admission', () => {
  it('uses the fixed server origin, encoded inventory target and server-only credential', async () => {
    fetch.mockResolvedValue(new Response(JSON.stringify({ success: true, data: { allowed: true, enrolled: false } })));
    await assertTerminalResourceAdmission('fixture.lab');
    expect(fetch).toHaveBeenCalledWith('https://fixture.control/api/v1/resource-leases/ssh-admission?host=fixture.lab', expect.objectContaining({ redirect: 'error', headers: { 'x-api-secret': 'fixture-private-server-secret' } }));
  });
  it.each([401, 409, 503])('denies terminal opening when authority responds %s', async status => {
    fetch.mockResolvedValue(new Response('{}', { status })); await expect(assertTerminalResourceAdmission('fixture.lab')).rejects.toThrow();
  });
  it('rejects an incomplete or misleading success declaration', async () => {
    fetch.mockResolvedValue(new Response(JSON.stringify({ success: true, data: { allowed: true, enrolled: true } })));
    await expect(assertTerminalResourceAdmission('fixture.lab')).rejects.toThrow('could not be verified');
  });
});
