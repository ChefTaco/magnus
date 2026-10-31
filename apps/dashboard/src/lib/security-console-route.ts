import { NextResponse } from 'next/server';
import { securityConsoleUrl } from '../../runtime-integrations.mjs';

/**
 * Legacy `/security-fusion/*` deep links: redirect to the configured external
 * security console, or a real 404 when none is configured. Returns null for
 * every other path (the `/security-fusion` summary page renders normally).
 */
export function securityConsoleDeepLink(
  url: URL,
  env: Record<string, string | undefined> = process.env,
): NextResponse | null {
  if (!url.pathname.startsWith('/security-fusion/')) return null;
  const base = securityConsoleUrl(env);
  if (!base) return new NextResponse('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  return NextResponse.redirect(`${base}${url.pathname}${url.search}`, 307);
}
