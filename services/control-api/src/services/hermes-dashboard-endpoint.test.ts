import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HermesNodeState } from '../types/index.js';
const fixture = vi.hoisted(() => ({ row: {} as any, job: {} as any, upsert: vi.fn(), node: vi.fn(), getState: vi.fn(), remote: vi.fn() }));
vi.mock('../db/index.js', () => ({ getDb: () => ({
  node: { findUnique: fixture.node },
  hermesOperationJob: {
    create: async ({ data }: any) => (fixture.job = { id: 'job-fixture', ...data }),
    update: async ({ data }: any) => (fixture.job = { ...fixture.job, ...data }),
    findUnique: async () => fixture.job,
  },
  hermesInstallation: { upsert: fixture.upsert, deleteMany: vi.fn(), findUnique: () => fixture.row },
}) }));
vi.mock('../sdk/index.js', () => ({ NodeApiClient: class { getHermesState = fixture.getState; } }));
vi.mock('./event-bus.js', () => ({ eventBus: { publish: vi.fn() }, EventChannels: {} }));
vi.mock('./notification-service.js', () => ({ createNotification: vi.fn() }));
vi.mock('./ssh-exec-service.js', () => ({ escapeForSingleQuotes: (s: string) => s, redactSensitiveText: (s: string) => s, resolveDeploySshCredentials: vi.fn(), runRemoteCommand: fixture.remote }));
vi.mock('../utils/env.js', () => ({ getNodeManagerSecret: () => 'fixture-only' }));
import { recordManagedHermesState } from './hermes-service.js';
const state = (extra: Record<string, unknown> = {}) => ({ installed: true, status: 'running', installMode: 'existing', version: 'fixture', hermesBin: 'hermes', hermesHome: '/home/operator/.hermes', gatewayStatus: 'running', dashboardStatus: 'running', dashboardHost: '100.64.0.69', dashboardPort: 9119, apiServerEnabled: false, apiServerHost: '127.0.0.1', apiServerPort: null, profiles: [], rawChecks: {}, configuration: {}, ...extra }) as HermesNodeState;
beforeEach(() => {
  fixture.row = { id: 'installation-fixture', hostname: 'coordinator.fixture', dashboardHost: '127.0.0.1', dashboardPort: 9119 };
  fixture.node.mockResolvedValue({ id: 'node-fixture', hostname: 'coordinator.fixture', name: 'coordinator', ipAddress: '100.64.0.69', port: 4100 });
  fixture.getState.mockReset(); fixture.remote.mockReset();
  fixture.upsert.mockReset().mockImplementation(async ({ create, update }) => { expect(create.dashboardHost).toBe(update.dashboardHost); fixture.row = { ...fixture.row, ...update }; return fixture.row; });
});
describe('managed node dashboard observation persistence', () => {
  it('persists actual endpoint through node-state conversion and installation update', async () => {
    await recordManagedHermesState('node-fixture', state());
    expect(fixture.row).toMatchObject({ dashboardHost: '100.64.0.69', dashboardPort: 9119, dashboardStatus: 'running' });
    await recordManagedHermesState('node-fixture', state({ dashboardStatus: 'unknown', dashboardHost: undefined, dashboardPort: undefined }));
    expect(fixture.row).toMatchObject({ dashboardHost: '100.64.0.69', dashboardPort: 9119, dashboardStatus: 'unknown' });
    expect(fixture.upsert.mock.calls[1]![0].update).not.toHaveProperty('dashboardHost');
  });
  it.each([{ dashboardHost: 'unreviewed.example' }, { dashboardHost: 'http://100.64.0.69' }, { dashboardPort: 0 }, { dashboardPort: 65536 }, { dashboardPort: '9119' }, { dashboardPort: 1.5 }, { dashboardStatus: 'error' }, { dashboardStatus: 'unknown' }])('retains stored endpoint on incomplete or invalid observation %j', async extra => {
    await recordManagedHermesState('node-fixture', state(extra));
    expect(fixture.row).toMatchObject({ dashboardHost: '127.0.0.1', dashboardPort: 9119 });
    expect(fixture.upsert.mock.calls[0]![0].update).not.toHaveProperty('dashboardHost');
  });
});

