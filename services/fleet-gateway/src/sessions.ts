/**
 * Live terminal sessions. Holds them in memory only, never logs or stores what passes through, and
 * ends each one when its owner's authority or its time limits run out.
 */
import { randomBytes } from 'node:crypto';
import type { AuditEvent } from './control-api.js';
import type { Auditor } from './audit.js';
import type { Authorizer, Principal } from './authorize.js';
import { GatewayError } from './errors.js';
import type { ManagedWork, WorkDisposition } from './participant.js';
import type { PtySize, ShellChannel } from './ssh.js';

export const SESSION_ID = /^ts_[A-Za-z0-9_-]{43}$/;
const LOW_WATER_BYTES = 256 * 1024;
const TOMBSTONE_TTL_MS = 5 * 60_000;
const MAX_TOMBSTONES = 1_024;
/** Pausing asks the node to stop. A node that keeps sending past this many buffers loses the session. */
const HARD_BUFFER_MULTIPLE = 4;

export type EndReason =
  | 'client-closed' | 'remote-ended' | 'connection-lost' | 'token-revoked' | 'token-expired' | 'authority-lost'
  | 'idle-timeout' | 'max-lifetime' | 'detached' | 'gateway-shutdown' | 'audit-unavailable' | 'output-overflow';

/** Only a remote shell's own exit is reported as ended. Every other end may have left work running. */
const DISPOSITIONS: Partial<Record<EndReason, WorkDisposition>> = { 'remote-ended': 'remote-ended' };

export interface SessionLimits {
  idleTimeoutMs: number;
  maxLifetimeMs: number;
  /** A shell nobody is reading ends after this long, so abandoned opens do not pile up. */
  detachGraceMs: number;
  recheckMs: number;
  maxPerSubject: number;
  maxTotal: number;
  /** Output held for a detached or slow reader before the remote shell is paused. */
  maxBufferedBytes: number;
  opensPerMinute: number;
}

interface Session {
  id: string;
  ownerKey: string;
  subjectKey: string;
  subject: string;
  actorId: string;
  nodeId: string;
  ipAddress: string | null;
  channel: ShellChannel;
  work: ManagedWork;
  openedAt: number;
  lastInputAt: number;
  detachedSince: number | null;
  token: string;
  tokenExpiresAt: number;
  queue: Buffer[];
  queuedBytes: number;
  paused: boolean;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  checking: boolean;
  ended: boolean;
}

export type SessionStatus =
  | { state: 'open'; nodeId: string; idleDeadline: string; expiresAt: string }
  | { state: 'ended'; reason: EndReason };

export interface OpenRequest {
  principal: Principal;
  nodeId: string;
  size: PtySize;
  ipAddress: string | null;
}

export interface SessionDependencies {
  authorizer: Authorizer;
  auditor: Auditor;
  limits: SessionLimits;
  /** Everything between the admission slot and a live shell. Throws GatewayError to refuse. */
  connect(request: OpenRequest, lifetimeMs: number): Promise<{ channel: ShellChannel; work: ManagedWork }>;
  now?: () => number;
}

export function createSessionManager(dependencies: SessionDependencies) {
  const { authorizer, auditor, limits, connect } = dependencies;
  const now = dependencies.now ?? (() => Date.now());
  const sessions = new Map<string, Session>();
  const tombstones = new Map<string, { ownerKey: string; reason: EndReason; endedAt: number }>();
  const pendingBySubject = new Map<string, number>();
  const opensBySubject = new Map<string, number[]>();
  let pendingTotal = 0;
  let stopping = false;

  const bump = (subject: string, delta: number) => {
    pendingTotal += delta;
    const next = (pendingBySubject.get(subject) ?? 0) + delta;
    if (next > 0) pendingBySubject.set(subject, next);
    else pendingBySubject.delete(subject);
  };
  const openCount = (subject: string) => [...sessions.values()].filter((session) => session.subjectKey === subject).length;

  /** Takes a slot synchronously, so concurrent opens cannot all pass the check. */
  function admit(subject: string): void {
    if (stopping) throw new GatewayError('GATEWAY_STOPPING');
    const recent = (opensBySubject.get(subject) ?? []).filter((at) => now() - at < 60_000);
    if (recent.length >= limits.opensPerMinute) throw new GatewayError('RATE_LIMITED');
    if (sessions.size + pendingTotal >= limits.maxTotal || openCount(subject) + (pendingBySubject.get(subject) ?? 0) >= limits.maxPerSubject) {
      throw new GatewayError('SESSION_LIMIT_REACHED');
    }
    recent.push(now());
    opensBySubject.set(subject, recent);
    bump(subject, 1);
  }

  const baseEvent = (session: Session): Omit<AuditEvent, 'action' | 'outcome' | 'at' | 'durationMs'> => ({
    subject: session.subject, actorId: session.actorId, nodeId: session.nodeId, sessionId: session.id, ipAddress: session.ipAddress, fingerprint: null,
  });

  function end(session: Session, reason: EndReason, options: { keepOutput?: boolean } = {}): void {
    if (session.ended) return;
    session.ended = true;
    sessions.delete(session.id);
    const endedAt = now();
    tombstones.set(session.id, { ownerKey: session.ownerKey, reason, endedAt });
    if (tombstones.size > MAX_TOMBSTONES) tombstones.delete(tombstones.keys().next().value as string);
    const controller = session.controller;
    session.controller = null;
    if (controller) {
      try {
        if (options.keepOutput) {
          for (const chunk of session.queue) controller.enqueue(new Uint8Array(chunk));
          controller.close();
        } else {
          // Authority ended, so anything not yet delivered is discarded rather than flushed. The
          // server treats this code as a closed stream, with no stack trace in the log.
          controller.error(Object.assign(new Error('session ended'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }));
        }
      } catch { /* the reader has already gone */ }
    }
    session.queue.length = 0;
    session.queuedBytes = 0;
    session.token = '';
    session.channel.terminate();
    session.work.finish(DISPOSITIONS[reason] ?? 'unknown').catch(() => {
      // A failed settlement keeps the durable reservation, which blocks a drain until reconciled.
      console.error(JSON.stringify({ type: 'settlement-unacknowledged', sessionId: session.id }));
    });
    void auditor.bestEffort({
      ...baseEvent(session), action: 'terminal.session.close', outcome: reason, at: new Date(endedAt).toISOString(), durationMs: endedAt - session.openedAt,
    });
  }

  function deliver(session: Session, chunk: Buffer): void {
    if (session.ended) return;
    const { controller } = session;
    if (controller && session.queue.length === 0 && (controller.desiredSize ?? 0) > 0) {
      // Thrown from an SSH data event, an error here would take every session with it.
      try {
        controller.enqueue(new Uint8Array(chunk));
        return;
      } catch {
        session.controller = null;
        session.detachedSince = now();
      }
    }
    if (session.queuedBytes + chunk.byteLength > limits.maxBufferedBytes * HARD_BUFFER_MULTIPLE) {
      end(session, 'output-overflow');
      return;
    }
    session.queue.push(chunk);
    session.queuedBytes += chunk.byteLength;
    if (session.queuedBytes >= limits.maxBufferedBytes && !session.paused) {
      session.paused = true;
      session.channel.pause();
    }
  }

  function drainQueue(session: Session): void {
    const { controller } = session;
    while (controller && session.queue.length > 0 && (controller.desiredSize ?? 0) > 0) {
      const chunk = session.queue.shift()!;
      session.queuedBytes -= chunk.byteLength;
      controller.enqueue(new Uint8Array(chunk));
    }
    if (session.paused && session.queuedBytes < Math.min(LOW_WATER_BYTES, limits.maxBufferedBytes / 2)) {
      session.paused = false;
      session.channel.resume();
    }
  }

  /** The caller's session, only if the caller owns it. Unknown and foreign look identical. */
  function owned(sessionId: string, principal: Principal): Session {
    const session = sessions.get(sessionId);
    if (!session || session.ownerKey !== principal.ownerKey) {
      const refused = new GatewayError('SESSION_NOT_FOUND');
      refused.audit = { subject: principal.identity.subject, actorId: principal.link.localUserId, nodeId: session?.nodeId ?? null };
      throw refused;
    }
    // A later token from the same identity session keeps the terminal alive past the first one's expiry.
    if (principal.identity.expiresAt > session.tokenExpiresAt) {
      session.token = principal.token;
      session.tokenExpiresAt = principal.identity.expiresAt;
    }
    return session;
  }

  async function recheck(session: Session): Promise<void> {
    if (session.checking || session.ended) return;
    session.checking = true;
    const token = session.token;
    const expiresAt = session.tokenExpiresAt;
    try {
      await authorizer.authorize(token);
    } catch (error) {
      // A newer token arrived meanwhile, so this answer no longer describes the session.
      if (session.token === token) {
        const forbidden = error instanceof GatewayError && error.code === 'FORBIDDEN';
        end(session, forbidden ? 'authority-lost' : expiresAt * 1000 <= now() ? 'token-expired' : 'token-revoked');
      }
    } finally {
      session.checking = false;
    }
  }

  function tick(): void {
    const at = now();
    for (const session of [...sessions.values()]) {
      if (at - session.openedAt >= limits.maxLifetimeMs) end(session, 'max-lifetime');
      else if (at - session.lastInputAt >= limits.idleTimeoutMs) end(session, 'idle-timeout');
      else if (session.detachedSince !== null && at - session.detachedSince >= limits.detachGraceMs) end(session, 'detached');
      else void recheck(session);
    }
    for (const [id, tombstone] of tombstones) if (at - tombstone.endedAt >= TOMBSTONE_TTL_MS) tombstones.delete(id);
  }

  const timer = setInterval(tick, limits.recheckMs);
  timer.unref();

  return {
    async open(request: OpenRequest): Promise<{ sessionId: string; openedAt: string; expiresAt: string; idleTimeoutSeconds: number; maxLifetimeSeconds: number }> {
      const { principal, nodeId, ipAddress } = request;
      admit(principal.subjectKey);
      const id = `ts_${randomBytes(32).toString('base64url')}`;
      let live: { channel: ShellChannel; work: ManagedWork };
      try {
        // Recorded before anything reaches a node, so a login that cannot be audited never happens.
        await auditor.required({
          action: 'terminal.session.open', outcome: 'requested', subject: principal.identity.subject, actorId: principal.link.localUserId,
          nodeId, sessionId: id, ipAddress, fingerprint: null, at: new Date(now()).toISOString(), durationMs: null,
        }).catch(() => { throw new GatewayError('AUDIT_UNAVAILABLE'); });
        live = await connect(request, limits.maxLifetimeMs);
      } finally {
        bump(principal.subjectKey, -1);
      }
      if (stopping) {
        live.channel.terminate();
        live.work.finish('unknown').catch(() => console.error(JSON.stringify({ type: 'settlement-unacknowledged', workId: live.work.workId })));
        throw new GatewayError('GATEWAY_STOPPING');
      }
      const openedAt = now();
      const session: Session = {
        id,
        ownerKey: principal.ownerKey,
        subjectKey: principal.subjectKey,
        subject: principal.identity.subject,
        actorId: principal.link.localUserId,
        nodeId,
        ipAddress,
        channel: live.channel,
        work: live.work,
        openedAt,
        lastInputAt: openedAt,
        detachedSince: openedAt,
        token: principal.token,
        tokenExpiresAt: principal.identity.expiresAt,
        queue: [],
        queuedBytes: 0,
        paused: false,
        controller: null,
        checking: false,
        ended: false,
      };
      sessions.set(session.id, session);
      live.channel.onData((chunk) => deliver(session, chunk));
      live.channel.onClose((exitCode) => end(session, exitCode === null ? 'connection-lost' : 'remote-ended', { keepOutput: true }));
      try {
        await auditor.required({ ...baseEvent(session), action: 'terminal.session.open', outcome: 'opened', at: new Date(openedAt).toISOString(), durationMs: null });
      } catch {
        end(session, 'audit-unavailable');
        throw new GatewayError('AUDIT_UNAVAILABLE');
      }
      return {
        sessionId: session.id,
        openedAt: new Date(openedAt).toISOString(),
        expiresAt: new Date(openedAt + limits.maxLifetimeMs).toISOString(),
        idleTimeoutSeconds: Math.floor(limits.idleTimeoutMs / 1000),
        maxLifetimeSeconds: Math.floor(limits.maxLifetimeMs / 1000),
      };
    },

    /** One reader at a time. A reconnecting owner replaces the previous reader. */
    attach(sessionId: string, principal: Principal): ReadableStream<Uint8Array> {
      const session = owned(sessionId, principal);
      const previous = session.controller;
      session.controller = null;
      try { previous?.close(); } catch { /* already closed */ }
      let mine: ReadableStreamDefaultController<Uint8Array> | null = null;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          mine = controller;
          session.controller = controller;
          session.detachedSince = null;
          drainQueue(session);
        },
        pull() {
          if (session.controller === mine) drainQueue(session);
        },
        cancel() {
          if (session.controller === mine) {
            session.controller = null;
            session.detachedSince = now();
          }
        },
      }, new ByteLengthQueuingStrategy({ highWaterMark: LOW_WATER_BYTES }));
    },

    input(sessionId: string, principal: Principal, data: string): void {
      const session = owned(sessionId, principal);
      if (session.channel.congested) throw new GatewayError('INPUT_BUSY');
      session.lastInputAt = now();
      session.channel.write(data);
    },

    resize(sessionId: string, principal: Principal, size: PtySize): void {
      owned(sessionId, principal).channel.resize(size);
    },

    /** Presenting a newer token is the renewal. It does not count as activity. */
    renew(sessionId: string, principal: Principal): void {
      owned(sessionId, principal);
    },

    close(sessionId: string, principal: Principal): void {
      const tombstone = tombstones.get(sessionId);
      if (tombstone?.ownerKey === principal.ownerKey) return;
      end(owned(sessionId, principal), 'client-closed');
    },

    status(sessionId: string, principal: Principal): SessionStatus {
      const tombstone = tombstones.get(sessionId);
      if (tombstone?.ownerKey === principal.ownerKey) return { state: 'ended', reason: tombstone.reason };
      const session = owned(sessionId, principal);
      return {
        state: 'open',
        nodeId: session.nodeId,
        idleDeadline: new Date(session.lastInputAt + limits.idleTimeoutMs).toISOString(),
        expiresAt: new Date(session.openedAt + limits.maxLifetimeMs).toISOString(),
      };
    },

    /** The owner's newest token no longer grants the terminal, so nothing of theirs may stay open. */
    endForOwner(ownerKey: string): void {
      for (const session of [...sessions.values()]) if (session.ownerKey === ownerKey) end(session, 'authority-lost');
    },

    /** End everything. Settlements and audit records are sent, not awaited. */
    shutdown(): void {
      stopping = true;
      clearInterval(timer);
      for (const session of [...sessions.values()]) end(session, 'gateway-shutdown');
    },

    size: () => sessions.size,
    tick,
  };
}

export type SessionManager = ReturnType<typeof createSessionManager>;
