import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

const ENVELOPE_PREFIX = 'magnus-webhook:v1';
const MAX_REDIRECTS = 0;
const MAX_RESPONSE_BYTES = 2_048;

type CredentialField = 'secret' | 'headers' | 'url';
export type WebhookLookup = (hostname: string) => Promise<readonly { address: string; family: number }[]>;

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedAddresses.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blockedAddresses.addSubnet(network, prefix, 'ipv6');

function encryptionKey(raw = process.env['WEBHOOK_ENCRYPTION_KEY']): Buffer {
  if (!raw || Buffer.byteLength(raw, 'utf8') < 32) {
    throw new Error('WEBHOOK_ENCRYPTION_KEY must be a dedicated secret of at least 32 bytes');
  }
  return createHash('sha256')
    .update('magnus:webhook-credential-store:v1\0')
    .update(raw, 'utf8')
    .digest();
}

function aad(endpointId: string, field: CredentialField): Buffer {
  if (!endpointId) throw new Error('Webhook endpoint ID is required for credential encryption');
  return Buffer.from(`${ENVELOPE_PREFIX}\0${endpointId}\0${field}`, 'utf8');
}

export function isEncryptedWebhookCredential(value: string): boolean {
  return value.startsWith(`${ENVELOPE_PREFIX}:`);
}

export function encryptWebhookCredential(
  value: string,
  endpointId: string,
  field: CredentialField,
  keyMaterial?: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(keyMaterial), iv);
  cipher.setAAD(aad(endpointId, field));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_PREFIX}:${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

export function decryptWebhookCredential(
  envelope: string,
  endpointId: string,
  field: CredentialField,
  keyMaterial?: string,
): string {
  if (!isEncryptedWebhookCredential(envelope)) {
    throw new Error(`Webhook ${field} is not encrypted; run the webhook credential migration`);
  }
  const parts = envelope.split(':');
  if (parts.length !== 5 || parts[0] !== 'magnus-webhook' || parts[1] !== 'v1') {
    throw new Error(`Webhook ${field} has a malformed encrypted envelope`);
  }
  const iv = Buffer.from(parts[2] ?? '', 'base64url');
  const tag = Buffer.from(parts[3] ?? '', 'base64url');
  const ciphertext = Buffer.from(parts[4] ?? '', 'base64url');
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error(`Webhook ${field} has a malformed encrypted envelope`);
  }
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(keyMaterial), iv);
  decipher.setAAD(aad(endpointId, field));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function canonicalOrigin(url: URL): string {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  return `https://${hostname}${url.port ? `:${url.port}` : ''}`;
}

function allowedOrigins(raw = process.env['WEBHOOK_ALLOWED_ORIGINS'] ?? ''): Set<string> {
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  return new Set(values.map((value) => {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || (url.pathname !== '/' && url.pathname !== '') || isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0
    ) {
      throw new Error('WEBHOOK_ALLOWED_ORIGINS must contain exact HTTPS DNS origins');
    }
    return canonicalOrigin(url);
  }));
}

function isPublicAddress(address: string, family: number): boolean {
  if (family === 4) return !blockedAddresses.check(address, 'ipv4');
  if (family !== 6 || blockedAddresses.check(address, 'ipv6')) return false;
  const first = Number.parseInt(address.split(':', 1)[0] ?? '', 16);
  return Number.isFinite(first) && first >= 0x2000 && first <= 0x3fff;
}

const defaultLookup: WebhookLookup = async (hostname) =>
  dns.lookup(hostname, { all: true, verbatim: true });

/** Opt-in exact address pins for enrolled tailnet receivers. This never grants
 * access to arbitrary private, loopback or metadata addresses. DNS must still
 * match every configured pin and the transport uses that validated answer. */
function tailnetPins(origin: string): Set<string> | undefined {
  const raw = process.env['WEBHOOK_TAILNET_TARGETS_JSON'];
  if (!raw) return undefined;
  const entries: unknown = JSON.parse(raw);
  if (!entries || typeof entries !== 'object' || Array.isArray(entries) || Object.keys(entries).length > 16)
    throw new Error('Invalid webhook tailnet target registry');
  const tailnet = new BlockList();
  tailnet.addSubnet('100.64.0.0', 10, 'ipv4');
  for (const [key, pins] of Object.entries(entries)) {
    if (allowedOrigins(key).size !== 1 || canonicalOrigin(new URL(key)) !== key || !Array.isArray(pins) || pins.length < 1 || pins.length > 8 ||
      pins.some(ip => typeof ip !== 'string' || isIP(ip) !== 4 || !tailnet.check(ip, 'ipv4')))
      throw new Error('Tailnet webhooks require exact HTTPS origins and tailnet IPv4 pins');
  }
  const pins = (entries as Record<string, string[]>)[origin];
  return pins ? new Set(pins) : undefined;
}

export interface ResolvedWebhookTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

export type WebhookTransport = (
  target: ResolvedWebhookTarget,
  init: { headers: Record<string, string>; body: string; timeoutMs: number },
) => Promise<{ ok: boolean; status: number; responseBody: string }>;

export function createPinnedWebhookLookup(target: ResolvedWebhookTarget): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: target.address, family: target.family }]);
      return;
    }
    callback(null, target.address, target.family);
  };
}

async function resolveWebhookTarget(
  rawUrl: string,
  options: { lookup?: WebhookLookup; allowedOriginsRaw?: string } = {},
): Promise<ResolvedWebhookTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Webhook target must be a valid URL');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (
    url.protocol !== 'https:' || url.username || url.password || url.hash
    || !hostname || isIP(hostname) !== 0
    || hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname === 'metadata.google.internal' || hostname === 'instance-data'
  ) {
    throw new Error('Webhook target must be an approved HTTPS DNS endpoint');
  }
  url.hostname = hostname;
  const allowlist = allowedOrigins(options.allowedOriginsRaw);
  if (!allowlist.has(canonicalOrigin(url))) {
    throw new Error('Webhook target origin is not allowlisted');
  }
  const pins = tailnetPins(canonicalOrigin(url));
  let addresses: readonly { address: string; family: number }[];
  try {
    addresses = await (options.lookup ?? defaultLookup)(hostname);
  } catch {
    throw new Error('Webhook target DNS resolution failed');
  }
  if (
    addresses.length === 0
    || addresses.some(({ address, family }) => (family !== 4 && family !== 6) ||
      (pins ? family !== 4 || !pins.has(address) : !isPublicAddress(address, family)))
  ) {
    throw new Error('Webhook target resolves to a non-public address');
  }
  const selected = addresses[0];
  if (!selected || (selected.family !== 4 && selected.family !== 6)) {
    throw new Error('Webhook target DNS resolution returned an unsupported address');
  }
  return { url, address: selected.address, family: selected.family };
}

export async function validateWebhookTarget(
  rawUrl: string,
  options: { lookup?: WebhookLookup; allowedOriginsRaw?: string } = {},
): Promise<URL> {
  return (await resolveWebhookTarget(rawUrl, options)).url;
}

const pinnedHttpsTransport: WebhookTransport = async (target, init) =>
  new Promise((resolvePromise, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    const finish = (status: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      const captured = Buffer.concat(chunks).toString('utf8');
      resolvePromise({
        ok: status >= 200 && status < 300,
        status,
        responseBody: truncated ? `${captured}...` : captured,
      });
    };
    const request = httpsRequest(target.url, {
      method: 'POST',
      headers: init.headers,
      servername: target.url.hostname,
      family: target.family,
      lookup: createPinnedWebhookLookup(target),
      agent: false,
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        response.destroy();
        settled = true;
        clearTimeout(deadline);
        reject(new Error(`Webhook redirects are rejected (limit ${MAX_REDIRECTS})`));
        return;
      }
      response.on('data', (rawChunk: Buffer | string) => {
        if (settled) return;
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        const remaining = MAX_RESPONSE_BYTES - bytes;
        if (remaining > 0) {
          chunks.push(chunk.subarray(0, remaining));
          bytes += Math.min(chunk.length, remaining);
        }
        if (chunk.length > remaining) {
          truncated = true;
          response.destroy();
          finish(status);
        }
      });
      response.on('end', () => finish(status));
      response.on('error', (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(deadline);
          reject(error);
        }
      });
    });
    const deadline = setTimeout(() => request.destroy(new Error('Webhook request timed out')), init.timeoutMs);
    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(error);
    });
    request.end(init.body);
  });

export async function postWebhook(
  rawUrl: string,
  init: { headers: Record<string, string>; body: string; timeoutMs: number },
  options: { lookup?: WebhookLookup; allowedOriginsRaw?: string; transport?: WebhookTransport } = {},
): Promise<{ ok: boolean; status: number; responseBody: string }> {
  const target = await resolveWebhookTarget(rawUrl, options);
  const result = await (options.transport ?? pinnedHttpsTransport)(target, init);
  if (result.status >= 300 && result.status < 400) {
    throw new Error(`Webhook redirects are rejected (limit ${MAX_REDIRECTS})`);
  }
  const responseBytes = Buffer.from(result.responseBody, 'utf8');
  if (responseBytes.length <= MAX_RESPONSE_BYTES) return result;
  return {
    ...result,
    responseBody: `${responseBytes.subarray(0, MAX_RESPONSE_BYTES).toString('utf8')}...`,
  };
}
