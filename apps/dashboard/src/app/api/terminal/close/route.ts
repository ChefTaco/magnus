/**
 * POST /api/terminal/close
 *
 * Closes an active SSH terminal session.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { closeSession, assertSessionOwnership } from '@/lib/terminal-sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CloseRequest {
  sessionId: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json()) as CloseRequest;

  if (!body.sessionId) {
    return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 });
  }

  const check = await assertSessionOwnership(req, body.sessionId);
  if (!check.ok) return NextResponse.json({ error: 'Forbidden' }, { status: (check.response as Response).status });

  closeSession(body.sessionId);
  return NextResponse.json({ ok: true });
}
