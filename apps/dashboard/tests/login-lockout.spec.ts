import { test, expect, type Page } from '@playwright/test';
import { resetLoginLimiter } from './ci-login-limiter';

// Spends the harness's shared sign-in budget on purpose, so it starts and ends with a fresh one.
test.beforeAll(resetLoginLimiter);
test.afterAll(resetLoginLimiter);

async function signIn(page: Page, password: string) {
  await page.getByLabel('Username').fill('ci-admin');
  await page.getByLabel('Password', { exact: true }).fill(password);
  const response = page.waitForResponse((candidate) => new URL(candidate.url()).pathname === '/api/auth/login');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  return response;
}

test('repeated wrong passwords lock the sign-in, even for the right password', async ({ page }) => {
  // Each refusal after the first waits longer (250 ms doubling, at most 4 s).
  test.setTimeout(60_000);
  await page.goto('/login');
  const loginError = page.getByRole('alert').filter({ hasText: /\S/ });

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await signIn(page, `wrong-password-${attempt}`);
    expect(response.status(), `attempt ${attempt}`).toBe(401);
    await expect(loginError).toHaveText('Invalid credentials');
  }

  // The sixth attempt for this source and username is refused before the password is checked.
  const locked = await signIn(page, 'ci-only-browser-password');
  expect(locked.status()).toBe(429);
  expect(locked.headers()['retry-after']).toBe('900');
  await expect(loginError).toHaveText('Too many login attempts. Try again later.');
  await expect(page).toHaveURL('/login');
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);

  // The lock is the limiter's window, not a disabled account.
  await resetLoginLimiter();
  await page.goto('/login');
  expect((await signIn(page, 'ci-only-browser-password')).status()).toBe(200);
  await expect(page).toHaveURL('/');
});
