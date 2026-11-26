export class RequestBodyTooLarge extends Error {
  constructor() { super('Request body exceeds the configured limit'); }
}

/** Enforce the byte limit while reading, including chunked bodies with no Content-Length. */
export async function readLimitedRequestBody(request: Request, limitBytes: number): Promise<string> {
  return new TextDecoder().decode(await readLimitedBytes(request, limitBytes));
}

/** The bytes of a request or response body, refusing more than `limitBytes` (declared or streamed). */
export async function readLimitedBytes(message: { headers: Headers; body: ReadableStream<Uint8Array> | null }, limitBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) throw new Error('Invalid request body limit');
  if (Number(message.headers.get('content-length')) > limitBytes) {
    throw new RequestBodyTooLarge();
  }
  if (!message.body) return new Uint8Array(0);
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limitBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
