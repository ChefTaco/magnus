import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  getCodexState: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  getDb: () => ({ node: { findMany: mocks.findMany } }),
}));

vi.mock('../sdk/index.js', () => ({
  NodeApiClient: class {
    getCodexState = mocks.getCodexState;
  },
}));

vi.mock('../utils/env.js', () => ({
  getNodeManagerSecret: () => 'node-manager-secret-for-tests',
}));

const { getCodexFleetPosture, listCodexInstallations } = await import('./codex-service.js');

const nodes = [
  {
    id: 'node-installed', name: 'installed', hostname: 'installed.example',
    ipAddress: 'installed.example', port: 4100, status: 'ONLINE', lastHeartbeatAt: new Date(),
  },
  {
    id: 'node-empty', name: 'empty', hostname: 'empty.example',
    ipAddress: 'empty.example', port: 4100, status: 'ONLINE', lastHeartbeatAt: new Date(),
  },
];

function state(installed: boolean) {
  return {
    success: true,
    data: {
      installed,
      user: 'operator',
      userHome: '/home/operator',
      codexHome: '/home/operator/.codex',
      codexBin: installed ? '/home/operator/.local/bin/codex' : null,
      version: installed ? '0.153.0' : null,
      latestVersion: '0.154.0',
      updateAvailable: installed,
      provenance: installed ? 'standalone' as const : 'unknown' as const,
      updateSupported: installed,
      auth: {
        status: 'not_authenticated' as const,
        mode: null,
        oauth: false,
        tokenExpiresAt: null,
        tokenExpired: null,
        refreshTokenPresent: false,
        lastRefreshAt: null,
        planType: null,
        autoLoggedOut: false,
        message: installed ? 'Login required.' : 'Codex CLI is not installed.',
      },
      checkedAt: '2026-09-15T12:00:00.000Z',
      error: null,
    },
  };
}

describe('codex fleet cache', () => {
  beforeEach(() => {
    mocks.findMany.mockReset().mockResolvedValue(nodes);
    mocks.getCodexState.mockReset()
      .mockResolvedValueOnce(state(true))
      .mockResolvedValueOnce(state(false));
  });

  it('serves repeated inventory reads from cache and omits non-installs from health posture', async () => {
    const first = await listCodexInstallations(true);
    const second = await listCodexInstallations(false);
    const posture = getCodexFleetPosture();

    expect(first).toHaveLength(2);
    expect(second).toBe(first);
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.getCodexState).toHaveBeenCalledTimes(2);
    expect(posture).toMatchObject({
      status: 'ready',
      managedNodes: 2,
      installations: 1,
      updatesAvailable: 1,
      needsLogin: 1,
      currentRelease: '0.154.0',
    });
    expect(posture.nodes.map((node) => node.nodeName)).toEqual(['installed']);
  });
});
