import { afterEach, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() =>
  vi.fn(async (c: any, next: () => Promise<void>) => {
    if (c.req.header('authorization') !== 'Bearer fixture-session')
      return c.json({ error: 'Unauthorized' }, 401);
    await next();
  }),
);
vi.mock('../middleware/auth.js', () => ({ authMiddleware: auth }));
import { securityFusionRouter } from './security-fusion.js';
afterEach(() => {
  vi.unstubAllEnvs();
  auth.mockClear();
});
it('keeps retired security endpoints absent when the integration is disabled', async () => {
  vi.stubEnv('SECURITY_FUSION_MODE', 'off');
  expect((await securityFusionRouter.request('/overview')).status).toBe(404);
  expect(auth).not.toHaveBeenCalled();
});
it('authenticates compatibility responses and links to the external product in remote mode', async () => {
  vi.stubEnv('SECURITY_FUSION_MODE', 'remote');
  vi.stubEnv('MAGNUS_SECURITY_CONSOLE_URL', 'https://security.example.com');
  expect((await securityFusionRouter.request('/cases')).status).toBe(401);
  const response = await securityFusionRouter.request('/cases', {
    headers: { authorization: 'Bearer fixture-session' },
  });
  expect(response.status).toBe(410);
  expect(await response.json()).toMatchObject({
    error: { code: 'SECURITY_FUSION_MOVED', url: 'https://security.example.com' },
  });
});
