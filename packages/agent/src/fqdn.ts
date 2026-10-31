import { execSync } from 'node:child_process';
import { hostname } from 'node:os';

let cachedFqdn: string | null = null;

/**
 * Resolve the machine's fully-qualified domain name.
 *
 * Strategy:
 *  1. Run `hostname --fqdn` (Linux)
 *  2. Fall back to `os.hostname()`
 *
 * The result is cached for the lifetime of the process.
 */
export function getFqdn(): string {
  if (cachedFqdn) return cachedFqdn;

  try {
    const result = execSync('hostname --fqdn', {
      encoding: 'utf-8',
      timeout: 3_000,
    }).trim();

    if (result && result.includes('.')) {
      cachedFqdn = result;
      return cachedFqdn;
    }
  } catch {
    // hostname --fqdn not available or failed
  }

  cachedFqdn = hostname();
  return cachedFqdn;
}
