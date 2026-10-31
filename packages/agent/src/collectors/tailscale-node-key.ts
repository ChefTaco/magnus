import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ServiceInfo } from '../types/index.js';

export const TAILSCALE_EXPIRY_WARNING_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

interface TailscaleStatus {
  BackendState?: unknown;
  Self?: {
    DNSName?: unknown;
    KeyExpiry?: unknown;
    Online?: unknown;
    TailscaleIPs?: unknown;
  };
}

function service(status: ServiceInfo['status'], details: Record<string, unknown>): ServiceInfo {
  return {
    name: 'tailscale-node-key',
    status,
    pid: null,
    memoryBytes: null,
    cpuPercent: null,
    details: JSON.stringify(details),
  };
}

export function parseTailscaleNodeKeyStatus(
  raw: string,
  nowMs = Date.now(),
  warningDays = TAILSCALE_EXPIRY_WARNING_DAYS,
): ServiceInfo {
  let parsed: TailscaleStatus;
  try {
    parsed = JSON.parse(raw) as TailscaleStatus;
  } catch {
    return service('unknown', { reason: 'invalid_status_json', warningDays });
  }

  const backendState = typeof parsed.BackendState === 'string' ? parsed.BackendState : 'Unknown';
  const keyExpiry = typeof parsed.Self?.KeyExpiry === 'string' && parsed.Self.KeyExpiry
    ? parsed.Self.KeyExpiry
    : null;
  const dnsName = typeof parsed.Self?.DNSName === 'string'
    ? parsed.Self.DNSName.replace(/\.$/u, '')
    : null;
  const online = typeof parsed.Self?.Online === 'boolean' ? parsed.Self.Online : null;
  const tailscaleIps = Array.isArray(parsed.Self?.TailscaleIPs)
    ? parsed.Self.TailscaleIPs.filter((value): value is string => typeof value === 'string').slice(0, 2)
    : [];

  if (!keyExpiry) {
    return service(backendState === 'Running' ? 'active' : 'unknown', {
      backendState,
      dnsName,
      online,
      tailscaleIps,
      keyExpiry: null,
      daysRemaining: null,
      warningDays,
      expiryEnabled: false,
    });
  }

  const expiryMs = Date.parse(keyExpiry);
  if (!Number.isFinite(expiryMs)) {
    return service('unknown', {
      backendState,
      dnsName,
      online,
      keyExpiry,
      warningDays,
      reason: 'invalid_key_expiry',
    });
  }

  const daysRemaining = Math.ceil((expiryMs - nowMs) / DAY_MS);
  const details = {
    backendState,
    dnsName,
    online,
    tailscaleIps,
    keyExpiry,
    daysRemaining,
    warningDays,
    expiryEnabled: true,
  };

  if (backendState === 'NeedsLogin' || expiryMs <= nowMs) return service('failed', details);
  if (backendState !== 'Running') return service('unknown', details);
  if (daysRemaining <= warningDays) return service('inactive', details);
  return service('active', details);
}

function tailscaleBinary(): string {
  const candidates = [
    '/usr/bin/tailscale',
    '/usr/local/bin/tailscale',
    '/var/packages/Tailscale/target/bin/tailscale',
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? 'tailscale';
}

export async function collectTailscaleNodeKey(): Promise<ServiceInfo> {
  return new Promise((resolve) => {
    execFile(
      tailscaleBinary(),
      ['status', '--json'],
      { encoding: 'utf8', timeout: 3_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(service('unknown', {
            reason: 'status_unavailable',
            warningDays: TAILSCALE_EXPIRY_WARNING_DAYS,
          }));
          return;
        }
        resolve(parseTailscaleNodeKeyStatus(stdout));
      },
    );
  });
}
