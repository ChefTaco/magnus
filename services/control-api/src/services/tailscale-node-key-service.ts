export const TAILSCALE_RENEWAL_WARNING_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TailscaleNodeKeyPosture {
  status: string;
  backendState: string;
  dnsName: string | null;
  online: boolean | null;
  keyExpiry: string | null;
  daysRemaining: number | null;
  expiryEnabled: boolean;
  expired: boolean;
  requiresRenewal: boolean;
}

export interface TailscaleNodeKeyInventoryItem {
  id: string;
  name: string;
  hostname: string;
  nodeStatus: string;
  lastHeartbeatAt: Date | string | null;
  observedAt: Date | string | null;
  tailscale: TailscaleNodeKeyPosture | null;
}

interface SerializedService {
  name?: unknown;
  status?: unknown;
  details?: unknown;
}

function parseDetails(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function parseTailscaleNodeKeyPosture(
  serializedServices: string,
  nowMs = Date.now(),
  warningDays = TAILSCALE_RENEWAL_WARNING_DAYS,
): TailscaleNodeKeyPosture | null {
  let services: SerializedService[];
  try {
    const parsed = JSON.parse(serializedServices) as unknown;
    if (!Array.isArray(parsed)) return null;
    services = parsed as SerializedService[];
  } catch {
    return null;
  }

  const service = services.find((item) => item?.name === 'tailscale-node-key');
  const details = parseDetails(service?.details);
  if (!service || typeof service.status !== 'string' || !details) return null;

  const backendState = details['backendState'];
  const expiryEnabled = details['expiryEnabled'];
  const rawExpiry = details['keyExpiry'];
  if (typeof backendState !== 'string' || typeof expiryEnabled !== 'boolean') return null;
  if (!(rawExpiry === null || typeof rawExpiry === 'string')) return null;

  const dnsName = typeof details['dnsName'] === 'string' ? details['dnsName'] : null;
  const online = typeof details['online'] === 'boolean' ? details['online'] : null;
  const expiryMs = typeof rawExpiry === 'string' ? Date.parse(rawExpiry) : Number.NaN;
  const hasValidExpiry = Number.isFinite(expiryMs);
  if (expiryEnabled && !hasValidExpiry) return null;
  const daysRemaining = expiryEnabled && hasValidExpiry
    ? Math.ceil((expiryMs - nowMs) / DAY_MS)
    : null;
  const expired = expiryEnabled && hasValidExpiry && expiryMs <= nowMs;
  const requiresRenewal = expired || (
    expiryEnabled && daysRemaining !== null && daysRemaining <= warningDays
  );

  return {
    status: service.status,
    backendState,
    dnsName,
    online,
    keyExpiry: hasValidExpiry ? rawExpiry : null,
    daysRemaining,
    expiryEnabled,
    expired,
    requiresRenewal,
  };
}

export function summarizeTailscaleNodeKeys(
  nodes: TailscaleNodeKeyInventoryItem[],
  warningDays = TAILSCALE_RENEWAL_WARNING_DAYS,
): {
  total: number;
  reporting: number;
  expiryEnabled: number;
  expiringSoon: number;
  expired: number;
  warningDays: number;
  nodes: TailscaleNodeKeyInventoryItem[];
} {
  return {
    total: nodes.length,
    reporting: nodes.filter((node) => node.tailscale !== null).length,
    expiryEnabled: nodes.filter((node) => node.tailscale?.expiryEnabled).length,
    expiringSoon: nodes.filter((node) => node.tailscale?.requiresRenewal && !node.tailscale.expired).length,
    expired: nodes.filter((node) => node.tailscale?.expired).length,
    warningDays,
    nodes,
  };
}
