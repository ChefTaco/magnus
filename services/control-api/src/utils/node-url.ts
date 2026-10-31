import { normalizeIpAddress } from './ip.js';
import { isIP } from 'node:net';

/**
 * Build the base URL for a node-manager agent.
 *
 * When TLS_CERT_PATH and TLS_KEY_PATH are configured, agents are assumed to
 * run behind HTTPS. Otherwise falls back to plain HTTP.
 */
export function getNodeBaseUrl(ipAddress: string, port: number): string {
  const useTls = process.env['TLS_CERT_PATH'] && process.env['TLS_KEY_PATH'];
  const protocol = useTls ? 'https' : 'http';
  return `${protocol}://${ipAddress}:${port}`;
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Derive the certificate hostname an agent should advertise from its reported
 * OS hostname and the operator-configured TLS suffix. The heartbeat handler
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
  if (!reported || !suffix || !suffix.includes('.')) return null;

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
