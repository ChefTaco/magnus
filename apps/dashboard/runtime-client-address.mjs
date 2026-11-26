import { BlockList, isIP } from 'node:net';

/**
 * Client addresses behind an optional trusted reverse proxy.
 *
 * `server-tls.mjs` is the console's edge: it drops every caller-supplied forwarding header and
 * rebuilds `X-Real-IP` from what it trusts. Without `DASHBOARD_TRUSTED_PROXIES` that is the socket
 * peer. With it, a request whose peer is a listed proxy is attributed to the right-most
 * `X-Forwarded-For` entry that is not itself a listed proxy, so login throttling and the
 * authentication audit see the real client instead of one shared proxy address.
 */

/** `::ffff:192.0.2.1` → `192.0.2.1`; anything that is not an IP address → null. */
export function normalizeAddress(value) {
  const trimmed = String(value ?? '').trim().replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
  const address = mapped ? mapped[1] : trimmed;
  return isIP(address) ? address : null;
}

/**
 * Parses `DASHBOARD_TRUSTED_PROXIES` (comma-separated addresses or CIDR ranges).
 * @param {string | undefined} raw
 * @returns {{ list: BlockList | null, errors: string[] }}
 */
export function parseTrustedProxies(raw) {
  const value = raw?.trim();
  if (!value) return { list: null, errors: [] };
  const list = new BlockList();
  const errors = [];
  for (const entry of value.split(',').map((item) => item.trim()).filter(Boolean)) {
    const [base, prefix, extra] = entry.split('/');
    const address = normalizeAddress(base);
    const family = address && isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (!address || extra !== undefined) { errors.push(`DASHBOARD_TRUSTED_PROXIES entry ${JSON.stringify(entry)} is not an address or CIDR range`); continue; }
    if (prefix === undefined) { list.addAddress(address, family); continue; }
    const bits = Number(prefix);
    if (!/^\d{1,3}$/.test(prefix) || bits > (family === 'ipv6' ? 128 : 32)) { errors.push(`DASHBOARD_TRUSTED_PROXIES entry ${JSON.stringify(entry)} has an invalid prefix`); continue; }
    list.addSubnet(address, bits, family);
  }
  return { list, errors };
}

function trusted(list, address) {
  return Boolean(list && address && list.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4'));
}

/**
 * The address a request is attributed to.
 * @param {string | undefined} peer the socket's remote address
 * @param {string | string[] | undefined} forwardedFor the incoming X-Forwarded-For header(s)
 * @param {BlockList | null} list trusted proxies
 */
export function resolveClientAddress(peer, forwardedFor, list) {
  const socketAddress = normalizeAddress(peer);
  if (!socketAddress) return 'unverified';
  if (!trusted(list, socketAddress)) return socketAddress;
  const chain = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor ?? '')
    .split(',').map((item) => item.trim()).filter(Boolean);
  for (let index = chain.length - 1; index >= 0; index--) {
    const hop = normalizeAddress(chain[index]);
    // A malformed hop ends the chain we can trust: attribute to the last good proxy.
    if (!hop) return socketAddress;
    if (!trusted(list, hop)) return hop;
  }
  return socketAddress;
}
