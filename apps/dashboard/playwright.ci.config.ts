import { defineConfig } from '@playwright/test';
// The harness points HIVE_ROUTER_ADMIN_URL here (scripts/start-ui-ci.mjs); tests/embedded-isolation.spec.ts serves it.
process.env['MAGNUS_EMBED_FIXTURE_PORT'] = '55443';
export default defineConfig({
  testDir: './tests',
  testMatch: ['ci-workflows.spec.ts', 'ardent.spec.ts', 'console-security.spec.ts', 'embedded-isolation.spec.ts'],
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
