import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifySessionToken } from '@/lib/auth';
import { COOKIE_NAME } from '@/lib/auth-constants';

/**
 * GET /api/auth/me — return the current user's basic profile from the session.
 * Used by client components (e.g. avatar) without exposing secrets.
 */
export async function GET(): Promise<NextResponse> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.json({ username: null }, { status: 401 });
  }

  try {
    const session = await verifySessionToken(token);
    if (!session) {
      return NextResponse.json({ username: null }, { status: 401 });
    }
    return NextResponse.json({
      username: session.username,
      email: session.email ?? null,
      userId: session.userId ?? null,
      role: session.role ?? 'ADMIN',
    });
  } catch {
    return NextResponse.json({ username: null }, { status: 401 });
  }
}
