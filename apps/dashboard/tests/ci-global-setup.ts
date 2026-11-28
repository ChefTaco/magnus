import { resetLoginLimiter } from './ci-login-limiter';

// A local rerun inside the limiter window must not inherit the previous run's sign-ins.
export default async function globalSetup(): Promise<void> {
  await resetLoginLimiter();
}
