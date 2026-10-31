import { isIP } from 'node:net';

/** Strip IPv6-mapped IPv4 prefix and normalize empty values. */
export function normalizeIpAddress(rawIp: string | null | undefined): string {
  if (!rawIp) return '';
  const trimmed = rawIp.trim();
  return trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
}

/** Check if an IP is loopback, unspecified, or otherwise unroutable. */
export function isLoopbackOrUnroutableIp(ipAddress: string): boolean {
  const ip = normalizeIpAddress(ipAddress);
  if (!ip) return true;
  if (ip === '::1' || ip === '::' || ip === '0.0.0.0') return true;
  if (ip.startsWith('127.')) return true;
  return false;
}

/** Check if an IP is a valid, routable node address. */
export function isUsableNodeIp(ipAddress: string): boolean {
  const ip = normalizeIpAddress(ipAddress);
  return isIP(ip) !== 0 && !isLoopbackOrUnroutableIp(ip);
}
