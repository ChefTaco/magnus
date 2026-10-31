/**
 * GET /api/terminal/stream?sessionId=X
 *
 * Returns a streaming response that delivers SSH output in real-time.
 * The response body is a raw byte stream that xterm.js can consume directly.
 */
import { type NextRequest } from 'next/server';
import { assertSessionOwnership } from '@/lib/terminal-sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const sessionId = req.nextUrl.searchParams.get('sessionId');

  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'Missing sessionId' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate session ownership before streaming
  const check = await assertSessionOwnership(req, sessionId);
  if (!check.ok) return check.response;

  const session = check.session;

  if (session.ended) {
    return new Response(JSON.stringify({ error: 'Session ended' }), {
      status: 410,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Flush any queued output (exec mode — no MOTD/banner, only command output)
      for (const chunk of session.outputQueue) {
        controller.enqueue(chunk);
      }
      session.outputQueue.length = 0;

      // Register this controller for live output
      session.controller = controller;

      // If session already ended while we were setting up
      if (session.ended) {
        try { controller.close(); } catch { /* ignore */ }
      }
    },
    cancel() {
      // Client disconnected — detach but don't kill the session
      // (the session has its own idle timeout for cleanup)
      session.controller = null;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
