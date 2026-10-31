/**
 * GET /api/terminal/ws
 *
 * Informational endpoint for the WebSocket terminal.
 * The actual WebSocket upgrade is handled by the ws library
 * attached to the HTTP server via instrumentation.
 *
 * This route returns connection instructions for clients.
 */
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  return NextResponse.json({
    protocol: 'websocket',
    path: '/api/terminal/ws',
    description: 'WebSocket terminal endpoint. Connect via WebSocket protocol.',
    params: {
      host: 'Target hostname (required)',
      cols: 'Terminal columns (default: 120)',
      rows: 'Terminal rows (default: 30)',
    },
    messages: {
      input: 'Send raw text/binary for stdin',
      resize: '{ "type": "resize", "cols": number, "rows": number }',
      ping: '{ "type": "ping" } → receives { "type": "pong" }',
    },
    output: 'Binary frames with SSH stdout/stderr',
    fallback: 'Use /api/terminal/open + /api/terminal/stream for HTTP streaming fallback',
  });
}
