import { test, expect } from '@playwright/test';

test('logged-out terminal websocket upgrade is rejected', async ({ page, baseURL }) => {
  await page.context().clearCookies();
  const result = await page.evaluate(async (url) => {
    return await new Promise<string>((resolve) => {
      const ws = new WebSocket(url.replace(/^http/, 'ws') + '/api/terminal/ws?host=localhost');
      ws.onopen = () => {
        ws.close();
        resolve('opened');
      };
      ws.onclose = (event) => resolve(`closed:${event.code}`);
      ws.onerror = () => resolve('error');
      setTimeout(() => resolve('timeout'), 3000);
    });
  }, baseURL ?? 'https://localhost:3000');

  expect(result).not.toBe('opened');
});

