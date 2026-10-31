import { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * The former Control API terminal used retired reusable SSH passwords. Keep a
 * deterministic upgrade rejection so old clients fail closed while the
 * dashboard's separately scoped, host-key-pinned terminal remains available.
 */
export function setupTerminalWebSocket(server: {
  on(event: 'upgrade', listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
}): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
    const url = new URL(request.url ?? '', `http://${request.headers.host ?? 'localhost'}`);
    if (!url.pathname.startsWith('/api/v1/terminal')) return;
    socket.end(
      'HTTP/1.1 410 Gone\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: 33\r\n\r\nControl API terminal is retired.\n',
    );
  });
  return wss;
}
