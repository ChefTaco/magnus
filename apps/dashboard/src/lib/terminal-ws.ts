import { beginManagedSshWork, observeManagedSshEnd } from '../../runtime-resource-participant.mjs';
/**
 * WebSocket terminal server.
 *
 * Manages a WebSocket server that runs alongside Next.js.
 * Handles terminal sessions over WebSocket with binary frames for
 * SSH output and JSON control messages for resize/ping.
 *
 * Usage:
 *   - Attached to the Next.js HTTP server via instrumentation
 *   - Clients connect to ws://.../api/terminal/ws?sessionId=...
 *   - Or open a new session: ws://.../api/terminal/ws?host=...
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Server as HTTPServer } from 'node:http';
import { parse as parseUrl } from 'node:url';
import { Client as SSHClient } from 'ssh2';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { COOKIE_NAME, verifySessionToken } from '@/lib/auth';
import { parseCookieHeader } from '../../runtime-cookie.mjs';
import { resolveDashboardSshCredentials } from '../../runtime-dashboard-credentials.mjs';
import { verifyTerminalHostKey } from '@/lib/terminal-host-key';

// ── Types ──

interface WsControlMessage {
  type: 'resize' | 'ping';
  cols?: number;
  rows?: number;
}

interface WsTerminalSession {
  ws: WebSocket;
  ssh: SSHClient;
  host: string;
  alive: boolean;
  openedAt: string;
  username: string;
}

// ── Singleton WSS (survives HMR) ──

const globalForWs = globalThis as unknown as {
  __terminalWss?: WebSocketServer;
  __wsHeartbeat?: ReturnType<typeof setInterval>;
  __wsSessions?: Map<WebSocket, WsTerminalSession>;
};

const wsSessions: Map<WebSocket, WsTerminalSession> =
  globalForWs.__wsSessions ??= new Map();

/**
 * Attach the WebSocket terminal server to an existing HTTP server.
 * Safe to call multiple times (idempotent — reuses existing WSS).
 */
export function attachWebSocketTerminal(server: HTTPServer): WebSocketServer {
  if (globalForWs.__terminalWss) return globalForWs.__terminalWss;

  const wss = new WebSocketServer({ noServer: true });
  globalForWs.__terminalWss = wss;

  // Handle upgrade requests for /api/terminal/ws
  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const { pathname } = parseUrl(req.url ?? '', true);
    if (pathname !== '/api/terminal/ws') return;

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    void handleConnection(ws, req).catch(() => {
      try { ws.close(1011, 'Terminal connection error'); } catch { /* ignore */ }
      cleanup(ws);
    });
  });

  // Heartbeat ping every 30 seconds
  if (!globalForWs.__wsHeartbeat) {
    globalForWs.__wsHeartbeat = setInterval(() => {
      for (const [ws, session] of wsSessions) {
        if (!session.alive) {
          ws.terminate();
          cleanup(ws);
          continue;
        }
        session.alive = false;
        ws.ping();
      }
    }, 30_000);
  }

  return wss;
}

export function parseCookie(header = ''): Map<string, string> {
  return parseCookieHeader(header);
}

function recordTerminalSession(event: Record<string, unknown>): void {
  try {
    const dir = process.env['TERMINAL_AUDIT_DIR'] ?? join(process.cwd(), 'terminal-audit');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'sessions.jsonl'), `${JSON.stringify({ ...event, timestamp: new Date().toISOString() })}\n`);
  } catch {
    // Do not break terminal access if metadata recording is unavailable.
  }
}

async function handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  const { query } = parseUrl(req.url ?? '', true);
  const host = query['host'] as string | undefined;

  if (!host) {
    ws.close(4000, 'Missing host parameter');
    return;
  }

  const sessionToken = parseCookie(req.headers.cookie ?? '').get(COOKIE_NAME);
  const session = sessionToken ? await verifySessionToken(sessionToken) : null;
  if (!session) {
    ws.close(4004, 'Unauthorized');
    return;
  }

  const sshCredentials = resolveDashboardSshCredentials();

  const cols = Number(query['cols'] ?? '120');
  const rows = Number(query['rows'] ?? '30');

  const work = await beginManagedSshWork(host, 'terminal-ws');
  const ssh = new SSHClient();
  // Register before connecting: browser loss during handshake is still a durable unknown.
  ws.once('close', () => { observeManagedSshEnd(work); ssh.end(); });
  ws.once('error', () => { observeManagedSshEnd(work); ssh.end(); });
  ssh.once('close', () => observeManagedSshEnd(work));
  if (ws.readyState !== ws.OPEN) { observeManagedSshEnd(work, 'not-started'); return; }

  const connectionTimeout = setTimeout(() => {
    observeManagedSshEnd(work);
    ssh.end();
    ws.close(4001, 'SSH connection timed out');
  }, 15_000);

  ssh.on('error', (err) => {
    observeManagedSshEnd(work);
    clearTimeout(connectionTimeout);
    try { ws.send(JSON.stringify({ type: 'error', message: err.message })); } catch { /* ignore */ }
    ws.close(4002, 'SSH error');
    cleanup(ws);
  });

  ssh.on('ready', () => {
    clearTimeout(connectionTimeout);

    ssh.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
      if (err) {
        ws.close(4003, 'Shell error');
        ssh.end();
        cleanup(ws);
        return;
      }

      const openedAt = new Date().toISOString();
      const sessionRecord: WsTerminalSession = { ws, ssh, host, alive: true, openedAt, username: session.username };
      const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      recordTerminalSession({ event: 'open', sessionId, host, username: session.username });
      wsSessions.set(ws, sessionRecord);

      // SSH stdout → WebSocket binary frames
      stream.on('data', (data: Buffer) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(data);
        }
      });

      stream.stderr.on('data', (data: Buffer) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(data);
        }
      });

      stream.on('close', (code: unknown) => {
        observeManagedSshEnd(work, typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 0xffffffff ? 'remote-ended' : 'unknown');
        ws.close(1000, 'Shell closed');
        cleanup(ws);
      });

      // WebSocket messages → SSH stdin or control
      ws.on('message', (msg: Buffer | string) => {
        sessionRecord.alive = true;

        // Try parsing as JSON control message
        if (typeof msg === 'string' || (Buffer.isBuffer(msg) && msg[0] === 0x7b /* '{' */)) {
          try {
            const ctrl = JSON.parse(msg.toString()) as WsControlMessage;
            if (ctrl.type === 'resize' && ctrl.cols && ctrl.rows) {
              stream.setWindow(ctrl.rows, ctrl.cols, 0, 0);
              return;
            }
            if (ctrl.type === 'ping') {
              ws.send(JSON.stringify({ type: 'pong' }));
              return;
            }
          } catch {
            // Not JSON — treat as stdin
          }
        }

        // Forward raw input to SSH
        stream.write(Buffer.isBuffer(msg) ? msg : Buffer.from(msg as string));
      });

      ws.on('pong', () => {
        sessionRecord.alive = true;
      });

      ws.on('close', () => {
        try { stream.close(); } catch { /* ignore */ }
        ssh.end();
        recordTerminalSession({ event: 'close', sessionId, host, username: session.username, openedAt });
        cleanup(ws);
      });

      ws.on('error', () => {
        try { stream.close(); } catch { /* ignore */ }
        ssh.end();
        recordTerminalSession({ event: 'error', sessionId, host, username: session.username, openedAt });
        cleanup(ws);
      });
    });
  });

  try { ssh.connect({
    host,
    port: 22,
    username: sshCredentials.username,
    ...(sshCredentials.privateKey
      ? { privateKey: sshCredentials.privateKey }
      : { password: sshCredentials.password }),
    readyTimeout: 12_000,
    hostHash: 'sha256',
    hostVerifier: (hashedKey: string) => verifyTerminalHostKey(host, hashedKey),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any); } catch (error) { clearTimeout(connectionTimeout); observeManagedSshEnd(work); throw error; }
}

function cleanup(ws: WebSocket): void {
  const session = wsSessions.get(ws);
  if (session) {
    try { session.ssh.end(); } catch { /* ignore */ }
    wsSessions.delete(ws);
  }
}
