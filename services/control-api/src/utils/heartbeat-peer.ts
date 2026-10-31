import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { normalizeIpAddress } from './ip.js';

/**
 * Read the peer address from the Node adapter before considering proxy
 * metadata. Port 4000 accepts agents directly, so a caller-controlled
 * x-forwarded-for header must not override the authenticated socket peer.
 * The header remains a fallback for adapter-free tests and explicitly
 * forwarded deployments where no socket binding is available.
 */
export function heartbeatPeerAddress(c: Context): string {
  let socketAddress = '';
  try {
    socketAddress = getConnInfo(c).remote.address ?? '';
  } catch { /* adapter-free request */ }

  const forwardedAddress = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
  return normalizeIpAddress(socketAddress || forwardedAddress);
}
