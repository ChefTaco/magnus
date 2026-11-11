import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../server.js';

function tinyChunkRequest(path: string, size: number): Request {
  let emitted = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted++ < size) controller.enqueue(new Uint8Array([120]));
      else controller.close();
    },
  });
  return new Request(`http://localhost${path}`, {
    method: 'POST', body, duplex: 'half',
  } as RequestInit);
}

afterEach(() => vi.unstubAllEnvs());

describe('Control API tiny-chunk request limits', () => {
  it('bounds the public ingestion path before authentication or route handling', async () => {
    vi.stubEnv('HIVE_REHEARSAL', 'false');
    const response = await app.fetch(tinyChunkRequest('/api/v1/security-fusion/ingest/events', 262_145));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
  });

  it('keeps the source-status limit even when the generic limit is larger', async () => {
    vi.stubEnv('HIVE_REHEARSAL', 'false');
    vi.stubEnv('API_BODY_LIMIT_BYTES', '1048576');
    const response = await app.fetch(tinyChunkRequest('/api/v1/security-fusion/ingest/source-status', 32_769));
    expect(response.status).toBe(413);
  });

  it('rejects an oversized generic API request before node authentication', async () => {
    vi.stubEnv('HIVE_REHEARSAL', 'false');
    vi.stubEnv('API_BODY_LIMIT_BYTES', '32');
    const response = await app.fetch(tinyChunkRequest('/api/v1/heartbeat', 33));
    expect(response.status).toBe(413);
  });

  it('passes an at-limit tiny-chunk request to the normal authentication guard', async () => {
    vi.stubEnv('HIVE_REHEARSAL', 'false');
    vi.stubEnv('API_BODY_LIMIT_BYTES', '32');
    const response = await app.fetch(tinyChunkRequest('/api/v1/heartbeat', 32));
    expect(response.status).toBe(401);
  });
});
