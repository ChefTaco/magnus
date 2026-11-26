/**
 * Self-probe of the agent's own inbound listener, run before a self-upgrade on
 * trial is confirmed. A heartbeat is outbound only: a version whose listener or
 * TLS setup is broken still heartbeats, and once confirmed it could no longer
 * be reached for a fix. The trial is confirmed only after this probe reaches
 * `GET /api/v1/health/check` over the real listener, signed with the node's own
 * key, and gets this version back.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { selfSignedHealthCheckHeaders } from '../acceptance.js';
import { verifiedTlsOptions } from '../tls.js';

export interface OwnListener {
  /** `https` or `http` (development opt-in). */
  protocol: 'https:' | 'http:';
  /** The address the listener is bound to; a wildcard is probed through loopback. */
  hostname: string;
  port: number;
}

let ownListener: OwnListener | null = null;

/** start.ts records the listener once it is bound. */
export function registerOwnListener(listener: OwnListener | null): void { ownListener = listener; }

export type SelfProbeResult = { ok: true } | { ok: false; reason: string };

function loopbackFor(hostname: string): string {
  if (hostname === '0.0.0.0' || hostname === '') return '127.0.0.1';
  if (hostname === '::' || hostname === '[::]') return '::1';
  return hostname.replace(/^\[|\]$/g, '');
}

/** The probe signs with the node's own key; a node without a bound key gets none (no shared-secret path). */
export function selfProbeHeaders(sign: () => Record<string, string> = selfSignedHealthCheckHeaders): Record<string, string> | null {
  const signed = sign();
  return Object.keys(signed).length ? signed : null;
}

interface ProbeTarget { url: URL; tls: { rejectUnauthorized: boolean; ca?: Buffer; servername?: string } }

function probeTarget(listener: OwnListener, env: NodeJS.ProcessEnv): ProbeTarget {
  // An operator-supplied self URL (also used by `magnus-agent acceptance`) is probed with
  // full certificate verification. Otherwise the listener is probed on loopback, where the
  // certificate's names cannot match; the handshake and certificate dates still are checked.
  const selfUrl = env['MAGNUS_AGENT_SELF_URL']?.trim();
  if (selfUrl && listener.protocol === 'https:') {
    return { url: new URL('/api/v1/health/check', selfUrl), tls: verifiedTlsOptions(env['MAGNUS_AGENT_SELF_CA_PATH']) };
  }
  const host = loopbackFor(listener.hostname);
  const url = new URL(`${listener.protocol}//${host.includes(':') ? `[${host}]` : host}:${listener.port}/api/v1/health/check`);
  return { url, tls: { rejectUnauthorized: false } };
}

function get(target: ProbeTarget, path: string, headers: Record<string, string>, timeoutMs: number, now: () => number): Promise<SelfProbeResult & { body?: string }> {
  return new Promise((resolve) => {
    const url = new URL(path, target.url);
    const options = { method: 'GET', headers, timeout: timeoutMs, ...(url.protocol === 'https:' ? target.tls : {}) };
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, options, (res) => {
      if (url.protocol === 'https:') {
        const certificate = (res.socket as TLSSocket).getPeerCertificate?.();
        const notAfter = certificate?.valid_to ? Date.parse(certificate.valid_to) : NaN;
        const notBefore = certificate?.valid_from ? Date.parse(certificate.valid_from) : NaN;
        if (!certificate || !Number.isFinite(notAfter) || notAfter <= now() || (Number.isFinite(notBefore) && notBefore > now())) {
          res.destroy(); resolve({ ok: false, reason: 'listener certificate is missing, expired or not yet valid' }); return;
        }
      }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) res.destroy(); else chunks.push(chunk); });
      res.on('end', () => {
        if (res.statusCode !== 200) resolve({ ok: false, reason: `listener answered ${res.statusCode ?? 'nothing'}` });
        else resolve({ ok: true, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', (error) => resolve({ ok: false, reason: error.message }));
    });
    req.on('timeout', () => req.destroy(new Error('listener did not answer in time')));
    req.on('error', (error) => resolve({ ok: false, reason: error.message }));
    req.end();
  });
}

/**
 * Probe this agent's listener. A node without a bound key (not enrolled) can
 * only show that the listener answers `/api/v1/ping`.
 */
export async function probeOwnListener(expectedVersion: string, options: {
  env?: NodeJS.ProcessEnv; listener?: OwnListener | null; sign?: () => Record<string, string>; timeoutMs?: number; now?: () => number;
} = {}): Promise<SelfProbeResult> {
  const env = options.env ?? process.env;
  const listener = options.listener === undefined ? ownListener : options.listener;
  if (!listener) return { ok: false, reason: 'the listener has not started' };
  const timeoutMs = options.timeoutMs ?? 10_000; const now = options.now ?? Date.now;
  let target: ProbeTarget;
  try { target = probeTarget(listener, env); } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
  const headers = selfProbeHeaders(options.sign);
  const response = await get(target, headers ? '/api/v1/health/check' : '/api/v1/ping', headers ?? {}, timeoutMs, now);
  if (!response.ok) return response;
  try {
    const parsed = JSON.parse(response.body ?? '') as { success?: boolean; data?: { version?: string; service?: string } };
    if (!headers) return parsed && typeof parsed === 'object' ? { ok: true } : { ok: false, reason: 'unexpected ping answer' };
    if (parsed.success !== true || parsed.data?.version !== expectedVersion)
      return { ok: false, reason: `listener reports version ${parsed.data?.version ?? 'unknown'}, not ${expectedVersion}` };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'listener answered with something other than JSON' };
  }
}
