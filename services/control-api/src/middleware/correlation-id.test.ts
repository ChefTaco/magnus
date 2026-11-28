import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { getRequestContext } from '@hivemagnus/hive-common/context';
import { correlationId } from './correlation-id.js';
import { tracing } from './tracing.js';

const app = new Hono();
app.use('*', correlationId);
app.use('*', tracing);
app.get('/probe', (c) => c.json({ requestId: c.get('requestId' as never), contextId: getRequestContext()?.requestId ?? null }));
app.get('/fail', () => { throw new Error('boom'); });
app.onError((_error, c) => c.json({ error: 'failed' }, 500));

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';

describe('request context', () => {
  it('reuses a valid inbound request ID in the response header, c.var and the async context', async () => {
    const response = await app.request('/probe', { headers: { 'x-request-id': 'req-123:abc' } });
    expect(response.headers.get('x-request-id')).toBe('req-123:abc');
    expect(await response.json()).toEqual({ requestId: 'req-123:abc', contextId: 'req-123:abc' });
  });

  it('replaces an inbound request ID that is not a plain token instead of echoing it', async () => {
    for (const bad of ['has space', 'x'.repeat(129), '<script>', 'line\tbreak']) {
      const response = await app.request('/probe', { headers: { 'x-request-id': bad } });
      const id = response.headers.get('x-request-id');
      expect(id, bad).not.toBe(bad);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(((await response.json()) as { requestId: string }).requestId).toBe(id);
    }
  });

  it('generates an ID when none is sent, and keeps the header on an error response', async () => {
    expect((await app.request('/probe')).headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const failed = await app.request('/fail', { headers: { 'x-request-id': 'req-failed' } });
    expect(failed.status).toBe(500);
    expect(failed.headers.get('x-request-id')).toBe('req-failed');
  });

  it('continues a valid traceparent with a new span and starts a new trace for an invalid one', async () => {
    const inbound = `00-${TRACE_ID}-b7ad6b7169203331-01`;
    const child = (await app.request('/probe', { headers: { traceparent: inbound, tracestate: 'vendor=1' } })).headers;
    expect(child.get('traceparent')).toMatch(new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-01$`));
    expect(child.get('traceparent')).not.toBe(inbound);
    expect(child.get('tracestate')).toBe('vendor=1');
    // An all-zero trace ID is invalid: a new trace starts and the tracestate is not propagated.
    const fresh = (await app.request('/probe', { headers: { traceparent: `00-${'0'.repeat(32)}-b7ad6b7169203331-01`, tracestate: 'vendor=1' } })).headers;
    expect(fresh.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(fresh.get('traceparent')).not.toContain('0'.repeat(32));
    expect(fresh.get('tracestate')).toBeNull();
  });
});
