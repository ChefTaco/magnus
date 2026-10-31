/**
 * Redis-backed event bus for real-time inter-service communication.
 *
 * Uses Redis Pub/Sub to broadcast events (node status changes, commands,
 * audit events, alerts) to all connected subscribers. Enables front-end
 * SSE endpoints to receive live updates without polling.
 *
 * Usage:
 *   import { eventBus } from './event-bus.js';
 *   eventBus.publish('node:status', { nodeId, status });
 *   eventBus.subscribe('node:*', (channel, data) => { ... });
 */

import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
const CHANNEL_PREFIX = 'magnus:events:';

type EventHandler = (channel: string, data: unknown) => void;

// ── Circuit breaker states ──
type CircuitState = 'closed' | 'open' | 'half-open';
const FAILURE_THRESHOLD = 3;
const RESET_TIMEOUT_MS = 30_000; // 30s before trying half-open
const MAX_BUFFER_SIZE = 500;

interface BufferedEvent {
  channel: string;
  payload: string;
}

/** Redis envelope. `origin` lets a process drop its own messages, because
 * publish() already delivered them to local subscribers. */
interface EventEnvelope {
  origin: string;
  data: unknown;
}

function isEnvelope(value: unknown): value is EventEnvelope {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as { origin?: unknown }).origin === 'string'
    && 'data' in (value as object);
}

class EventBus {
  private publisher: Redis | null = null;
  private subscriber: Redis | null = null;
  private localEmitter = new EventEmitter();
  private connected = false;
  private connecting: Promise<void> | null = null;
  private patterns = new Set<string>();
  private readonly originId = randomUUID();

  // Circuit breaker state
  private circuitState: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private lastFailureAt = 0;
  private buffer: BufferedEvent[] = [];

  constructor() {
    this.localEmitter.setMaxListeners(100);
  }

  /** Connect to Redis (lazy — called automatically on first publish/subscribe).
   * Concurrent callers share one in-flight attempt. */
  private ensureConnected(): Promise<void> {
    if (this.connected) return Promise.resolve();
    this.connecting ??= this.connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private disconnectClients(): void {
    const publisher = this.publisher;
    const subscriber = this.subscriber;
    this.publisher = null;
    this.subscriber = null;
    subscriber?.removeAllListeners('pmessage');
    subscriber?.disconnect();
    publisher?.disconnect();
  }

  private async connect(): Promise<void> {
    // Never leak a previous pair (circuit-breaker reopen or failed attempt).
    this.disconnectClients();
    try {
      const publisher = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
      const subscriber = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
      this.publisher = publisher;
      this.subscriber = subscriber;

      await Promise.all([
        publisher.connect(),
        subscriber.connect(),
      ]);

      subscriber.on('pmessage', (_pattern, channel, message) => {
        const shortChannel = channel.replace(CHANNEL_PREFIX, '');
        let parsed: unknown;
        try {
          parsed = JSON.parse(message);
        } catch {
          this.localEmitter.emit(shortChannel, shortChannel, message);
          return;
        }
        let data = parsed;
        if (isEnvelope(parsed)) {
          // Already delivered locally by publish().
          if (parsed.origin === this.originId) return;
          data = parsed.data;
        }
        this.localEmitter.emit(shortChannel, shortChannel, data);
        this.localEmitter.emit('*', shortChannel, data);
      });

      // Re-subscribe to patterns
      for (const pattern of this.patterns) {
        await subscriber.psubscribe(`${CHANNEL_PREFIX}${pattern}`);
      }

      this.connected = true;
    } catch (err) {
      // Callers fall back to local-only mode; publish() counts the failure.
      this.disconnectClients();
      this.connected = false;
      throw err;
    }
  }

  /** Publish an event to the bus. Uses circuit breaker to avoid slow failures. */
  async publish(channel: string, data: unknown): Promise<void> {
    const fullChannel = `${CHANNEL_PREFIX}${channel}`;
    const payload = JSON.stringify({ origin: this.originId, data } satisfies EventEnvelope);

    // Always emit locally (never lost)
    this.localEmitter.emit(channel, channel, data);
    this.localEmitter.emit('*', channel, data);

    // Circuit breaker check
    if (this.circuitState === 'open') {
      if (Date.now() - this.lastFailureAt > RESET_TIMEOUT_MS) {
        this.circuitState = 'half-open';
      } else {
        // Buffer the event for replay when circuit closes
        if (this.buffer.length < MAX_BUFFER_SIZE) {
          this.buffer.push({ channel: fullChannel, payload });
        }
        return;
      }
    }

    try {
      await this.ensureConnected();
      if (this.publisher) {
        await this.publisher.publish(fullChannel, payload);
      }
      this.onSuccess();
    } catch {
      this.onFailure(fullChannel, payload);
    }
  }

  /** Record a successful Redis operation — close the circuit. */
  private onSuccess(): void {
    if (this.circuitState !== 'closed') {
      this.circuitState = 'closed';
      this.consecutiveFailures = 0;
      // Replay buffered events (fire-and-forget)
      void this.replayBuffer();
    }
    this.consecutiveFailures = 0;
  }

  /** Record a failed Redis operation — maybe open the circuit. */
  private onFailure(channel: string, payload: string): void {
    this.consecutiveFailures++;
    this.lastFailureAt = Date.now();

    if (this.consecutiveFailures >= FAILURE_THRESHOLD) {
      this.circuitState = 'open';
      this.connected = false;
      console.warn(`[EventBus] Circuit breaker OPEN after ${this.consecutiveFailures} failures`);
    }

    if (this.buffer.length < MAX_BUFFER_SIZE) {
      this.buffer.push({ channel, payload });
    }
  }

  /** Replay buffered events after circuit recovery. */
  private async replayBuffer(): Promise<void> {
    if (this.buffer.length === 0 || !this.publisher) return;
    console.log(`[EventBus] Replaying ${this.buffer.length} buffered events`);
    const events = this.buffer.splice(0);
    for (const evt of events) {
      try {
        await this.publisher.publish(evt.channel, evt.payload);
      } catch {
        // If replay fails, re-open circuit
        this.onFailure(evt.channel, evt.payload);
        break;
      }
    }
  }

  /** Subscribe to events matching a pattern (supports * glob). */
  async subscribe(pattern: string, handler: EventHandler): Promise<() => void> {
    this.patterns.add(pattern);

    try {
      await this.ensureConnected();
      if (this.subscriber) {
        await this.subscriber.psubscribe(`${CHANNEL_PREFIX}${pattern}`);
      }
    } catch {
      // Local-only mode
    }

    // Wrap to match the pattern ourselves for local events
    const wrappedHandler = (ch: string, data: unknown) => {
      handler(ch, data);
    };

    if (pattern === '*') {
      this.localEmitter.on('*', wrappedHandler);
    } else {
      this.localEmitter.on(pattern, wrappedHandler);
    }

    return () => {
      this.localEmitter.off(pattern === '*' ? '*' : pattern, wrappedHandler);
    };
  }

  /** Graceful shutdown. */
  async close(): Promise<void> {
    await this.connecting?.catch(() => undefined);
    if (this.subscriber && this.connected) {
      await this.subscriber.punsubscribe().catch(() => undefined);
    }
    this.disconnectClients();
    this.localEmitter.removeAllListeners();
    this.connected = false;
  }
}

/** Singleton event bus instance for the application. */
export const eventBus = new EventBus();

// ── Typed event channels ──
export const EventChannels = {
  NODE_STATUS: 'node:status',
  NODE_HEARTBEAT: 'node:heartbeat',
  COMMAND_STATUS: 'command:status',
  COMMAND_OUTPUT: 'command:output',
  DEPLOY_STATUS: 'deploy:status',
  ALERT_FIRED: 'alert:fired',
  AUDIT_EVENT: 'audit:event',
  ROLLOUT_PROGRESS: 'rollout:progress',
  DRIFT_RESULT: 'drift:result',
  HERMES_STATUS: 'hermes:status',
} as const;
