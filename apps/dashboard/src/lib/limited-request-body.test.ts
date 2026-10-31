import { describe, expect, it, vi } from 'vitest';
import { readLimitedRequestBody, RequestBodyTooLarge } from './limited-request-body';

function streamedRequest(chunks: string[], headers: HeadersInit = {}, cancel = vi.fn()): Request {
  return new Request('https://dashboard.example/api/proxy/commands', {
    method: 'POST', headers,
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      }, cancel,
    }),
    duplex: 'half',
  } as RequestInit);
}

describe('bounded proxy request bodies', () => {
  it('rejects and cancels a chunked body without a length header', async () => {
    const cancel = vi.fn();
    await expect(readLimitedRequestBody(streamedRequest(['123', '456'], {}, cancel), 5))
      .rejects.toBeInstanceOf(RequestBodyTooLarge);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('measures bytes even when the length header understates the body', async () => {
    await expect(readLimitedRequestBody(streamedRequest(['ééé'], { 'content-length': '1' }), 5))
      .rejects.toBeInstanceOf(RequestBodyTooLarge);
  });

  it('preserves a UTF-8 body at the exact byte limit', async () => {
    const body = new TextEncoder().encode('éé');
    const request = new Request('https://dashboard.example', { method: 'POST', body });
    expect(await readLimitedRequestBody(request, 4)).toBe('éé');
  });

  it('rejects an oversized declared body before reading', async () => {
    const request = streamedRequest([], { 'content-length': '6' });
    await expect(readLimitedRequestBody(request, 5)).rejects.toBeInstanceOf(RequestBodyTooLarge);
    expect(request.bodyUsed).toBe(false);
  });

  it('fails closed on invalid limits and interrupted input', async () => {
    await expect(readLimitedRequestBody(new Request('https://dashboard.example'), NaN)).rejects.toThrow('Invalid');
    const request = new Request('https://dashboard.example', {
      method: 'POST', body: new ReadableStream({ start(controller) { controller.error(new Error('interrupted')); } }),
      duplex: 'half',
    } as RequestInit);
    await expect(readLimitedRequestBody(request, 5)).rejects.toThrow('interrupted');
  });
});
