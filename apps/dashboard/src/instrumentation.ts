/**
 * Next.js instrumentation hook.
 *
 * Attaches the WebSocket terminal server to the Node.js HTTP server
 * when running in the Node.js runtime (not edge).
 */
export async function onRequestError() {
  // Required export — Next.js instrumentation hook
}

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Lazy-import to avoid loading SSH/ws modules at build time
    const { attachWebSocketTerminal } = await import('./lib/terminal-ws');

    // Defer attachment until the HTTP server is available
    setTimeout(() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const http = require('node:http');
        const originalCreateServer = http.createServer;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        http.createServer = function (...args: any[]) {
          const server = originalCreateServer.apply(this, args);
          attachWebSocketTerminal(server);
          return server;
        };
      } catch {
        // WebSocket attachment failed — HTTP streaming fallback remains available
        console.warn('[ws-terminal] Could not attach WebSocket server — falling back to HTTP streaming');
      }
    }, 0);
  }
}
