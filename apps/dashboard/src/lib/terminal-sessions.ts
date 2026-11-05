import { beginManagedSshWork, observeManagedSshEnd } from '../../runtime-resource-participant.mjs';
/**
 * Server-side terminal session manager.
 *
 * Stores active SSH sessions in memory so that multiple API route handlers
 * (open, stream, input, resize, close) can share the same session object.
 *
 * Uses globalThis to survive Next.js hot-reloads in development.
 */
import { Client as SSHClient, type ClientChannel } from 'ssh2';
import { nanoid } from 'nanoid';
import type { NextRequest } from 'next/server';
import { verifySessionToken, COOKIE_NAME } from '@/lib/auth';
import { resolveDashboardSshCredentials } from '../../runtime-dashboard-credentials.mjs';
import { verifyTerminalHostKey } from '@/lib/terminal-host-key';

export interface TerminalSession {
  id: string;
  /** Identifier of the user who opened this session (userId or username). */
  ownerId: string;
  ssh: SSHClient;
  stream: ClientChannel;
  /** Queued output chunks waiting for a stream reader to consume them. */
  outputQueue: Uint8Array[];
  /** Active stream controller — set when a /stream reader is connected. */
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  /** Whether the SSH session has ended. */
  ended: boolean;
  /** Close reason (for the client). */
  closeReason: string;
  lastActivity: number;
}

/**
 * Extract the caller's identity from the session cookie.
 * Returns userId or username, or null if unauthenticated.
 */
export async function getRequestUserId(req: NextRequest): Promise<string | null> {
  const cookie = req.cookies.get(COOKIE_NAME)?.value;
  if (!cookie) return null;
  const session = await verifySessionToken(cookie);
  if (!session) return null;
  return session.userId ?? session.username;
}

/**
 * Assert that the requesting user owns the given session.
 * Returns the session on success, or an error Response on failure.
 */
export async function assertSessionOwnership(
  req: NextRequest,
  sessionId: string,
): Promise<{ ok: true; session: TerminalSession } | { ok: false; response: Response }> {
  const callerId = await getRequestUserId(req);
  if (!callerId) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    };
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: 'Session not found or ended' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    };
  }

  if (session.ownerId !== callerId) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: 'Forbidden: session belongs to another user' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    };
  }

  return { ok: true, session };
}

// Survive Next.js HMR in development
const globalForTerminal = globalThis as unknown as {
  __terminalSessions?: Map<string, TerminalSession>;
  __terminalCleanupTimer?: ReturnType<typeof setInterval>;
};

export const sessions: Map<string, TerminalSession> =
  globalForTerminal.__terminalSessions ??= new Map();

// Auto-cleanup idle sessions (5 min timeout)
if (!globalForTerminal.__terminalCleanupTimer) {
  globalForTerminal.__terminalCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > 5 * 60 * 1000) {
        closeSession(id);
      }
    }
  }, 30_000);
}

function generateSessionId(): string {
  return `ts_${nanoid(16)}`;
}

export interface OpenSessionOptions {
  host: string;
  cols?: number;
  rows?: number;
  /** The authenticated user opening this session — used for ownership checks. */
  ownerId: string;
}

export async function openSession(opts: OpenSessionOptions): Promise<string> {
  const { host, cols = 120, rows = 30, ownerId } = opts;

  const sshCredentials = resolveDashboardSshCredentials();

  const sessionId = generateSessionId();
  const work = await beginManagedSshWork(host, 'terminal-http');

  return new Promise<string>((resolve, reject) => {
    const conn = new SSHClient();
    const timeout = setTimeout(() => {
      observeManagedSshEnd(work);
      conn.end();
      reject(new Error('SSH connection timed out'));
    }, 15_000);

    conn.on('error', (err) => {
      observeManagedSshEnd(work);
      clearTimeout(timeout);
      const session = sessions.get(sessionId);
      if (session) {
        session.ended = true;
        session.closeReason = `SSH error: ${err.message}`;
        session.controller?.close();
        session.controller = null;
      }
      reject(err);
    });

    conn.on('ready', () => {
      clearTimeout(timeout);
      // Open an interactive login shell
      conn.shell(
        { term: 'xterm-256color', cols, rows },
        (err, stream) => {
          if (err) {
            conn.end();
            reject(err);
            return;
          }

          const session: TerminalSession = {
            id: sessionId,
            ownerId,
            ssh: conn,
            stream,
            outputQueue: [],
            controller: null,
            ended: false,
            closeReason: '',
            lastActivity: Date.now(),
          };

          // Buffer output until a stream reader connects
          stream.on('data', (data: Buffer) => {
            session.lastActivity = Date.now();
            const chunk = new Uint8Array(data);
            deliverChunk(session, chunk);
          });

          stream.stderr.on('data', (data: Buffer) => {
            session.lastActivity = Date.now();
            const chunk = new Uint8Array(data);
            deliverChunk(session, chunk);
          });

          stream.on('close', (code: unknown) => {
            observeManagedSshEnd(work, typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 0xffffffff ? 'remote-ended' : 'unknown');
            session.ended = true;
            session.closeReason = 'Shell closed';
            try { session.controller?.close(); } catch { /* ignore */ }
            session.controller = null;
            sessions.delete(sessionId);
            try { conn.end(); } catch { /* ignore */ }
          });

          stream.on('error', () => {
            session.ended = true;
            session.closeReason = 'Stream error';
            try { session.controller?.close(); } catch { /* ignore */ }
            session.controller = null;
            sessions.delete(sessionId);
            try { conn.end(); } catch { /* ignore */ }
          });

          sessions.set(sessionId, session);
          resolve(sessionId);
        },
      );
    });

    conn.on('close', () => {
      observeManagedSshEnd(work);
      const session = sessions.get(sessionId);
      if (session) {
        session.ended = true;
        session.closeReason = session.closeReason || 'Connection closed';
        try { session.controller?.close(); } catch { /* ignore */ }
        session.controller = null;
        sessions.delete(sessionId);
      }
    });

    try { conn.connect({
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
    } as any); } catch (error) { clearTimeout(timeout); observeManagedSshEnd(work); reject(error); }
  });
}

function deliverChunk(session: TerminalSession, chunk: Uint8Array): void {
  if (session.controller) {
    try {
      session.controller.enqueue(chunk);
    } catch {
      session.outputQueue.push(chunk);
    }
  } else {
    session.outputQueue.push(chunk);
  }
}

export function sendInput(sessionId: string, data: string): boolean {
  const session = sessions.get(sessionId);
  if (!session || session.ended) return false;
  session.lastActivity = Date.now();
  session.stream.write(data);
  return true;
}

export function resizeTerminal(sessionId: string, cols: number, rows: number): boolean {
  const session = sessions.get(sessionId);
  if (!session || session.ended) return false;
  session.lastActivity = Date.now();
  session.stream.setWindow(rows, cols, 0, 0);
  return true;
}

export function closeSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.ended = true;
  session.closeReason = 'Client closed';
  try { session.controller?.close(); } catch { /* ignore */ }
  session.controller = null;
  try { session.stream.close(); } catch { /* ignore */ }
  try { session.ssh.end(); } catch { /* ignore */ }
  sessions.delete(sessionId);
}

export function getSession(sessionId: string): TerminalSession | undefined {
  return sessions.get(sessionId);
}
