import { NextResponse } from 'next/server';
import { beginHiveLogin } from '@/lib/hive-login';
export async function GET() {
  try {
    const flow = await beginHiveLogin();
    const response = NextResponse.redirect(flow.url);
    response.cookies.set('magnus_hive_state', flow.state, {
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      path: '/api/auth/hive/callback',
      maxAge: 300,
    });
    return response;
  } catch {
    return NextResponse.json({ error: 'Hive login unavailable' }, { status: 503 });
  }
}
