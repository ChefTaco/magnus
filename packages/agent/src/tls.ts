/** Verified outbound TLS helpers for the Magnus agent. */
import { existsSync, readFileSync } from 'node:fs';
import { Agent, fetch as undiciFetch } from 'undici';

export function verifiedTlsOptions(caPath?: string): {
  rejectUnauthorized: true;
  ca?: Buffer;
} {
  const normalized = caPath?.trim();
  if (!normalized) return { rejectUnauthorized: true };
  if (!existsSync(normalized)) {
    throw new Error(`CONTROL_API_CA_PATH does not exist: ${normalized}`);
  }
  return { rejectUnauthorized: true, ca: readFileSync(normalized) };
}

const systemTrustAgent = new Agent({ connect: { rejectUnauthorized: true } });
const controlApiAgent = new Agent({
  connect: verifiedTlsOptions(process.env['CONTROL_API_CA_PATH']),
});

function fetchWithAgent(
  agent: Agent,
  input: URL | RequestInfo,
  init?: RequestInit,
): Promise<Response> {
  // ky passes native Request objects; decompose them for undici and preserve
  // duplex for streamed bodies.
  if (input instanceof Request) {
    const { url, method, headers, body, signal } = input;
    return undiciFetch(url, {
      method,
      headers: Object.fromEntries(new Headers(headers).entries()),
      body,
      ...(body ? { duplex: 'half' as const } : {}),
      signal,
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher: agent,
    }) as unknown as Promise<Response>;
  }

  const mergedInit = init as Parameters<typeof undiciFetch>[1];
  return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
    ...mergedInit,
    ...(mergedInit?.body ? { duplex: 'half' as const } : {}),
    dispatcher: agent,
  }) as unknown as Promise<Response>;
}

/** Use system trust for arbitrary HTTPS downloads. */
export function verifiedFetch(input: URL | RequestInfo, init?: RequestInit): Promise<Response> {
  return fetchWithAgent(systemTrustAgent, input, init);
}

/** Use system trust plus the optional private CA for the configured Control API. */
export function controlApiFetch(input: URL | RequestInfo, init?: RequestInit): Promise<Response> {
  return fetchWithAgent(controlApiAgent, input, init);
}
