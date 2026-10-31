import {recordSecurityEvent} from '@/lib/security-events';
import { NextRequest, NextResponse } from 'next/server';
import { finishHiveLogin } from '@/lib/hive-login';
import { createSessionToken, COOKIE_NAME } from '@/lib/auth';
export async function GET(req: NextRequest) {
  const state = req.nextUrl.searchParams.get('state');
  if (!state || state !== req.cookies.get('magnus_hive_state')?.value)
    { await recordSecurityEvent('auth.oauth_rejected', req.headers, '', 'hive').catch(() => undefined); return NextResponse.json({ error: 'Invalid OAuth state' }, { status: 401 }); }
  try {
    const session = await finishHiveLogin(state, req.nextUrl.searchParams.get('code') ?? '');
    await recordSecurityEvent('auth.login_succeeded', req.headers, session.username, 'hive');
    const token = await createSessionToken(session.username, session);
    const response = NextResponse.redirect(new URL('/', process.env['DASHBOARD_PUBLIC_ORIGIN']!));
    response.cookies.set(COOKIE_NAME, token, {
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: session.ttl,
    });
    response.cookies.set('magnus_hive_state', '', {
      secure: true,
      httpOnly: true,
      path: '/api/auth/hive/callback',
      maxAge: 0,
    });
    return response;
  } catch {
    await recordSecurityEvent('auth.login_failed', req.headers, '', 'hive').catch(() => undefined);
    return NextResponse.json({ error: 'Hive login failed' }, { status: 401 });
  }
}
