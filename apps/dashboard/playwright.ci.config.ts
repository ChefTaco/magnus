import { defineConfig, devices } from '@playwright/test';

// The disposable harness has one inert node (no agent answers), one Hermes installation on a
// fixture node reached over SSH (scripts/ci-hermes-ssh-fixture.mjs) and no Codex clients, so these
// specs stay out:
// - nodes, features, files: need a reachable agent (live health, Mission Control tiers, file reads).
// - remediation: creates and deletes rules against agent definitions the harness does not have.
// - codex-fleet: expects installed, OAuth-authenticated Codex clients.
// - orchestra-fleet, orchestra-web-gateway: need a real Hermes Agent behind the installation.
// - visual-review: an opt-in screenshot pass (UI_REVIEW=1), not a check.
const signedIn = ['accessibility.spec.ts', 'api-docs.spec.ts', 'app.spec.ts', 'navigation.spec.ts', 'p1-features.spec.ts', 'status.spec.ts'];

// Inputs of the shared specs, matching scripts/start-ui-ci.mjs.
process.env['TEST_USERNAME'] ??= 'ci-admin';
process.env['TEST_PASSWORD'] ??= 'ci-only-browser-password';
process.env['MAGNUS_SECURITY_CONSOLE_URL'] ??= 'https://security.example.invalid';
// The main console runs with the Hermes Agent integration; a second one on 55452 runs without it.
process.env['MAGNUS_HERMES_ENABLED'] = 'true';
// The Hermes installation's dashboard listener on the fixture node; tests/embedded-isolation.spec.ts serves it.
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
    // The harness's second console, without the Hermes Agent integration (same session store).
    { name: 'ci-hermes-off', testMatch: 'hermes-disabled.spec.ts', dependencies: ['ci-setup'],
      use: { storageState: 'tests/.auth/ci-admin.json', baseURL: 'http://localhost:55452' } },
  ],
  webServer: {
    command: 'node ../../scripts/start-ui-ci.mjs',
    url: 'http://localhost:55442/login',
    timeout: 60000,
    reuseExistingServer: false,
  },
});
