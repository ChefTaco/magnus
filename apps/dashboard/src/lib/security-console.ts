import { connection } from 'next/server';
import { notFound, redirect } from 'next/navigation';
import { securityConsoleUrl } from '../../runtime-integrations.mjs';

/** Runtime security console base URL (MAGNUS_SECURITY_CONSOLE_URL), or null. */
export async function configuredSecurityConsoleUrl(): Promise<string | null> {
  await connection();
  return securityConsoleUrl();
}

/** Send a legacy `/security-fusion/*` deep link to the external console, or 404 when none is configured. */
export async function redirectToSecurityConsole(path: string): Promise<never> {
  const base = await configuredSecurityConsoleUrl();
  if (!base) notFound();
  redirect(`${base}${path}`);
}
