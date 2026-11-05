import { createHash } from 'node:crypto';

export const NATIVE_COMPLETION_REGISTRY = {
  version: 1,
  descriptors: [
    { id: 'hiveskills-sync', method: 'POST', pathMatcher: { kind: 'exact', path: '/hiveskills/sync' },
      completionMode: 'buffered-synchronous-http', timeoutCeilingSeconds: 120, resourceClassifier: 'node-skill-catalog' },
    { id: 'security-response', method: 'POST', pathMatcher: { kind: 'exact', path: '/security-response' },
      completionMode: 'buffered-synchronous-http', timeoutCeilingSeconds: 120, resourceClassifier: 'node-filesystem' },
    { id: 'file-write', method: 'POST', pathMatcher: { kind: 'exact', path: '/files/write' },
      completionMode: 'buffered-synchronous-http', timeoutCeilingSeconds: 3600, resourceClassifier: 'node-filesystem' },
    { id: 'skill-install', method: 'POST', pathMatcher: { kind: 'exact', path: '/skills/install' },
      completionMode: 'buffered-synchronous-http', timeoutCeilingSeconds: 3600, resourceClassifier: 'node-skill-catalog' },
    { id: 'skill-delete', method: 'DELETE',
      pathMatcher: { kind: 'single-segment', prefix: '/skills/', segmentPattern: '^[a-zA-Z0-9._-]+$' },
      completionMode: 'buffered-synchronous-http', timeoutCeilingSeconds: 3600, resourceClassifier: 'node-skill-catalog' },
    { id: 'managed-cron-stage', method: 'POST', pathMatcher: { kind: 'exact', path: '/cron/managed-sync' },
      completionMode: 'buffered-synchronous-http', timeoutCeilingSeconds: 3600, resourceClassifier: 'node-scheduler' },
    { id: 'managed-cron-activate', method: 'POST', pathMatcher: { kind: 'exact', path: '/cron/managed-activate' },
      completionMode: 'buffered-synchronous-http', timeoutCeilingSeconds: 3600, resourceClassifier: 'node-scheduler' },
    { id: 'managed-cron-revoke', method: 'POST', pathMatcher: { kind: 'exact', path: '/cron/managed-revoke' },
      completionMode: 'buffered-synchronous-http', timeoutCeilingSeconds: 3600, resourceClassifier: 'node-scheduler' },
    { id: 'cron-delete', method: 'DELETE',
      pathMatcher: { kind: 'single-segment', prefix: '/cron/', segmentPattern: '^[a-zA-Z0-9._-]+$' },
      completionMode: 'buffered-synchronous-http', timeoutCeilingSeconds: 3600, resourceClassifier: 'node-scheduler' },
    { id: 'ardent-action', method: 'POST', pathMatcher: { kind: 'exact', path: '/ardent/action' },
      completionMode: 'buffered-synchronous-http', timeoutCeilingSeconds: 900, resourceClassifier: 'node-ardent' },
    { id: 'agent-self-upgrade', method: 'POST', pathMatcher: { kind: 'exact', path: '/agent-upgrade' },
      completionMode: 'buffered-synchronous-http', timeoutCeilingSeconds: 900, resourceClassifier: 'node-filesystem' },
  ],
} as const;

export type NativeCompletionDescriptor = (typeof NATIVE_COMPLETION_REGISTRY.descriptors)[number];
export const NATIVE_COMPLETION_REGISTRY_SHA256 = createHash('sha256')
  .update(JSON.stringify(NATIVE_COMPLETION_REGISTRY)).digest('hex');

function matchesPath(descriptor: NativeCompletionDescriptor, path: string): boolean {
  const matcher = descriptor.pathMatcher;
  if (matcher.kind === 'exact') return path === matcher.path;
  if (!path.startsWith(matcher.prefix)) return false;
  const segment = path.slice(matcher.prefix.length);
  return segment.length > 0 && !segment.includes('/') && new RegExp(matcher.segmentPattern).test(segment);
}

export function nativeCompletionDescriptor(method: string, path: string): NativeCompletionDescriptor | undefined {
  return NATIVE_COMPLETION_REGISTRY.descriptors.find(descriptor => descriptor.method === method && matchesPath(descriptor, path));
}

export function nativeCompletionResourceKey(descriptor: NativeCompletionDescriptor, nodeId: string): string {
  if (!nodeId || !['node-filesystem', 'node-skill-catalog', 'node-scheduler', 'node-ardent'].includes(descriptor.resourceClassifier))
    throw new Error('Native completion resource cannot be classified');
  return descriptor.resourceClassifier === 'node-ardent' ? `node:${nodeId}:ardent` : `node:${nodeId}`;
}

/** Preserve settlement of pre-extraction leases without granting the new response boundary retroactively. */
export function knownNativeCompletionIdentity(version: number | null, sha256: string | null, descriptorId: string | null): boolean {
  if (version !== 1 || !descriptorId) return false;
  const descriptor = NATIVE_COMPLETION_REGISTRY.descriptors.find(item => item.id === descriptorId);
  if (!descriptor) return false;
  return sha256 === NATIVE_COMPLETION_REGISTRY_SHA256 || (descriptorId !== 'hiveskills-sync' && sha256 === 'e1303b169387f536c257e686eb95a29c1ff9b09e26fc38ac0d71d6c0daf9eb55') || (descriptorId !== 'security-response' && descriptorId !== 'hiveskills-sync'
    && sha256 === 'b0f05a1eac40dba262ec5ff0cc0de8d2b7c9f119a6a2d7ed3a00d94dcb6b1d3d');
}
