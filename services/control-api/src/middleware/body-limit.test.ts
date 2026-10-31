import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { bodyLimitMiddleware } from './body-limit.js';

function streamedRequest(body: string): Request {
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, Math.ceil(bytes.length / 2)));
      controller.enqueue(bytes.subarray(Math.ceil(bytes.length / 2)));
      controller.close();
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
