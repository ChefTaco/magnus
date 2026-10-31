import { NextResponse } from 'next/server';
import { sessionSecretDiagnostics } from '@/lib/auth-constants';
import { hermesSecurityEventDiagnostics } from '../../../../runtime-hermes-security-event-state.mjs';
import { dashboardCredentialDiagnostics } from '../../../../runtime-dashboard-credentials.mjs';

export const runtime = 'nodejs';

export function GET(): NextResponse {
  const session = sessionSecretDiagnostics();
  const securityEvents = hermesSecurityEventDiagnostics();
  const dashboardCredentials = dashboardCredentialDiagnostics();
  const degraded = session.legacyFallbackActive || securityEvents.droppedEvents > 0;
  return NextResponse.json({
    status: session.configured ? (degraded ? 'degraded' : 'healthy') : 'unhealthy',
    diagnostics: {
      sessionSecret: session,
      dashboardCredentials,
      hermesSecurityEvents: securityEvents,
    },
  }, { status: session.configured ? 200 : 503 });
}
