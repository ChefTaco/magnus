/** Hostname-verified server-side fetch for the Hive Router admin plane. */
import { existsSync, readFileSync } from 'node:fs';
import { Agent, fetch as undiciFetch } from 'undici';

export function hiveRouterTlsOptions(caPath?: string): {
  rejectUnauthorized: true;
  ca?: Buffer;
} {
  const normalized = caPath?.trim();
  if (!normalized) return { rejectUnauthorized: true };
  if (!existsSync(normalized)) {
    throw new Error(`HIVE_ROUTER_CA_PATH does not exist: ${normalized}`);
  }
  return { rejectUnauthorized: true, ca: readFileSync(normalized) };
}

const hiveRouterAgent = new Agent({
  connect: hiveRouterTlsOptions(process.env['HIVE_ROUTER_CA_PATH']),
});

export async function hiveRouterFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const timeoutMs = Number(process.env['DASHBOARD_DEPENDENCY_TIMEOUT_MS'] ?? 8_000);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  const response = await undiciFetch(url, {
    ...init,
    signal,
    dispatcher: hiveRouterAgent,
  } as Parameters<typeof undiciFetch>[1]);
  return response as unknown as Response;
}
