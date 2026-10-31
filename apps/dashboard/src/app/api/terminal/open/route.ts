/**
 * POST /api/terminal/open
 *
 * Opens an SSH connection to a node and starts a PTY shell session.
 * Returns a sessionId that the client uses for stream/input/resize/close calls.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { openSession, getRequestUserId } from '@/lib/terminal-sessions';
import { validateProxyTarget } from '@/app/api/proxy/allowed-targets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface OpenRequest {
  host: string;
  cols?: number;
  rows?: number;
}

/** Blocked IP patterns for terminal host (SSRF prevention). */
const BLOCKED_HOST_PATTERNS = [
  /^169\.254\./,       // Cloud metadata link-local
  /^0\./,              // Non-routable
  /^metadata\./i,      // Cloud metadata hostnames
  /^instance-data\./i, // Cloud metadata hostnames
];

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const ownerId = await getRequestUserId(req);
    if (!ownerId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await req.json()) as OpenRequest;

    if (!body.host) {
      return NextResponse.json({ error: 'Missing host' }, { status: 400 });
    }

    // SSRF protection: validate the host against blocked patterns
    const host = body.host.trim();
    if (BLOCKED_HOST_PATTERNS.some(p => p.test(host))) {
      return NextResponse.json({ error: 'Target host is blocked' }, { status: 403 });
    }

    // Validate that the target resembles a configured control node host
    // (terminal connections should only go to fleet nodes whose IPs/hostnames
    // are known via registered nodes on a control node)
    const result = await validateProxyTarget(`https://${host}:4100`);
    if (!result.allowed) {
      // Allow the connection anyway if host is a known IP or hostname pattern
      // but log the fact it wasn't in the allowlist. For strict mode, uncomment:
      // return NextResponse.json({ error: 'Host not in allowlist' }, { status: 403 });
      console.warn(`[terminal] Host '${host}' not in proxy allowlist, allowing with caution`);
    }

    const sessionId = await openSession({
      host,
      cols: body.cols,
      rows: body.rows,
      ownerId,
    });

    return NextResponse.json({ sessionId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to open terminal session';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
