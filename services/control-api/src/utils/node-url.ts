import { normalizeIpAddress, isLoopbackOrUnroutableIp } from './ip.js';
import { isIP } from 'node:net';
import { connect, type ConnectionOptions, type TLSSocket } from 'node:tls';

/**
 * Build the base URL for a node-manager agent.
 *
 * When TLS_CERT_PATH and TLS_KEY_PATH are configured, agents are assumed to
 * run behind HTTPS. Otherwise falls back to plain HTTP.
 */
export function getNodeBaseUrl(ipAddress: string, port: number): string {
  const useTls = process.env['TLS_CERT_PATH'] && process.env['TLS_KEY_PATH'];
  const protocol = useTls ? 'https' : 'http';
  const host = ipAddress.includes(':') && !ipAddress.startsWith('[') ? `[${ipAddress}]` : ipAddress;
  return `${protocol}://${host}:${port}`;
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Derive the certificate hostname an agent should advertise from its reported
 * FQDN, or from its OS hostname and the operator-configured TLS suffix. The heartbeat handler
 * still resolves this name and requires the resolved address to appear in the
 * authenticated agent's network/caller evidence before persisting it.
 */
export function deriveAgentCertificateHostname(reportedFqdn: string | null | undefined, configuredSuffix: string | null | undefined): string | null {
  const reported = reportedFqdn?.trim().toLowerCase().replace(/\.$/, '') ?? '';
  const suffix =
    configuredSuffix
      ?.trim()
      .toLowerCase()
      .replace(/^\.+|\.+$/g, '') ?? '';
  if (!reported || isIP(reported) !== 0 || reported.length > 253 || !reported.split('.').every((label) => DNS_LABEL.test(label))) return null;
  // A fresh agent already reports its certificate's FQDN. Requiring a suffix here
  // replaces that name with an IP address, which cannot verify a DNS certificate.
  // DNS must still match this authenticated heartbeat before the name is used.
  if (!suffix) return reported.includes('.') && isIP(reported) === 0 ? reported : null;
  if (!suffix.includes('.')) return null;

  const suffixLabels = suffix.split('.');
  if (!suffixLabels.every((label) => DNS_LABEL.test(label))) return null;

  if (reported.endsWith(`.${suffix}`)) return reported;
  const shortName = reported.split('.')[0] ?? '';
  if (!DNS_LABEL.test(shortName)) return null;

  const hostname = `${shortName}.${suffix}`;
  return hostname.length <= 253 ? hostname : null;
}

/** Accept the derived certificate name only when DNS points back to this heartbeat. */
export function verifyAgentCertificateHostname(certificateHostname: string | null, resolvedAddress: string | null, heartbeatAddresses: string[]): string | null {
  if (!certificateHostname || !resolvedAddress) return null;
  const resolved = normalizeIpAddress(resolvedAddress);
  const observed = new Set(heartbeatAddresses.map((value) => normalizeIpAddress(value)));
  return resolved && observed.has(resolved) ? certificateHostname : null;
}

/** Verify the declared DNS identity against the listener before selecting it for callbacks.
 * Connect only to the address already bound to this heartbeat. No credential or HTTP request is sent.
 */
export function verifyAgentTlsHostname(hostname: string, address: string, port: number,
  options: { ca?: ConnectionOptions['ca']; timeoutMs?: number } = {}): Promise<boolean> {
  if (!hostname || isIP(address) === 0 || !Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(false);
  return new Promise(resolve => {
    let complete = false;
    let socket: TLSSocket;
    try {
      socket = connect({ host: address, port, servername: hostname, rejectUnauthorized: true,
        ...(options.ca ? { ca: options.ca } : {}) });
    } catch { resolve(false); return; }
    const timer = setTimeout(() => finish(false), options.timeoutMs ?? 2000);
    function finish(verified: boolean) {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(verified);
    }
    socket.once('secureConnect', () => finish(socket.authorized));
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

/** Repair a formerly selected DNS endpoint too, so an IP-only certificate can recover. */
export function repairAgentAddress(current: string, verifiedHostname: string | null, preferredIp: string | null, rejectedHostname: string | null): string | null {
  return verifiedHostname ?? (isLoopbackOrUnroutableIp(current) || (rejectedHostname !== null && current === rejectedHostname) ? preferredIp : null);
}

/** Keep inventory hostname aligned with the endpoint identity actually verified by TLS. */
export function selectAgentEndpointHostname(
  verifiedCertificateHostname: string | null | undefined,
  reportedFqdn: string,
  existingHostname?: string | null,
  existingEndpoint?: string | null,
): string {
  const verified = verifiedCertificateHostname?.trim().toLowerCase();
  if (verified) return verified;

  const existing = existingHostname?.trim().toLowerCase();
  const endpoint = existingEndpoint?.trim().toLowerCase();
  if (existing && endpoint && existing === endpoint && isIP(existing) === 0) return existing;
  return reportedFqdn.trim().toLowerCase();
}
