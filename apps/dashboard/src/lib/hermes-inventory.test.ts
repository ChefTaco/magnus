import { describe, expect, it } from 'vitest';
import type { HermesInstallationStatus } from '@/types/orchestra';
import { summarizeHermesInventory } from './hermes-inventory';

const install = (status: HermesInstallationStatus) => ({ status });
const profile = (gatewayStatus: 'running' | 'inactive', status: HermesInstallationStatus) => ({
  gatewayStatus, installation: { id: 'i', hostname: 'node-1.example.com', displayName: null, status },
});

describe('summarizeHermesInventory', () => {
  it('does not count rows for hosts without Hermes or leftover homes as healthy', () => {
    expect(summarizeHermesInventory(
      [install('running'), install('detected'), install('degraded'), install('not_installed')],
      [profile('running', 'running'), profile('inactive', 'detected'), profile('running', 'not_installed')],
    )).toEqual({ installations: 3, healthyInstallations: 2, profiles: 2, runningGateways: 1 });
  });
});
