import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { errorHandler } from '../middleware/error-handler.js';
import { bodyLimitMiddleware } from '../middleware/body-limit.js';
import { parseBody, parseInput } from './validate.js';

const schema = z.object({ name: z.string().min(1) });

function app() {
  const hono = new Hono();
  hono.onError(errorHandler);
  hono.use('*', bodyLimitMiddleware(64));
  hono.post('/', async (c) => c.json({ success: true, data: await parseBody(c, schema) }));
  hono.get('/items/:id', (c) => c.json({ success: true, data: parseInput(c.req.param('id'), z.coerce.number().int().positive()) }));
  return hono;
}

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  app().request('/', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

describe('request validation helpers', () => {
  it('accepts a valid body', async () => {
    const response = await post('{"name":"alice"}');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { name: 'alice' } });
  });

  it.each(['{', '', 'not json'])('answers malformed JSON %j with 400, not 500', async (body) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' } });
  });

  it('answers a schema violation with 400 and the failing path', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await post('{"name":""}');
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('name') });
  });

  it('keeps 413 for a streamed body over the limit', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`{"name":"${'a'.repeat(200)}"}`));
        controller.close();
      },
    });
    const response = await app().request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half' } as RequestInit);
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('answers an invalid path parameter with 400, not 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await app().request('/items/7')).status).toBe(200);
    const response = await app().request('/items/abc');
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION_ERROR');
  });
});
