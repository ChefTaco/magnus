export function normalizeProxyTarget(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/\/+$/, '') ?? '';
  return normalized || null;
}

export function proxyTargetHeaders(value: string | null | undefined): Record<string, string> {
  const target = normalizeProxyTarget(value);
  return target ? { 'x-proxy-target': target } : {};
}

export function resolveProxyTarget(
  requestedTarget: string | null | undefined,
  fallbackTarget: string | null | undefined,
): string | null {
  return normalizeProxyTarget(requestedTarget) ?? normalizeProxyTarget(fallbackTarget);
}
