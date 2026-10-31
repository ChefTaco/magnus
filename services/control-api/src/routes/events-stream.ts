import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware } from '../middleware/auth.js';
import { eventBus } from '../services/event-bus.js';

export const eventsStreamRouter = new Hono<{ Variables: AppVariables }>();

eventsStreamRouter.use('*', authMiddleware);

/**
 * GET /events/stream — SSE endpoint for real-time fleet events.
 *
 * Subscribes to the Redis event bus and pushes events to the client.
 * Supports optional `channels` query param (comma-separated) to filter.
 */
eventsStreamRouter.get('/', async (c) => {
  const channelFilter = c.req.query('channels')?.split(',').filter(Boolean);

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');

  const signal = c.req.raw.signal;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let closed = false;
  // Idempotent cleanup for every exit path: client abort, stream cancel, or a
  // disconnect that happened while the subscription was still being set up.
  const cleanup = () => {
    closed = true;
    if (keepAlive) clearInterval(keepAlive);
    keepAlive = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    signal.removeEventListener('abort', cleanup);
  };
  signal.addEventListener('abort', cleanup, { once: true });

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // Stream closed
        }
      };

      // Send initial connection event
      send('connected', { timestamp: new Date().toISOString() });

      // Keep-alive every 30s
      keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          cleanup();
        }
      }, 30_000);

      // Subscribe to all events via event bus
      const off = await eventBus.subscribe('*', (channel, data) => {
        // Apply channel filter if provided
        if (channelFilter && channelFilter.length > 0) {
          const match = channelFilter.some((f) => channel.startsWith(f));
          if (!match) return;
        }
        send(channel, data);
      });

      // The client may have gone away during the await above.
      if (closed || signal.aborted) {
        off();
        cleanup();
        return;
      }
      unsubscribe = off;
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});
