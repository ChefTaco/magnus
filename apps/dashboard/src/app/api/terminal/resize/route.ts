/**
 * POST /api/terminal/resize
 *
 * Resizes the PTY window for an active SSH session.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { resizeTerminal, assertSessionOwnership } from '@/lib/terminal-sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ResizeRequest {
  sessionId: string;
  cols: number;
  rows: number;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json()) as ResizeRequest;

  if (!body.sessionId || typeof body.cols !== 'number' || typeof body.rows !== 'number') {
    return NextResponse.json({ error: 'Missing sessionId, cols, or rows' }, { status: 400 });
  }

  const check = await assertSessionOwnership(req, body.sessionId);
  if (!check.ok) return NextResponse.json({ error: 'Forbidden' }, { status: (check.response as Response).status });

  const ok = resizeTerminal(body.sessionId, body.cols, body.rows);

  if (!ok) {
    return NextResponse.json({ error: 'Session not found or ended' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
