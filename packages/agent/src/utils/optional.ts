/** Preserve an optional field's absence when a parser or environment lookup
 * returns undefined. Null remains an explicit value. Evaluate the value once. */
export function optional<K extends string, T>(key: K, value: T | undefined): Partial<Record<K, T>> {
  const result: Partial<Record<K, T>> = {};
  if (value !== undefined) result[key] = value;
  return result;
}
