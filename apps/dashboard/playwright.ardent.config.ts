import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: 'ardent.spec.ts',
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.ARDENT_PLAYWRIGHT_BASE_URL ?? 'https://localhost:3000',
    ignoreHTTPSErrors: true,
    ...(process.env.ARDENT_PLAYWRIGHT_STORAGE_STATE ? { storageState: process.env.ARDENT_PLAYWRIGHT_STORAGE_STATE } : {}),
  },
});
