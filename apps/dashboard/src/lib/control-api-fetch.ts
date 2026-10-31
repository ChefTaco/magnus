/** Verified server-side fetch for Control API requests made by route handlers and RSCs. */
import { existsSync, readFileSync } from 'node:fs';
import { Agent, fetch as undiciFetch } from 'undici';

const caPath = process.env['CONTROL_API_CA_PATH']?.trim();
if (caPath && !existsSync(caPath)) {
  throw new Error(`CONTROL_API_CA_PATH does not exist: ${caPath}`);
}

const controlApiAgent = new Agent({
  connect: {
    rejectUnauthorized: true,
    ...(caPath ? { ca: readFileSync(caPath) } : {}),
  },
});

export async function controlApiFetch(url: string | URL, init?: RequestInit, options?: { timeoutMs?: number }): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? Number(process.env['DASHBOARD_DEPENDENCY_TIMEOUT_MS'] ?? 8_000);
  const externalSignal = init?.signal;
  const isEventStream = new Headers(init?.headers).get('accept')?.includes('text/event-stream') ?? false;
  const timeoutSignal = isEventStream ? null : AbortSignal.timeout(timeoutMs);
  const signal = externalSignal && timeoutSignal
    ? AbortSignal.any([externalSignal, timeoutSignal])
    : externalSignal ?? timeoutSignal ?? undefined;
  // undici's fetch types differ slightly from lib.dom at this boundary.
  const response = await undiciFetch(url, {
    ...init,
    signal,
    dispatcher: controlApiAgent,
  } as Parameters<typeof undiciFetch>[1]);
  return response as unknown as Response;
}
