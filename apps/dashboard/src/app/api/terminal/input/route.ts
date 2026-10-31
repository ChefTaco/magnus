/**
 * POST /api/terminal/input
 *
 * Sends user keystroke data to the SSH session.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { sendInput, assertSessionOwnership } from '@/lib/terminal-sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface InputRequest {
  sessionId: string;
  data: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json()) as InputRequest;

  if (!body.sessionId || typeof body.data !== 'string') {
    return NextResponse.json({ error: 'Missing sessionId or data' }, { status: 400 });
  }

  const check = await assertSessionOwnership(req, body.sessionId);
  if (!check.ok) return NextResponse.json({ error: 'Forbidden' }, { status: (check.response as Response).status });

  const ok = sendInput(body.sessionId, body.data);

  if (!ok) {
    return NextResponse.json({ error: 'Session not found or ended' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
