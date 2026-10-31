// ─── Canonical version constants — read from package.json ───

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function readVersion(pkgPath: string): string {
  try {
    const raw = readFileSync(pkgPath, 'utf-8');
    return (JSON.parse(raw) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Agent version bundled with this Control API deployment.
 */
export const AGENT_VERSION = (() => {
  const fromJson = readVersion(resolve(__dirname, '../../agent-version.json'));
  if (fromJson !== '0.0.0') return fromJson;
  return readVersion(resolve(__dirname, '../../../../packages/agent/package.json'));
})();

/**
 * Current control-api version — read from this repo's own package.json.
 * Used by the self-updater to detect when a `git pull` brings a new version.
 */
export const CONTROL_API_VERSION = readVersion(resolve(__dirname, '../../package.json'));

/** Compiled marker for the fail-closed deployment and rollback contract. */
export const CONTROL_API_RELEASE_CONTRACT_VERSION = 1;
