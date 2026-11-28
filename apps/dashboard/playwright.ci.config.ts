import { defineConfig, devices } from '@playwright/test';

// The disposable harness has one inert node (no agent answers), no Hermes Agent integration and
// no Codex clients, so these specs stay out:
// - nodes, features, files: need a reachable agent (live health, Mission Control tiers, file reads).
// - remediation: creates and deletes rules against agent definitions the harness does not have.
// - codex-fleet: expects installed, OAuth-authenticated Codex clients.
// - orchestra-fleet, orchestra-web-gateway: need an enabled Hermes Agent integration.
// - visual-review: an opt-in screenshot pass (UI_REVIEW=1), not a check.
const signedIn = ['accessibility.spec.ts', 'api-docs.spec.ts', 'app.spec.ts', 'navigation.spec.ts', 'p1-features.spec.ts', 'status.spec.ts'];

// Inputs of the shared specs, matching scripts/start-ui-ci.mjs.
process.env['TEST_USERNAME'] ??= 'ci-admin';
process.env['TEST_PASSWORD'] ??= 'ci-only-browser-password';
process.env['MAGNUS_SECURITY_CONSOLE_URL'] ??= 'https://security.example.invalid';
// The harness points HIVE_ROUTER_ADMIN_URL here (scripts/start-ui-ci.mjs); tests/embedded-isolation.spec.ts serves it.
process.env['MAGNUS_EMBED_FIXTURE_PORT'] = '55443';

export default defineConfig({
  testDir: './tests',
  globalSetup: './tests/ci-global-setup.ts',
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 30000,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report-ci', open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://localhost:55442',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // These sign in (or refuse to) themselves.
    { name: 'ci', testMatch: ['ci-workflows.spec.ts', 'ardent.spec.ts', 'console-security.spec.ts', 'login-lockout.spec.ts', 'embedded-isolation.spec.ts'] },
    { name: 'ci-setup', testMatch: 'ci-auth.setup.ts' },
    { name: 'ci-signed-in', testMatch: signedIn, dependencies: ['ci-setup'], use: { storageState: 'tests/.auth/ci-admin.json' } },
  ],
  webServer: {
    command: 'node ../../scripts/start-ui-ci.mjs',
    url: 'http://localhost:55442/login',
    timeout: 60000,
    reuseExistingServer: false,
  },
});
