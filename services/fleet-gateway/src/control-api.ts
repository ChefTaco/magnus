/** Fixed requests to the Magnus API. No caller supplies an origin, a path or a credential. */
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { z } from 'zod';
import { GatewayError } from './errors.js';

const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export interface ControlApiResponse { status: number; body: unknown }

/** Sends one POST. Redirects are never followed: node:https does not, and a 3xx is not a 200. */
export type ControlApiTransport = (path: string, credential: { header: string; value: string }, body: unknown) => Promise<ControlApiResponse>;

export function httpsTransport(baseUrl: string, caPath: string | undefined): ControlApiTransport {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('CONTROL_API_URL must be an HTTPS URL without credentials, a query or a fragment');
  }
  const prefix = base.pathname.replace(/\/+$/, '');
  const ca = caPath ? readFileSync(caPath) : undefined;
  return (path, credential, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const request = httpsRequest(new URL(`${prefix}${path}`, base.origin), {
      method: 'POST',
      rejectUnauthorized: true,
      ...(ca ? { ca } : {}),
      timeout: REQUEST_TIMEOUT_MS,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), [credential.header]: credential.value },
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > MAX_RESPONSE_BYTES) request.destroy(new Error('response too large'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        let parsed: unknown = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* a non-JSON body is treated as no body */ }
        resolve({ status: response.statusCode ?? 0, body: parsed });
      });
    });
    request.on('timeout', () => request.destroy(new Error('request timed out')));
    request.on('error', reject);
    request.end(data);
  });
}

const envelope = z.object({ success: z.literal(true), data: z.unknown() }).loose();
const nodeSchema = z.object({
  nodeId: z.string().min(1).max(128),
  hostname: z.string().min(1).max(253),
  ipAddress: z.string().min(1).max(64),
  status: z.string().min(1).max(32),
  managedTerminal: z.boolean().optional(),
}).strict();

export type NodeRecord = z.infer<typeof nodeSchema>;

export const AUDIT_ACTIONS = [
  'terminal.session.open', 'terminal.session.close', 'terminal.session.refuse',
  'terminal.host-key.approve', 'terminal.host-key.remove',
] as const;

export interface AuditEvent {
  action: typeof AUDIT_ACTIONS[number];
  /** Oathweave subject, or the operator named on an approval. */
  subject: string;
  /** Local account named by the identity link, when there is one. */
  actorId: string;
  nodeId: string | null;
  /** The opaque session handle, never terminal content. */
  sessionId: string | null;
  outcome: string;
  at: string;
  durationMs: number | null;
  ipAddress: string | null;
  fingerprint: string | null;
}

/** Why the resource coordinator refused, as its own bounded code. */
export class ParticipantRefused extends Error {
  constructor(readonly upstreamCode: string | null) { super('participant refused'); }
}

const upstreamCode = (body: unknown): string | null => {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : null;
};

export interface ControlApi {
  resolveNode(nodeId: string): Promise<NodeRecord | null>;
  audit(event: AuditEvent): Promise<void>;
  /** A resource-enrollment participant call: reserve, start, finish, status. */
  participant(path: string, body: unknown): Promise<Record<string, unknown>>;
}

export function createControlApi(send: ControlApiTransport, gatewayToken: string, participantSecret: string): ControlApi {
  const gateway = { header: 'x-fleet-gateway-token', value: gatewayToken };
  const unavailable = () => new GatewayError('CONTROL_API_UNAVAILABLE');

  return {
    async resolveNode(nodeId) {
      let response = await send('/api/v1/fleet-gateway/target', gateway, { nodeId, managedTerminalProtocol: 1 }).catch(() => { throw unavailable(); });
      // Older APIs strictly accept only nodeId. This retry is read-only, never a shell dispatch.
      if (response.status === 400) response = await send('/api/v1/fleet-gateway/target', gateway, { nodeId }).catch(() => { throw unavailable(); });
      if (response.status === 404) return null;
      if (response.status !== 200) throw unavailable();
      const parsed = envelope.safeParse(response.body);
      const node = parsed.success ? nodeSchema.safeParse(parsed.data.data) : undefined;
      if (!node?.success) throw unavailable();
      return node.data;
    },
    async audit(event) {
      const response = await send('/api/v1/fleet-gateway/audit', gateway, event).catch(() => { throw unavailable(); });
      if (response.status !== 200) throw unavailable();
    },
    async participant(path, body) {
      const response = await send(`/api/v1/resource-leases/enrollment/dashboard${path}`, { header: 'x-resource-drain-key', value: participantSecret }, body);
      if (response.status !== 200) throw new ParticipantRefused(upstreamCode(response.body));
      const value = response.body as { success?: unknown; data?: unknown } | null;
      if (value?.success !== true || !value.data || typeof value.data !== 'object') throw new Error('Invalid resource authority response');
      return value.data as Record<string, unknown>;
    },
  };
}
