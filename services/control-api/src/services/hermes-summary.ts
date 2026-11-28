/**
 * Hermes Agent inventory summary: the counts the console's mission-control page shows. Computed
 * here so every console reads the same figures from one ADMIN route instead of fetching the
 * installation and profile lists and counting them itself.
 */
import type { HermesInstallation, HermesProfile } from '../types/shared-contracts.js';
import { listHermesInstallations, listHermesProfiles } from './hermes-service.js';

export interface HermesInventorySummary {
  /** Installations on hosts that still have Hermes. */
  installations: number;
  /** Of those, the ones whose status is `running` or `detected`. */
  healthyInstallations: number;
  /** Profiles of installations that still have Hermes. */
  profiles: number;
  /** Of those, the ones whose gateway is `running`. */
  runningGateways: number;
}

/** The inventory keeps rows for hosts that no longer have Hermes; they count as nothing here. */
export function summarizeHermesInventory(
  installations: ReadonlyArray<Pick<HermesInstallation, 'status'>>,
  profiles: ReadonlyArray<Pick<HermesProfile, 'gatewayStatus'> & { installation?: Pick<HermesInstallation, 'status'> | null }>,
): HermesInventorySummary {
  const installed = installations.filter((item) => item.status !== 'not_installed');
  const current = profiles.filter((item) => item.installation?.status !== 'not_installed');
  return {
    installations: installed.length,
    healthyInstallations: installed.filter((item) => item.status === 'running' || item.status === 'detected').length,
    profiles: current.length,
    runningGateways: current.filter((item) => item.gatewayStatus === 'running').length,
  };
}

/** Summary over the same lists `GET /hermes/installations` and `GET /hermes/profiles` return. */
export async function getHermesInventorySummary(): Promise<HermesInventorySummary> {
  const [installations, profiles] = await Promise.all([listHermesInstallations(), listHermesProfiles()]);
  return summarizeHermesInventory(installations, profiles);
}
