import { existsSync, readFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { readDashboardEnvironment } from './runtime-environment.mjs';

const DEFAULT_MAX_CONTROL_API_BYTES = 1024 * 1024;

/** @param {Record<string, string | undefined>} env */
export function controlApiTlsOptions(env = process.env) {
  const caPath = readDashboardEnvironment('CONTROL_API_CA_PATH', env);
  if (!caPath) return { rejectUnauthorized: true };
  if (!existsSync(caPath)) {
    throw new Error(`CONTROL_API_CA_PATH does not exist: ${caPath}`);
  }
  return { rejectUnauthorized: true, ca: readFileSync(caPath) };
}

export function controlApiResponseLimit(env = process.env) {
  return readDashboardEnvironment('CONTROL_API_MAX_RESPONSE_BYTES', env) ?? DEFAULT_MAX_CONTROL_API_BYTES;
}

function validPort(value, fallback) {
  const port = value == null ? fallback : Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function validHostname(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 253
    && /^[a-zA-Z0-9._:-]+$/.test(value);
}

export function normalizeHermesInstallations(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const sshPort = validPort(item.sshPort, 22);
    const dashboardPort = validPort(item.dashboardPort, 9119);
    if (typeof item.id !== 'string' || !item.id
      || typeof item.nodeId !== 'string' || !item.nodeId
      || !validHostname(item.hostname) || !sshPort || !dashboardPort) {
      return [];
    }
    return [{ ...item, sshPort, dashboardPort }];
  });
}

export function chooseHermesInstallation(installations, installationId, nodeId, cookieInstallationId) {
  if (installationId) {
    const installation = installations.find((item) => item.id === installationId) ?? null;
    return installation ? { installation, error: null } : { installation: null, error: 'installation_not_found' };
  }
  if (nodeId) {
    const installation = installations.find((item) => item.nodeId === nodeId) ?? null;
    return installation ? { installation, error: null } : { installation: null, error: 'node_installation_not_found' };
  }
  if (cookieInstallationId) {
    const installation = installations.find((item) => item.id === cookieInstallationId) ?? null;
    if (installation) return { installation, error: null };
  }

  const eligible = installations.filter((item) => item.dashboardStatus === 'running' || item.status === 'running');
  if (eligible.length === 1) return { installation: eligible[0], error: null };
  if (eligible.length > 1) return { installation: null, error: 'installation_required' };
  if (installations.length === 1) return { installation: installations[0], error: null };
  if (installations.length > 1) return { installation: null, error: 'installation_required' };
  return { installation: null, error: 'installation_unavailable' };
}

export function websocketOriginAllowed(origin, configuredOrigins) {
  if (!origin || !configuredOrigins) return false;
  const allowed = configuredOrigins.split(',').map((value) => value.trim()).filter(Boolean);
  try {
    const candidate = new URL(origin).origin;
    return allowed.some((value) => new URL(value).origin === candidate);
  } catch {
    return false;
  }
}

export function cookieHeaderAllowed(header, maxBytes = 16 * 1024) {
  return Buffer.byteLength(header ?? '') <= maxBytes;
}

function parseIpv4(value) {
  if (isIP(value) !== 4) return null;
  return value.split('.').reduce((result, part) => (result << 8n) | BigInt(part), 0n);
}

function parseIpv6(value) {
  if (isIP(value) !== 6) return null;
  const plain = value.split('%')[0].toLowerCase();
  const [leftText, rightText] = plain.split('::');
  const expand = (text) => text ? text.split(':').flatMap((part) => {
    if (!part.includes('.')) return [Number.parseInt(part || '0', 16)];
    const ipv4 = parseIpv4(part);
    return ipv4 == null ? [] : [Number((ipv4 >> 16n) & 0xffffn), Number(ipv4 & 0xffffn)];
  }) : [];
  const left = expand(leftText);
  const right = rightText == null ? [] : expand(rightText);
  const groups = rightText == null ? left : [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) return null;
  return groups.reduce((result, group) => (result << 16n) | BigInt(group), 0n);
}

function cidrContains(cidr, address) {
  const [networkText, prefixText] = cidr.trim().split('/');
  const family = isIP(networkText);
  if (!family || family !== isIP(address)) return false;
  const bits = family === 4 ? 32 : 128;
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return false;
  const parse = family === 4 ? parseIpv4 : parseIpv6;
  const network = parse(networkText);
  const candidate = parse(address);
  if (network == null || candidate == null) return false;
  const shift = BigInt(bits - prefix);
  return (network >> shift) === (candidate >> shift);
}

function prohibitedAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    return ['0.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '224.0.0.0/4'].some((cidr) => cidrContains(cidr, address));
  }
  if (family === 6) {
    return address === '::' || address === '::1'
      || ['fe80::/10', 'ff00::/8'].some((cidr) => cidrContains(cidr, address));
  }
  return true;
}

export function hermesSshAllowedCidrs(env = process.env) {
  const configured = env['HERMES_SSH_ALLOWED_CIDRS'];
  const values = (configured ? configured.split(',') : [])
    .map((value) => value.trim()).filter(Boolean);
  if (values.length === 0 || values.some((cidr) => {
    const [address, prefix] = cidr.split('/');
    const bits = isIP(address) === 4 ? 32 : isIP(address) === 6 ? 128 : -1;
    return bits < 0 || !Number.isInteger(Number(prefix)) || Number(prefix) < 0 || Number(prefix) > bits;
  })) {
    throw new Error('HERMES_SSH_ALLOWED_CIDRS must be explicitly configured with valid, narrow IPv4 or IPv6 CIDRs');
  }
  return values;
}

export function hermesSshAddressAllowed(address, cidrs = hermesSshAllowedCidrs()) {
  if (prohibitedAddress(address)) return false;
  return cidrs.some((cidr) => cidrContains(cidr, address));
}

export function hermesSshAuthorizationPath(env = process.env) {
  return readDashboardEnvironment('HERMES_SSH_AUTHORIZATIONS_FILE', env)
    ?? join(/*turbopackIgnore: true*/ process.cwd(), '.magnus', 'hermes-ssh-authorizations.json');
}

export function loadHermesSshAuthorization(installation, options = {}) {
  if (!installation?.id || !installation?.nodeId) {
    throw new Error('Hermes installation must have both installation ID and node ID');
  }
  const file = options.file ?? hermesSshAuthorizationPath(options.env);
  if (!existsSync(/*turbopackIgnore: true*/ file)) throw new Error('Hermes SSH authorization file is not configured');
  let document;
  try { document = JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, 'utf8')); }
  catch { throw new Error('Hermes SSH authorization file is invalid'); }
  const authorization = [1, 2].includes(document?.version)
    ? document.installations?.[installation.id]
    : null;
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const versionTwoKeys = document?.version === 2 && Array.isArray(authorization?.keys)
    ? authorization.keys.filter((key) =>
      key
      && typeof key.fingerprint === 'string'
      && (key.state === 'active'
        || (key.state === 'overlap'
          && typeof key.expiresAt === 'string'
          && Number.isFinite(Date.parse(key.expiresAt))
          && Date.parse(key.expiresAt) > now.getTime()))
    ).map((key) => key.fingerprint)
    : null;
  const hostKeySha256 = versionTwoKeys ?? authorization?.hostKeySha256;
  if (!authorization
    || authorization.nodeId !== installation.nodeId
    || !Array.isArray(authorization.addresses)
    || authorization.addresses.length === 0
    || authorization.addresses.some((address) => !isIP(address) || prohibitedAddress(address))
    || !Array.isArray(hostKeySha256)
    || hostKeySha256.length === 0
    || hostKeySha256.some((fingerprint) => typeof fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint))) {
    throw new Error('Hermes installation is not bound to an approved node, address, and host key');
  }
  return {
    installationId: installation.id,
    nodeId: authorization.nodeId,
    addresses: [...new Set(authorization.addresses)],
    hostKeySha256: [...new Set(hostKeySha256)],
  };
}

/** Read non-secret fleet host-key posture for the operator security page. */
export function readHermesSshTrustInventory(options = {}) {
  const file = options.file ?? hermesSshAuthorizationPath(options.env);
  if (!existsSync(/*turbopackIgnore: true*/ file)) return [];
  const document = JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, 'utf8'));
  if (![1, 2].includes(document?.version) || !document.installations || typeof document.installations !== 'object') {
    throw new Error('Hermes SSH authorization file is invalid');
  }
  const nowMs = options.now instanceof Date
    ? options.now.getTime()
    : new Date(options.now ?? Date.now()).getTime();
  return Object.entries(document.installations).flatMap(([installationId, authorization]) => {
    if (!authorization || typeof authorization !== 'object' || typeof authorization.nodeId !== 'string') return [];
    if (document.version === 1) {
      return [{
        installationId,
        nodeId: authorization.nodeId,
        hostname: authorization.hostname ?? null,
        addresses: Array.isArray(authorization.addresses) ? authorization.addresses : [],
        expectedFingerprints: Array.isArray(authorization.hostKeySha256) ? authorization.hostKeySha256 : [],
        firstSeenAt: document.generatedAt ?? null,
        rotationState: 'legacy',
        overlapExpiresAt: null,
        expiredFingerprints: [],
      }];
    }
    const keys = Array.isArray(authorization.keys) ? authorization.keys : [];
    const active = keys.filter((key) => key?.state === 'active');
    const overlap = keys.filter((key) => key?.state === 'overlap' && Date.parse(key.expiresAt) > nowMs);
    const expired = keys.filter((key) => key?.state === 'overlap' && Date.parse(key.expiresAt) <= nowMs);
    return [{
      installationId,
      nodeId: authorization.nodeId,
      hostname: authorization.hostname ?? null,
      addresses: Array.isArray(authorization.addresses) ? authorization.addresses : [],
      expectedFingerprints: [...new Set([...active, ...overlap].map((key) => key.fingerprint))],
      firstSeenAt: keys.map((key) => key?.firstSeenAt).filter(Boolean).sort()[0] ?? document.generatedAt ?? null,
      rotationState: overlap.length > 0 ? 'overlap' : expired.length > 0 ? 'expired' : 'current',
      overlapExpiresAt: overlap.map((key) => key.expiresAt).sort().at(-1) ?? null,
      expiredFingerprints: expired.map((key) => key.fingerprint),
    }];
  }).sort((a, b) => a.nodeId.localeCompare(b.nodeId));
}

export async function resolveApprovedHermesSshTarget(installation, options = {}) {
  const hostname = installation?.hostname;
  if (!validHostname(hostname)) throw new Error('Hermes SSH target hostname is invalid');
  const authorization = options.authorization ?? loadHermesSshAuthorization(installation, options);
  const resolver = options.resolver ?? ((host) => lookup(host, { all: true, verbatim: true }));
  const records = await resolver(hostname);
  const addresses = [...new Set(records.map((record) => typeof record === 'string' ? record : record.address))];
  if (addresses.length === 0) throw new Error('Hermes SSH target did not resolve to an address');
  const unexpected = addresses.filter((address) => !authorization.addresses.includes(address));
  if (unexpected.length > 0) {
    throw new Error(`Hermes SSH target resolved to unauthorized addresses: ${unexpected.join(', ')}`);
  }
  const address = addresses.find((candidate) => authorization.addresses.includes(candidate));
  if (!address) throw new Error('Hermes SSH target did not resolve to an authorized address');
  return { address, addresses, authorization };
}

/** Resolve only the dashboard listener on the already authenticated SSH node.
 * Inventory is not authority to use that node as a tunnel to another host.
 * No DNS lookup, fallback attempt or arbitrary dashboard URL is permitted.
 */
export function resolveHermesDashboardForwardTarget(installation, approvedTarget) {
  const authorization = approvedTarget?.authorization;
  if (!authorization || authorization.installationId !== installation?.id
    || authorization.nodeId !== installation?.nodeId
    || !isIP(approvedTarget.address) || prohibitedAddress(approvedTarget.address)
    || !authorization.addresses.includes(approvedTarget.address)) {
    throw new Error('Dashboard forwarding requires the approved installation SSH target');
  }
  const port = validPort(installation.dashboardPort, 9119);
  if (!port) throw new Error('Hermes dashboard forwarding port is invalid');
  const host = installation.dashboardHost ?? '127.0.0.1';
  if (['', 'localhost', '127.0.0.1', '0.0.0.0'].includes(host)) return { address: '127.0.0.1', port };
  if (['::', '::1'].includes(host)) return { address: '::1', port };
  if (host === approvedTarget.address) return { address: host, port };
  throw new Error('Hermes dashboard listener is not loopback or the approved SSH destination');
}

export function hermesWebsocketPathAllowed(pathname) {
  return pathname === '/api/console'
    || pathname === '/api/events'
    || pathname === '/api/pty'
    || pathname === '/api/ws'
    || pathname === '/ws';
}

export function rawWebSocketDataByteLength(data) {
  if (typeof data === 'string') return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.length;
  if (Array.isArray(data)) {
    let total = 0;
    for (const item of data) {
      const size = rawWebSocketDataByteLength(item);
      if (size == null || !Number.isSafeInteger(total + size)) return null;
      total += size;
    }
    return total;
  }
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return null;
}

export function createBoundedMessageQueue(maxBytes = 256 * 1024) {
  let bytes = 0;
  const messages = [];
  return {
    push(data, isBinary) {
      const size = rawWebSocketDataByteLength(data);
      if (size == null) return false;
      if (bytes + size > maxBytes) return false;
      messages.push({ data, isBinary, size });
      bytes += size;
      return true;
    },
    flush(send) {
      for (const message of messages) send(message.data, message.isBinary);
      messages.length = 0;
      bytes = 0;
    },
    drain(send, canSend) {
      while (messages.length > 0 && canSend()) {
        const message = messages.shift();
        bytes -= message.size;
        send(message.data, message.isBinary);
      }
      return messages.length === 0;
    },
    get bytes() { return bytes; },
  };
}

export function createWebSocketBackpressureController(options = {}) {
  const highWaterMark = options.highWaterMark ?? 512 * 1024;
  const maxQueueBytes = options.maxQueueBytes ?? 512 * 1024;
  const maxPressureMs = options.maxPressureMs ?? 5_000;
  const now = options.now ?? Date.now;
  const queue = createBoundedMessageQueue(maxQueueBytes);
  let pressureStartedAt = null;
  let totalPressureMs = 0;
  let peakBytes = 0;

  return {
    push(data, isBinary) { return queue.push(data, isBinary); },
    drain(send, getBufferedAmount) {
      let bufferedAmount = Math.max(0, Number(getBufferedAmount()) || 0);
      peakBytes = Math.max(peakBytes, bufferedAmount + queue.bytes);
      if (bufferedAmount > highWaterMark) {
        pressureStartedAt ??= now();
        const durationMs = now() - pressureStartedAt;
        return { pending: queue.bytes > 0, close: durationMs >= maxPressureMs, durationMs, peakBytes };
      }
      if (pressureStartedAt != null) {
        totalPressureMs += now() - pressureStartedAt;
        pressureStartedAt = null;
      }
      const emptied = queue.drain(send, () => {
        bufferedAmount = Math.max(0, Number(getBufferedAmount()) || 0);
        peakBytes = Math.max(peakBytes, bufferedAmount + queue.bytes);
        return bufferedAmount <= highWaterMark;
      });
      if (!emptied) pressureStartedAt ??= now();
      return { pending: !emptied, close: false, durationMs: totalPressureMs, peakBytes };
    },
    snapshot() {
      const activeMs = pressureStartedAt == null ? 0 : now() - pressureStartedAt;
      return { queuedBytes: queue.bytes, durationMs: totalPressureMs + activeMs, peakBytes };
    },
  };
}
