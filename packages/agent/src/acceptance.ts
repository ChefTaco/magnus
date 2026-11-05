import { z } from 'zod';
import { Agent, fetch as undiciFetch } from 'undici';
import { verifiedTlsOptions } from './tls.js';

const optionsSchema = z.object({
  selfUrl: z.url().refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === '/'
      );
    } catch {
      return false;
    }
  }),
  credential: z.string().min(32).max(16384),
  caPath: z.string().min(1).optional(),
  expectedVersion: z.string().min(1),
  waitSeconds: z.number().int().min(0).max(300).default(60),
});
const healthSchema = z.object({
  success: z.literal(true),
  data: z.object({
    service: z.literal('magnus-agent'),
    status: z.enum(['healthy', 'degraded']),
    version: z.string(),
    heartbeat: z.object({
      running: z.boolean(),
      lastAcceptedAt: z.iso.datetime().nullable(),
      consecutiveFailures: z.number().int().min(0),
    }),
  }),
});
export type AgentAcceptanceOptions = z.input<typeof optionsSchema>;
export type AgentAcceptanceResult =
  | { ok: true; version: string; heartbeatAcceptedAt: string }
  | {
      ok: false;
      reason:
        | 'INVALID_CONFIGURATION'
        | 'AGENT_NOT_READY'
        | 'HEARTBEAT_NOT_ACCEPTED'
        | 'VERSION_MISMATCH'
        | 'PROBE_FAILED';
    };

/** Only bounded readiness evidence leaves this command; never raw health payloads or credentials. */
export async function probeAgentAcceptance(
  raw: AgentAcceptanceOptions,
  overrides: {
    fetch?: typeof fetch;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<AgentAcceptanceResult> {
  const parsed = optionsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'INVALID_CONFIGURATION' };
  const options = parsed.data,
    now = overrides.now ?? Date.now,
    sleep =
      overrides.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  let dispatcher: Agent | undefined;
  try {
    const request =
      overrides.fetch ??
      ((input, init) =>
        undiciFetch(input as Parameters<typeof undiciFetch>[0], {
          ...(init as Parameters<typeof undiciFetch>[1]),
          dispatcher: dispatcher!,
        }) as unknown as Promise<Response>);
    if (!overrides.fetch) dispatcher = new Agent({ connect: verifiedTlsOptions(options.caPath) });
    const deadline = now() + options.waitSeconds * 1000;
    let result: AgentAcceptanceResult = { ok: false, reason: 'PROBE_FAILED' };
    do {
      try {
        const response = await request(new URL('/api/v1/health/check', options.selfUrl), {
          headers: { 'x-node-token': options.credential },
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
          await response.body?.cancel();
          result = { ok: false, reason: 'PROBE_FAILED' };
        } else {
          const reader = response.body?.getReader();
          if (!reader) throw Error('Missing health response');
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            while (true) {
              const entry = await reader.read();
              if (entry.done) break;
              size += entry.value.byteLength;
              if (size > 1024 * 1024) throw Error('Oversized health response');
              chunks.push(entry.value);
            }
          } finally {
            await reader.cancel();
          }
          const health = healthSchema.parse(
            JSON.parse(Buffer.concat(chunks).toString('utf8')),
          ).data;
          if (health.version !== options.expectedVersion)
            return { ok: false, reason: 'VERSION_MISMATCH' };
          const accepted = health.heartbeat.lastAcceptedAt,
            age = accepted === null ? Infinity : now() - Date.parse(accepted);
          result =
            health.status !== 'healthy'
              ? { ok: false, reason: 'AGENT_NOT_READY' }
              : !health.heartbeat.running ||
                  health.heartbeat.consecutiveFailures !== 0 ||
                  age < -5000 ||
                  age > 90000
                ? { ok: false, reason: 'HEARTBEAT_NOT_ACCEPTED' }
                : { ok: true, version: health.version, heartbeatAcceptedAt: accepted! };
          if (result.ok) return result;
        }
      } catch {
        result = { ok: false, reason: 'PROBE_FAILED' };
      }
      if (now() >= deadline) break;
      await sleep(Math.min(1000, deadline - now()));
    } while (now() <= deadline);
    return result;
  } catch {
    return { ok: false, reason: 'INVALID_CONFIGURATION' };
  } finally {
    await dispatcher?.close();
  }
}

export async function runAgentAcceptance(
  arguments_: string[],
  env: NodeJS.ProcessEnv,
  expectedVersion: string,
): Promise<AgentAcceptanceResult> {
  let waitSeconds = 60;
  for (let index = 0; index < arguments_.length; index++) {
    const value = arguments_[index];
    if (value === '--json') continue;
    if (value === '--wait-seconds' && /^\d+$/.test(arguments_[index + 1] ?? '')) {
      waitSeconds = Number(arguments_[++index]);
      continue;
    }
    return { ok: false, reason: 'INVALID_CONFIGURATION' };
  }
  return probeAgentAcceptance({
    selfUrl: env['MAGNUS_AGENT_SELF_URL'] ?? '',
    credential: env['NODE_MANAGER_SECRET'] ?? '',
    expectedVersion,
    waitSeconds,
    ...(env['MAGNUS_AGENT_SELF_CA_PATH'] ? { caPath: env['MAGNUS_AGENT_SELF_CA_PATH'] } : {}),
  });
}
