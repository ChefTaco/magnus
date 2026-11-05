import type { UserRole } from '../types/index.js';

/**
 * What each role may see of values written to hosts and of secret fingerprints.
 * Below ADMIN a response names environment keys but never carries their values,
 * and reports a credential's state but never its fingerprint.
 */

function parseRecord(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function environmentKeys(raw: string): string[] {
  return Object.keys(parseRecord(raw)).sort();
}

/**
 * Apply a non-admin's edit to stored environment values. Such a client only ever
 * saw key names, so a key it left out or left blank means "unchanged", not
 * "delete". Sending back a redacted response therefore cannot wipe a value, and
 * removing a key takes an ADMIN, who can see what is being removed.
 */
export function mergeEnvironmentEdit(existing: string, incoming: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(parseRecord(existing))) {
    if (typeof value === 'string') merged[key] = value;
  }
  for (const [key, value] of Object.entries(incoming)) {
    if (value === '' && key in merged) continue;
    merged[key] = value;
  }
  return merged;
}

const FINGERPRINT_METADATA_KEYS = ['nodeManagerSecretFingerprint'] as const;

/** Node metadata as a JSON string, with secret fingerprints removed below ADMIN. */
export function nodeMetadataForRole(metadata: string, role: UserRole): string {
  if (role === 'ADMIN') return metadata;
  if (!FINGERPRINT_METADATA_KEYS.some((key) => metadata.includes(key))) return metadata;
  const visible = parseRecord(metadata);
  for (const key of FINGERPRINT_METADATA_KEYS) delete visible[key];
  return JSON.stringify(visible);
}

/** A node row for a response: never its token, and metadata fit for the role. */
export function nodeForRole<T extends { token: string; metadata: string }>(node: T, role: UserRole): Omit<T, 'token'> {
  const { token: _token, ...safe } = node;
  return { ...safe, metadata: nodeMetadataForRole(node.metadata, role) };
}

/** A cron job for a response: environment values for ADMIN, key names for everyone. */
export function cronJobForRole<T extends { environment: string }>(job: T, role: UserRole):
  Omit<T, 'environment'> & { environment?: string; environmentKeys: string[] } {
  const { environment, ...rest } = job;
  return {
    ...rest,
    ...(role === 'ADMIN' ? { environment } : {}),
    environmentKeys: environmentKeys(environment),
  };
}

/** A Hermes profile for a response: whether a key is set, and its fingerprint only for ADMIN. */
export function hermesProfileForRole<T extends { apiServerKeyFingerprint?: string | null }>(profile: T, role: UserRole):
  Omit<T, 'apiServerKeyFingerprint'> & { apiServerKeyFingerprint?: string | null; apiServerKeyConfigured: boolean } {
  const { apiServerKeyFingerprint, ...rest } = profile;
  return {
    ...rest,
    ...(role === 'ADMIN' ? { apiServerKeyFingerprint: apiServerKeyFingerprint ?? null } : {}),
    apiServerKeyConfigured: Boolean(apiServerKeyFingerprint),
  };
}
