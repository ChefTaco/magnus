import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { bodyLimitMiddleware } from './body-limit.js';

function streamedRequest(body: string, chunkSize = Math.ceil(body.length / 2)): Request {
  const bytes = new TextEncoder().encode(body);
  let emitted = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const offset = emitted++ * chunkSize;
      if (offset >= bytes.length) controller.close();
      else controller.enqueue(bytes.slice(offset, offset + chunkSize));
    },
  });
  return new Request('http://localhost/ingest', {
    method: 'POST',
    body: stream,
    // Required by Node's fetch implementation for a streaming request body.
    duplex: 'half',
  } as RequestInit);
}

describe('bodyLimitMiddleware', () => {
  it('coalesces one-byte chunks before forwarding an at-limit body (GHSA-39q9-qp46-w8xg)', async () => {
    const app = new Hono();
    const body = 'x'.repeat(65_536);
    app.post('/ingest', bodyLimitMiddleware(body.length), async (c) => {
      const reader = c.req.raw.body!.getReader();
      let chunks = 0;
      let received = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks += 1;
        received += new TextDecoder().decode(value);
      }
      // The vulnerable implementation retains and replays every tiny allocation.
      // Observing the forwarded stream proves aggregation without flaky RSS limits.
      return c.json({ chunks, received });
    });
    const response = await app.fetch(streamedRequest(body, 1));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ chunks: 1, received: body });
  });

  it('rejects a one-byte chunked body as soon as it crosses the limit', async () => {
    const app = new Hono();
    let materialized = false;
    app.post('/ingest', bodyLimitMiddleware(8), async (c) => {
      materialized = true;
      return c.text(await c.req.text());
    });
    const response = await app.fetch(streamedRequest('123456789', 1));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    expect(materialized).toBe(false);
  });

  it('rejects an advertised oversized body before the handler reads it', async () => {
    const app = new Hono();
    let materialized = false;
    app.post('/ingest', bodyLimitMiddleware(8), async (c) => {
      materialized = true;
      await c.req.text();
      return c.text('ok');
    });
    const response = await app.request('/ingest', {
      method: 'POST',
      headers: { 'content-length': '9' },
      body: '123456789',
    });
    expect(response.status).toBe(413);
    expect(materialized).toBe(false);
  });

  it('counts chunked bytes instead of trusting a missing Content-Length', async () => {
    const app = new Hono();
    let materialized = false;
    app.post('/ingest', bodyLimitMiddleware(8), async (c) => {
      materialized = true;
      await c.req.text();
      return c.text('ok');
    });
    const response = await app.fetch(streamedRequest('123456789'));
    expect(response.status).toBe(413);
    expect(materialized).toBe(false);
  });
});
