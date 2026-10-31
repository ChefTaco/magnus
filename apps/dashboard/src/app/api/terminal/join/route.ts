/**
 * GET /api/terminal/join?token=xxx
 *
 * Join a shared terminal session as a read-only viewer.
 * Returns a streaming response of the terminal output.
 * First replays the shared buffer, then streams live output.
 */
import { type NextRequest } from 'next/server';
import {
  getSessionByShareToken,
  getRequestUserId,
  registerViewerController,
  removeViewer,
} from '@/lib/terminal-sessions';
import { nanoid } from 'nanoid';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const token = req.nextUrl.searchParams.get('token');

  if (!token) {
    return new Response(JSON.stringify({ error: 'Missing share token' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Require authentication
  const callerId = await getRequestUserId(req);
  if (!callerId) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const session = getSessionByShareToken(token);
  if (!session || session.ended) {
    return new Response(JSON.stringify({ error: 'Session not found or no longer shared' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const viewerKey = `v_${nanoid(12)}`;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Replay shared buffer so viewer sees current terminal state
      for (const chunk of session.sharedBuffer) {
        try {
          controller.enqueue(chunk);
        } catch {
          break;
        }
      }

      // Register for live output
      registerViewerController(session.id, viewerKey, controller);

      if (session.ended) {
        try { controller.close(); } catch { /* ignore */ }
      }
    },
    cancel() {
      removeViewer(session.id, viewerKey);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Viewer-Key': viewerKey,
    },
  });
}
