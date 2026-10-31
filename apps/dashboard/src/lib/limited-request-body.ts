export class RequestBodyTooLarge extends Error {
  constructor() { super('Request body exceeds the configured limit'); }
}

/** Enforce the byte limit while reading, including chunked bodies with no Content-Length. */
export async function readLimitedRequestBody(request: Request, limitBytes: number): Promise<string> {
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) throw new Error('Invalid request body limit');
  if (Number(request.headers.get('content-length')) > limitBytes) {
    throw new RequestBodyTooLarge();
  }
  if (!request.body) return '';
  const reader = request.body.getReader();
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
  return new TextDecoder().decode(body);
}
