import {recordSecurityEvent} from '@/lib/security-events';
/**
 * POST /api/auth/login
 *
 * Authenticates with dashboard credentials from environment variables.
 *
 * Redis-backed source, username, pair, delay, and concurrency protection.
 */
import { NextResponse } from 'next/server';
import {
  validateCredentials,
  createSessionToken,
  COOKIE_NAME,
  SESSION_DURATION,
} from '@/lib/auth';
import { beginAuthentication, resolveTrustedClientAddress } from '@/lib/auth-protection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<NextResponse> {
  let permit: Awaited<ReturnType<typeof beginAuthentication>> | undefined;
  let auditUsername = '';
  const respond = async (response: NextResponse) => {
    const event = response.status === 200 ? 'auth.login_succeeded' : response.status === 401 ? 'auth.login_failed' : response.status === 429 ? 'auth.login_throttled' : response.status >= 500 ? 'auth.login_error' : 'auth.login_rejected';
    await recordSecurityEvent(event, req.headers, auditUsername);
    return response;
  };
  try {
    const declaredLength = Number(req.headers.get('content-length') ?? 0);
    if (declaredLength > 4_096) return await respond(NextResponse.json({ error: 'Request too large' }, { status: 413 }));
    const rawBody = await req.text();
    if (Buffer.byteLength(rawBody) > 4_096) return await respond(NextResponse.json({ error: 'Request too large' }, { status: 413 }));
    const body: unknown = JSON.parse(rawBody);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return await respond(NextResponse.json({ error: 'Invalid request' }, { status: 400 }));
    }
    const candidate = body as Record<string, unknown>;
    const password = typeof candidate.password === 'string' ? candidate.password : '';
    const usernameValue = candidate.username ?? candidate.email;
    const username = typeof usernameValue === 'string' ? usernameValue : '';

    auditUsername = username;
    if (!username || !password) {
      return await respond(NextResponse.json(
        { error: 'Username and password are required' },
        { status: 400 },
      ));
    }

    permit = await beginAuthentication(resolveTrustedClientAddress(req.headers), username);
    if (!permit.allowed) {
      return await respond(NextResponse.json(
        { error: 'Too many login attempts. Try again later.' },
        { status: 429, headers: { 'Retry-After': String(permit.retryAfterSeconds) } },
      ));
    }

    if (!(await validateCredentials(username, password))) {
      return await respond(NextResponse.json({ error: 'Invalid credentials' }, { status: 401 }));
    }

    await permit.clearSuccessfulPair();

    const token = await createSessionToken(username, { role: 'ADMIN' });

    const response = NextResponse.json({ ok: true, username, role: 'ADMIN' });
    response.cookies.set(COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_DURATION,
    });
    return await respond(response);
  } catch {
    await recordSecurityEvent('auth.login_error', req.headers, auditUsername).catch(() => undefined);
    return NextResponse.json({ error: 'Authentication temporarily unavailable' }, { status: 503 });
  } finally {
    if (permit) {
      try { await permit.release(); } catch { /* lease TTL is the final safety net */ }
    }
  }
}
