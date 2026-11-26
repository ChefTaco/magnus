import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { COOKIE_NAME, sessionSecretDiagnostics } from '@/lib/auth-constants';
import { verifySessionToken } from '@/lib/auth';
import { hermesSecurityEventDiagnostics } from '../../../../runtime-hermes-security-event-state.mjs';
import { dashboardCredentialDiagnostics } from '../../../../runtime-dashboard-credentials.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A signed-in administrator, or null. Errors count as signed out. */
async function signedIn(): Promise<boolean> {
  try {
    const token = (await cookies()).get(COOKIE_NAME)?.value;
    return token ? Boolean(await verifySessionToken(token)) : false;
  } catch {
    return false;
  }
}

/**
 * GET /api/health is public (load balancers, the container health check), so it answers only
 * `status`. How the console is configured (login source, SSH, credential metadata, the session
 * secret source) goes only to a signed-in administrator. A credential misconfiguration is
 * `unhealthy` with 503, never an unhandled 500.
 */
export async function GET(): Promise<NextResponse> {
  const session = sessionSecretDiagnostics();
  const securityEvents = hermesSecurityEventDiagnostics();
  let dashboardCredentials: ReturnType<typeof dashboardCredentialDiagnostics> | { error: string };
  let credentialsValid = true;
  try {
    dashboardCredentials = dashboardCredentialDiagnostics();
  } catch (error) {
    credentialsValid = false;
    dashboardCredentials = { error: error instanceof Error ? error.message : 'Dashboard credentials are misconfigured' };
  }
  const healthy = session.configured && credentialsValid;
  const degraded = session.legacyFallbackActive || securityEvents.droppedEvents > 0;
  const status = healthy ? (degraded ? 'degraded' : 'healthy') : 'unhealthy';
  const body = await signedIn()
    ? { status, diagnostics: { sessionSecret: session, dashboardCredentials, hermesSecurityEvents: securityEvents } }
    : { status };
  return NextResponse.json(body, { status: healthy ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
}
