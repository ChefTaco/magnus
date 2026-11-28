import { revokeLocalSession } from '@/lib/local-sessions';
import { recordSecurityEvent } from '@/lib/security-events';
/**
 * POST /api/auth/logout
 *
 * Clears the local dashboard session cookie.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE_NAME, verifySessionToken } from '@/lib/auth';
import { cookies } from 'next/headers';
import { revokeHiveSession } from '@/lib/hive-login';
import { clearFrameSessionState, clearFrameUserState } from '../../../../../runtime-embed-isolation.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  let session;
  try {
    session = token ? await verifySessionToken(token, true) : null;
  } catch {
    return NextResponse.json(
      { error: 'Session revocation unavailable; retry sign out' },
      { status: 503 },
    );
  }
  if (session)
    await recordSecurityEvent(
      'auth.logout',
      request.headers,
      session.username,
      session.provider === 'hive' ? 'hive' : 'local',
    ).catch(() => undefined);
  if (session) {
    try {
      if (session.provider === 'hive') await revokeHiveSession(session);
      else {
        const all = request.nextUrl.searchParams.get('all') === 'true';
        await revokeLocalSession(session, all);
        // The embedded dashboards' server-side state (Hermes tokens, router cookies) goes too.
        // (All of this user's sessions with `all=true`; other users keep theirs.)
        if (all) clearFrameUserState(session.username);
        else if (session.sessionId) clearFrameSessionState(session.sessionId);
      }
    } catch {
      return NextResponse.json(
        { error: 'Session revocation unavailable; retry sign out' },
        { status: 503 },
      );
    }
  }
  const response = NextResponse.json({ ok: true });

  response.cookies.set(COOKIE_NAME, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });

  return response;
}
