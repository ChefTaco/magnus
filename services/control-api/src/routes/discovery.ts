import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createSocket, type RemoteInfo } from 'node:dgram';
import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { getDb } from '../db/index.js';
import { AGENT_DISCOVERY_SECRET, ENABLE_AGENT_DISCOVERY } from '../utils/env.js';

export const discoveryRouter = new Hono<AppVariables>();

discoveryRouter.use('*', authMiddleware);

const DISCOVERY_PORT = 4199;
const DISCOVERY_TARGET = '255.255.255.255';
const DISCOVERY_TIMEOUT_MS = 5_000;
const DISCOVERY_SKEW_MS = 30_000;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface DiscoveryProbe {
  type: 'MAGNUS_DISCOVER';
  nonce: string;
  timestamp: number;
  signature: string;
}

interface DiscoveryResponse {
  type: 'MAGNUS_AGENT_RESPONSE';
  nonce: string;
  timestamp: number;
  hostname: string;
  fqdn: string;
  port: number;
  version: string;
  signature: string;
}

interface DiscoveredAgent {
  hostname: string;
  fqdn: string;
  ip: string;
  port: number;
  version: string;
  registered: boolean;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    timingSafeEqual(leftBuffer, leftBuffer);
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function sign(secret: string, value: Record<string, unknown>): string {
  return createHmac('sha256', secret).update(JSON.stringify(value)).digest('base64url');
}

function unsignedProbe(nonce: string, timestamp: number): Omit<DiscoveryProbe, 'signature'> {
  return { type: 'MAGNUS_DISCOVER', nonce, timestamp };
}

function unsignedResponse(response: Omit<DiscoveryResponse, 'signature'>): Omit<DiscoveryResponse, 'signature'> {
  return {
    type: 'MAGNUS_AGENT_RESPONSE',
    nonce: response.nonce,
    timestamp: response.timestamp,
    hostname: response.hostname,
    fqdn: response.fqdn,
    port: response.port,
    version: response.version,
  };
}

/** Create the nonce-bound signed UDP probe understood by current agents. */
export function createDiscoveryProbe(
  secret: string,
  timestamp = Date.now(),
  nonce = randomBytes(32).toString('base64url'),
): DiscoveryProbe {
  if (secret.length < 32) throw new Error('AGENT_DISCOVERY_SECRET must contain at least 32 characters');
  const unsigned = unsignedProbe(nonce, timestamp);
  return { ...unsigned, signature: sign(secret, unsigned) };
}

/** Accept only a fresh, signed response bound to this scan's nonce. */
export function verifyDiscoveryResponse(
  value: unknown,
  secret: string,
  expectedNonce: string,
  now = Date.now(),
): value is DiscoveryResponse {
  if (!value || typeof value !== 'object' || secret.length < 32) return false;
  const response = value as Partial<DiscoveryResponse>;
  if (
    response.type !== 'MAGNUS_AGENT_RESPONSE'
    || response.nonce !== expectedNonce
    || !NONCE_PATTERN.test(response.nonce)
    || typeof response.timestamp !== 'number'
    || !Number.isSafeInteger(response.timestamp)
    || Math.abs(now - response.timestamp) > DISCOVERY_SKEW_MS
    || typeof response.hostname !== 'string'
    || !response.hostname
    || response.hostname.length > 253
    || /[\r\n]/.test(response.hostname)
    || typeof response.fqdn !== 'string'
    || !response.fqdn
    || response.fqdn.length > 253
    || /[\r\n]/.test(response.fqdn)
    || typeof response.port !== 'number'
    || !Number.isInteger(response.port)
    || response.port < 1
    || response.port > 65_535
    || typeof response.version !== 'string'
    || !response.version
    || response.version.length > 253
    || /[\r\n]/.test(response.version)
    || typeof response.signature !== 'string'
    || !SIGNATURE_PATTERN.test(response.signature)
  ) return false;
  const unsigned = unsignedResponse(response as Omit<DiscoveryResponse, 'signature'>);
  return safeEqual(response.signature, sign(secret, unsigned));
}

/** POST /discovery/scan — authenticated API plus authenticated UDP exchange. */
discoveryRouter.post('/scan', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  if (!ENABLE_AGENT_DISCOVERY || AGENT_DISCOVERY_SECRET.length < 32) {
    throw new HttpError(503, 'DISCOVERY_DISABLED', 'Authenticated agent discovery is not configured');
  }

  const body = await c.req.json<{ timeoutMs?: number }>().catch(() => ({} as { timeoutMs?: number }));
  const requestedTimeout = Number(body.timeoutMs ?? DISCOVERY_TIMEOUT_MS);
  const timeout = Number.isFinite(requestedTimeout)
    ? Math.min(Math.max(Math.trunc(requestedTimeout), 250), 10_000)
    : DISCOVERY_TIMEOUT_MS;

  const discovered = await scanNetwork(timeout, AGENT_DISCOVERY_SECRET);
  const db = getDb();
  const existingNodes = await db.node.findMany({ select: { ipAddress: true, hostname: true } });
  const existingIps = new Set(existingNodes.map((node) => node.ipAddress));
  const existingHostnames = new Set(existingNodes.map((node) => node.hostname));
  const results: DiscoveredAgent[] = discovered.map((agent) => ({
    ...agent,
    registered: existingIps.has(agent.ip)
      || existingHostnames.has(agent.hostname)
      || existingHostnames.has(agent.fqdn),
  }));

  return c.json({
    success: true,
    data: results,
    meta: { total: results.length, newAgents: results.filter((result) => !result.registered).length },
  });
});

function scanNetwork(timeoutMs: number, secret: string): Promise<Array<Omit<DiscoveredAgent, 'registered'>>> {
  return new Promise((resolve) => {
    const agents: Array<Omit<DiscoveredAgent, 'registered'>> = [];
    const seen = new Set<string>();
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    const probe = createDiscoveryProbe(secret);
    let timer: ReturnType<typeof setTimeout> | undefined;

    socket.on('message', (message: Buffer, remote: RemoteInfo) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.toString('utf8')) as unknown;
      } catch {
        return;
      }
      if (!verifyDiscoveryResponse(parsed, secret, probe.nonce)) return;
      const key = `${remote.address}:${parsed.port}`;
      if (seen.has(key)) return;
      seen.add(key);
      agents.push({
        hostname: parsed.hostname,
        fqdn: parsed.fqdn,
        ip: remote.address,
        port: parsed.port,
        version: parsed.version,
      });
    });

    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolve(agents);
    };

    socket.on('error', (error) => {
      console.warn('[Discovery] Socket error:', error.message);
      finish();
    });

    socket.bind(0, () => {
      socket.setBroadcast(true);
      const message = Buffer.from(JSON.stringify(probe));
      socket.send(message, 0, message.length, DISCOVERY_PORT, DISCOVERY_TARGET, (error) => {
        if (error) {
          console.warn('[Discovery] Broadcast send error:', error.message);
          finish();
        }
      });
    });

    timer = setTimeout(finish, timeoutMs);
  });
}
