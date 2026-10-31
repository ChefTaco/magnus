/** Verified TLS options for loopback connections to local Magnus services. */
import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import type { RequestOptions } from 'node:https';

export function verifiedLocalTlsOptions(
  caPath?: string,
  servername?: string,
): Pick<RequestOptions, 'rejectUnauthorized' | 'ca' | 'servername'> {
  const options: Pick<RequestOptions, 'rejectUnauthorized' | 'ca' | 'servername'> = {
    rejectUnauthorized: true,
  };
  const normalizedCaPath = caPath?.trim();
  if (normalizedCaPath) {
    if (!existsSync(normalizedCaPath)) {
      throw new Error(`Configured TLS CA does not exist: ${normalizedCaPath}`);
    }
    options.ca = readFileSync(normalizedCaPath);
  }
  const normalizedServername = servername?.trim();
  if (normalizedServername && isIP(normalizedServername) === 0) {
    options.servername = normalizedServername;
  }
  return options;
}

function controlApiHostname(): string | undefined {
  try {
    return new URL(process.env['CONTROL_API_URL'] ?? '').hostname || undefined;
  } catch {
    return undefined;
  }
}

export function controlHostAgentTlsServername(): string | undefined {
  const configured = (
    process.env['CONTROL_HOST_AGENT_TLS_SERVERNAME'] ?? controlApiHostname()
  )?.trim().toLowerCase();
  return configured && isIP(configured) === 0 ? configured : undefined;
}

export function controlApiLoopbackTlsOptions(): ReturnType<typeof verifiedLocalTlsOptions> {
  return verifiedLocalTlsOptions(
    process.env['CONTROL_API_CA_PATH'],
    process.env['CONTROL_API_TLS_SERVERNAME'] ?? controlApiHostname(),
  );
}

export function controlHostAgentTlsOptions(): ReturnType<typeof verifiedLocalTlsOptions> {
  return verifiedLocalTlsOptions(
    process.env['CONTROL_HOST_AGENT_CA_PATH'] ?? process.env['CONTROL_API_CA_PATH'],
    controlHostAgentTlsServername(),
  );
}
