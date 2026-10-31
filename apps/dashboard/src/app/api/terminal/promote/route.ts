/**
 * POST /api/terminal/promote
 *
 * Promote a viewer to interactive mode (owner only).
 * Body: { sessionId: string, viewerKey: string }
 */
import { type NextRequest, NextResponse } from 'next/server';
import { assertSessionOwnership, promoteViewer } from '@/lib/terminal-sessions';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<Response> {
  const body = (await req.json()) as { sessionId?: string; viewerKey?: string };
  const { sessionId, viewerKey } = body;

  if (!sessionId || !viewerKey) {
    return NextResponse.json(
      { error: 'Missing sessionId or viewerKey' },
      { status: 400 },
    );
  }

  const check = await assertSessionOwnership(req, sessionId);
  if (!check.ok) return check.response;

  const promoted = promoteViewer(sessionId, viewerKey);
  if (!promoted) {
    return NextResponse.json(
      { error: 'Viewer not found in session' },
      { status: 404 },
    );
  }

  return NextResponse.json({ success: true, viewerKey, canWrite: true });
}
