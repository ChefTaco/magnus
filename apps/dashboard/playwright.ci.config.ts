import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: ['ci-workflows.spec.ts', 'ardent.spec.ts'],
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 30000,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report-ci', open: 'never' }]],
  use: {
    baseURL: 'http://localhost:55442',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node ../../scripts/start-ui-ci.mjs',
    url: 'http://localhost:55442/login',
    timeout: 60000,
    reuseExistingServer: false,
  },
});
