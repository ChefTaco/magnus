/**
 * What the server needs to know before it touches a node. Read only: nothing
 * here takes a lock or writes a file, so asking is safe at any time and needs
 * no lease. The same data, minus the checks against a target, goes out with
 * every heartbeat, so an operator sees drift long before an upgrade.
 */
import type { AgentDiskHealth, AgentLedgerHealth, AgentNpmHealth, AgentUpgradePreflight } from '@hivemagnus/magnus-contracts';
import type { CommandLedger, LedgerHealth } from '../executors/command-ledger.js';
import { logger } from '../utils/logger.js';
import { diskHealth, engineProblem, installDir, npmHealth, runsVersion, selfUpgradeStatus, unwritablePaths, versionComplete } from './self-upgrade.js';

export const PREFLIGHT_PROTOCOL = 1;
const LEDGER_CACHE_MS = 60_000;

type LedgerReader = Pick<CommandLedger, 'health' | 'managedEnrollment'>;

const ledgerReport = (health: LedgerHealth): AgentLedgerHealth => ({ readable: health.readable, activeLock: health.activeLock,
  nonTerminalReceipts: health.nonTerminalReceipts, unresolvedReceipts: health.unresolvedReceipts, truncated: health.truncated, error: health.error });

export async function upgradePreflight(options: { version: string; target?: string | undefined; engines?: string | undefined; ledger: LedgerReader;
  env?: NodeJS.ProcessEnv; nodeVersion?: string }): Promise<AgentUpgradePreflight> {
  const env = options.env ?? process.env;
  const dir = installDir(env);
  const status = selfUpgradeStatus(options.version, env);
  const health = await options.ledger.health();
  const enrollment = await options.ledger.managedEnrollment().then(
    marker => marker ? { nodeId: marker.nodeId, nodeFqdn: marker.nodeFqdn } : null,
    (error: unknown) => {
      logger.warn(`Local enrollment marker could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const range = options.engines?.slice(0, 200) || null;
  const problem = range ? engineProblem(range, nodeVersion) : null;
  const blocked = unwritablePaths(dir);
  const disk = diskHealth(dir);
  return {
    preflightProtocol: PREFLIGHT_PROTOCOL,
    version: options.version,
    target: options.target?.slice(0, 64) ?? null,
    layout: status.layout,
    launcherProtocol: status.launcherProtocol,
    enabled: status.enabled,
    reason: status.reason ?? null,
    writable: { ok: blocked.length === 0, blocked },
    ...(disk ? { disk } : {}),
    npm: npmHealth(env),
    fromVersionComplete: versionComplete(dir, options.version) && runsVersion(dir, options.version),
    ledger: ledgerReport(health),
    fenceHighWater: health.fenceHighWater,
    managedEnrollment: enrollment,
    engines: { node: nodeVersion, range, compatible: range ? problem === null : null, problem },
  };
}

let cached: { at: number; health: LedgerHealth } | null = null;
let refreshing = false;

/** Ledger health for heartbeats: the last scan at once, with a new scan in the background once a minute. */
function cachedLedgerHealth(ledger: LedgerReader, now = Date.now()): LedgerHealth | null {
  if (!refreshing && (!cached || now - cached.at >= LEDGER_CACHE_MS)) {
    refreshing = true;
    void ledger.health().then(health => { cached = { at: Date.now(), health }; }, (error: unknown) => {
      logger.warn(`Ledger health could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => { refreshing = false; });
  }
  return cached?.health ?? null;
}

/** The optional drift fields of a heartbeat's self-upgrade report. An older server ignores them. */
export function heartbeatDrift(ledger: LedgerReader, env: NodeJS.ProcessEnv = process.env): {
  fenceHighWater?: Record<string, string>; ledger?: AgentLedgerHealth; disk?: AgentDiskHealth; npm: AgentNpmHealth;
} {
  const health = cachedLedgerHealth(ledger);
  const disk = diskHealth(installDir(env));
  return { ...(health ? { fenceHighWater: health.fenceHighWater, ledger: ledgerReport(health) } : {}), ...(disk ? { disk } : {}), npm: npmHealth(env) };
}
