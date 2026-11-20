/**
 * HTTP upgrade handling shared by the console's TLS wrapper.
 *
 * Node applies no request or keep-alive timeout to a socket handed to an `upgrade` listener, so
 * every upgrade request must end in a response or a handover. Nothing here may throw: an exception
 * in an `upgrade` listener leaves the socket open with no response.
 */

// The request target alone decides routing. A fixed base keeps a malformed Host header from making
// parsing throw; the Host header is never trusted for routing.
const REQUEST_TARGET_BASE = 'https://localhost';

/** The request target as a URL, or null when it cannot be parsed. */
export function parseRequestTarget(req) {
  try {
    return new URL(req.url ?? '/', REQUEST_TARGET_BASE);
  } catch {
    return null;
  }
}

const REASONS = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  431: 'Request Header Fields Too Large',
  503: 'Service Unavailable',
};

/** Answer an upgrade request with a bodiless status and close its socket. */
export function rejectUpgrade(socket, status, headers = {}) {
  if (socket.destroyed) return;
  const lines = [`HTTP/1.1 ${status} ${REASONS[status] ?? 'Error'}`, 'Connection: close', 'Content-Length: 0'];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  try {
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  } finally {
    socket.destroy();
  }
}

/**
 * Wrap the framework's own `upgrade` listener (Next.js registers one after the server is created).
 * Upgrades another listener owns, and upgrades whose target cannot be parsed (the Hermes bridge
 * rejects those), never reach it. Next.js deliberately returns without touching an upgrade that
 * matches no route, in case a custom WebSocket server shares the path, so an upgrade it leaves
 * unclaimed gets a 404. The console configures no external rewrites, the only way Next.js keeps an
 * upgrade socket open in production; `next.config.ts` is pinned to that by a test.
 */
export function guardFrameworkUpgradeListener(listener, ownedElsewhere) {
  return async function frameworkUpgradeListener(req, socket, head) {
    const target = parseRequestTarget(req);
    if (!target || ownedElsewhere(target)) return;
    try {
      await listener.call(this, req, socket, head);
    } catch (err) {
      console.error('magnus-ui: framework upgrade handler failed:', err instanceof Error ? err.message : err);
    } finally {
      if (!socket.destroyed && !socket.writableEnded) rejectUpgrade(socket, 404);
    }
  };
}
