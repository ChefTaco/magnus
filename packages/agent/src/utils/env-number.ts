/**
 * A positive integer setting, or `fallback` when it is unset or not a number.
 * `Number('30s')` is NaN, and a NaN timer delay fires every millisecond.
 */
export function positiveIntegerEnv(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env[name]?.trim() || Number.NaN);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
