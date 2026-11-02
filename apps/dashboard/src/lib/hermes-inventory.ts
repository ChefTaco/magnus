import type { HermesInstallation, HermesProfile } from '@/types/orchestra';

export interface HermesInventorySummary {
  installations: number;
  healthyInstallations: number;
  profiles: number;
  runningGateways: number;
}

/** The API keeps rows for hosts that no longer have Hermes; they count as nothing here. */
export function summarizeHermesInventory(
  installations: ReadonlyArray<Pick<HermesInstallation, 'status'>>,
  profiles: ReadonlyArray<Pick<HermesProfile, 'gatewayStatus' | 'installation'>>,
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
