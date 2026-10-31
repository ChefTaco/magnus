import { createHmac, randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { isIPv4 } from 'node:net';
import { AGENT_VERSION } from './version.js';
import { getFqdn } from './fqdn.js';
import {
  AGENT_DISCOVERY_BIND_ADDRESS,
  AGENT_DISCOVERY_SECRET,
  ENABLE_AGENT_DISCOVERY,
} from './env.js';
import { logger } from './utils/logger.js';
import { constantTimeEqual } from './middleware.js';

export const DISCOVERY_PORT = 4199;
const DISCOVERY_SKEW_MS = 30_000;
const MAX_RECENT_NONCES = 1_024;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface DiscoveryProbe {
  type: 'MAGNUS_DISCOVER';
  nonce: string;
  timestamp: number;
  signature: string;
}

export interface DiscoveryResponse {
  type: 'MAGNUS_AGENT_RESPONSE';
  nonce: string;
  timestamp: number;
  hostname: string;
  fqdn: string;
  port: number;
  version: string;
  signature: string;
}

let discoverySocket: ReturnType<typeof createSocket> | null = null;
const recentNonces = new Map<string, number>();

function sign(secret: string, value: Record<string, unknown>): string {
  return createHmac('sha256', secret).update(JSON.stringify(value)).digest('base64url');
}

function unsignedProbe(nonce: string, timestamp: number): Omit<DiscoveryProbe, 'signature'> {
  return { type: 'MAGNUS_DISCOVER', nonce, timestamp };
}

function unsignedResponse(
  nonce: string,
  timestamp: number,
  hostname: string,
  fqdn: string,
  port: number,
  version: string,
): Omit<DiscoveryResponse, 'signature'> {
  return { type: 'MAGNUS_AGENT_RESPONSE', nonce, timestamp, hostname, fqdn, port, version };
}

/** Build a signed probe. Exported for protocol regression tests. */
export function createDiscoveryProbe(
  secret: string,
  timestamp = Date.now(),
  nonce = randomBytes(32).toString('base64url'),
): DiscoveryProbe {
  if (secret.length < 32) throw new Error('AGENT_DISCOVERY_SECRET must contain at least 32 characters');
  const unsigned = unsignedProbe(nonce, timestamp);
  return { ...unsigned, signature: sign(secret, unsigned) };
}

/** Verify freshness and authenticity before disclosing agent identity. */
export function verifyDiscoveryProbe(
  value: unknown,
  secret: string,
  now = Date.now(),
): value is DiscoveryProbe {
  if (!value || typeof value !== 'object' || secret.length < 32) return false;
  const probe = value as Partial<DiscoveryProbe>;
  if (
    probe.type !== 'MAGNUS_DISCOVER'
    || typeof probe.nonce !== 'string'
    || !NONCE_PATTERN.test(probe.nonce)
    || typeof probe.timestamp !== 'number'
    || !Number.isSafeInteger(probe.timestamp)
    || Math.abs(now - probe.timestamp) > DISCOVERY_SKEW_MS
    || typeof probe.signature !== 'string'
    || !SIGNATURE_PATTERN.test(probe.signature)
  ) return false;
  return constantTimeEqual(probe.signature, sign(secret, unsignedProbe(probe.nonce, probe.timestamp)));
}

/** Build the nonce-bound signed response expected by the Control API. */
export function createDiscoveryResponse(options: {
  secret: string;
  nonce: string;
  timestamp?: number;
  hostname: string;
  fqdn: string;
  port: number;
  version: string;
}): DiscoveryResponse {
  if (options.secret.length < 32) throw new Error('AGENT_DISCOVERY_SECRET must contain at least 32 characters');
  if (!NONCE_PATTERN.test(options.nonce)) throw new Error('Discovery nonce is malformed');
  for (const value of [options.hostname, options.fqdn, options.version]) {
    if (!value || value.length > 253 || /[\r\n]/.test(value)) throw new Error('Discovery identity is malformed');
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error('Discovery port is invalid');
  }
  const timestamp = options.timestamp ?? Date.now();
  const unsigned = unsignedResponse(
    options.nonce,
    timestamp,
    options.hostname,
    options.fqdn,
    options.port,
    options.version,
  );
  return { ...unsigned, signature: sign(options.secret, unsigned) };
}

function consumeFreshNonce(nonce: string, now: number): boolean {
  for (const [candidate, expiresAt] of recentNonces) {
    if (expiresAt < now) recentNonces.delete(candidate);
  }
  if (recentNonces.has(nonce)) return false;
  recentNonces.set(nonce, now + DISCOVERY_SKEW_MS);
  while (recentNonces.size > MAX_RECENT_NONCES) {
    const oldest = recentNonces.keys().next().value as string | undefined;
    if (!oldest) break;
    recentNonces.delete(oldest);
  }
  return true;
}

/** Stop the UDP discovery listener. */
export function stopDiscoveryListener(): void {
  if (discoverySocket) {
    discoverySocket.close();
    discoverySocket = null;
    recentNonces.clear();
    logger.info('Discovery listener stopped');
  }
}

/** Start the explicitly enabled, authenticated UDP discovery listener. */
export function startDiscoveryListener(): void {
  if (!ENABLE_AGENT_DISCOVERY) {
    logger.info('Discovery listener disabled');
    return;
  }
  if (AGENT_DISCOVERY_SECRET.length < 32) {
    throw new Error('AGENT_DISCOVERY_SECRET must contain at least 32 characters when discovery is enabled');
  }
  if (!isIPv4(AGENT_DISCOVERY_BIND_ADDRESS) || AGENT_DISCOVERY_BIND_ADDRESS === '0.0.0.0') {
    throw new Error('AGENT_DISCOVERY_BIND_ADDRESS must be an explicit IPv4 interface address');
  }

  const agentPort = Number(process.env['NODE_MANAGER_PORT'] ?? 4100);
  const socket = createSocket({ type: 'udp4', reuseAddr: true });
  discoverySocket = socket;

  socket.on('message', (msg, rinfo) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.toString('utf8')) as unknown;
    } catch {
      return;
    }
    const now = Date.now();
    if (!verifyDiscoveryProbe(parsed, AGENT_DISCOVERY_SECRET, now)) return;
    if (!consumeFreshNonce(parsed.nonce, now)) return;

    const fqdn = getFqdn();
    const response = createDiscoveryResponse({
      secret: AGENT_DISCOVERY_SECRET,
      nonce: parsed.nonce,
      hostname: fqdn,
      fqdn,
      port: agentPort,
      version: AGENT_VERSION,
    });
    const buffer = Buffer.from(JSON.stringify(response));
    socket.send(buffer, 0, buffer.length, rinfo.port, rinfo.address, (error) => {
      if (error) logger.warn('Discovery: Failed to send response', { error: error.message });
    });
  });

  socket.on('error', (error) => {
    logger.warn('Discovery: Listener error', { error: error.message });
  });

  socket.bind(DISCOVERY_PORT, AGENT_DISCOVERY_BIND_ADDRESS, () => {
    logger.info('Authenticated discovery listener active', {
      udpPort: DISCOVERY_PORT,
      bindAddress: AGENT_DISCOVERY_BIND_ADDRESS,
    });
  });
}
