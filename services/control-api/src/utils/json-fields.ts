/**
 * Typed parse/serialize helpers for JSON-encoded Prisma string fields.
 *
 * Magnus deliberately stores these wire-compatible arrays and objects as
 * serialized JSON strings. These helpers centralize the serde logic to avoid scattered
 * `JSON.stringify` / `JSON.parse` casts throughout route files.
 */

/**
 * Parse a JSON-encoded string array from a Prisma field.
 * Falls back to an empty array if the value is null, undefined, or invalid JSON.
 */
export function parseStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value as string[];
  try {
    const parsed = JSON.parse(value as string);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * Serialize a string array to a JSON string for storage in a Prisma field.
 * Accepts undefined for convenience (returns '[]').
 */
export function serializeStringArray(value: string[] | undefined): string {
  return JSON.stringify(value ?? []);
}

/**
 * Parse a JSON-encoded generic array from a Prisma field.
 * Falls back to the provided default if null, undefined, or invalid JSON.
 */
export function parseJsonArray<T = unknown>(value: unknown, fallback: T[] = []): T[] {
  if (!value) return fallback;
  if (Array.isArray(value)) return value as T[];
  try {
    const parsed = JSON.parse(value as string);
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Parse a JSON-encoded `Record<string, string>` from a Prisma field.
 * Falls back to an empty object if null, undefined, or invalid JSON.
 */
export function parseStringRecord(value: unknown): Record<string, string> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, string>;
  try {
    const parsed = JSON.parse(value as string);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Parse a JSON-encoded `Record<string, unknown>` from a Prisma field.
 * Falls back to an empty object if null, undefined, or invalid JSON.
 */
export function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(value as string);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Serialize a record to a JSON string for storage in a Prisma field.
 * Accepts undefined for convenience (returns '{}').
 */
export function serializeRecord(value: Record<string, unknown> | Record<string, string> | undefined): string {
  return JSON.stringify(value ?? {});
}
