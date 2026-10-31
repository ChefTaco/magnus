import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.resolve(import.meta.dirname, '../../.env') });
dotenv.config({ path: path.resolve(import.meta.dirname, '.env') });

const baseURL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'https://localhost:3000';
const useExternalServer = Boolean(process.env['PLAYWRIGHT_BASE_URL']);

export default defineConfig({
  testDir: './tests',
  globalTeardown: './tests/global-teardown.ts',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  // Keep local dev-server compilation and authentication deterministic while
  // retaining enough parallelism for a fast smoke pass. CI remains serial.
  workers: process.env['CI'] ? 1 : 4,
  reporter: [['html', { outputFolder: 'playwright-report' }]],
  timeout: 30_000,

  use: {
    baseURL,
    ignoreHTTPSErrors: true, // self-signed dev certs
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    /* Auth setup — runs once, saves browser storage state */
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },

    /* Main test projects — depend on setup */
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'tests/.auth/user.json',
      },
      dependencies: ['setup'],
    },
    {
      name: 'smoke-chromium',
      testMatch: /(navigation|app|api-docs|status)\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'tests/.auth/user.json',
      },
      dependencies: ['setup'],
    },
    {
      name: 'live-fleet-chromium',
      testMatch: /(nodes|orchestra|features).*\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'tests/.auth/user.json',
      },
      dependencies: ['setup'],
    },
    {
      name: 'destructive-chromium',
      testMatch: /(commands|files|agent-deploy|remediation).*\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'tests/.auth/user.json',
      },
      dependencies: ['setup'],
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        storageState: 'tests/.auth/user.json',
      },
      dependencies: ['setup'],
    },
    /* WebKit skipped — self-signed certs break secure cookies on localhost */
  ],

  /* Start the Next.js dev server before running tests.
   * Remove or adjust if you prefer to run against a pre-started server. */
  webServer: useExternalServer ? undefined : {
    command: 'npm run dev',
    url: baseURL,
    ignoreHTTPSErrors: true,
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});
