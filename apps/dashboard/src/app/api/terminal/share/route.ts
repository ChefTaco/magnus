/**
 * POST /api/terminal/share
 *
 * Generate a share token for a terminal session (owner only).
 * Body: { sessionId: string }
 * Returns: { token: string }
 */
import { type NextRequest, NextResponse } from 'next/server';
import {
  assertSessionOwnership,
  shareSession,
  unshareSession,
} from '@/lib/terminal-sessions';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<Response> {
  const body = (await req.json()) as { sessionId?: string; action?: string };
  const sessionId = body.sessionId;

  if (!sessionId) {
    return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 });
  }

  const check = await assertSessionOwnership(req, sessionId);
  if (!check.ok) return check.response;

  // action=unshare to stop sharing
  if (body.action === 'unshare') {
    unshareSession(sessionId);
    return NextResponse.json({ success: true });
  }

  const token = shareSession(sessionId);
  if (!token) {
    return NextResponse.json({ error: 'Session not found or ended' }, { status: 404 });
  }

  return NextResponse.json({ success: true, token });
}
