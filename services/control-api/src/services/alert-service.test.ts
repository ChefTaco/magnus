import { beforeEach, describe, expect, it, vi } from 'vitest';

const rule = {
  id: 'system-gpu-fan-100-8h',
  name: 'GPU fan saturated for 8 hours',
  metric: 'gpu_fan',
  operator: 'gte',
  threshold: 100,
  durationSeconds: 28_800,
  severity: 'critical',
  nodeFilter: '*',
  cooldownMinutes: 480,
};

const findMany = vi.fn();
const stateFind = vi.fn();
const stateUpsert = vi.fn();
const stateDelete = vi.fn();
const gpuFindMany = vi.fn();
const violationFind = vi.fn();
const violationCreate = vi.fn();
const violationUpdateMany = vi.fn();
const violationUpdate = vi.fn();
const notificationFind = vi.fn();
const createNotification = vi.fn();
const publish = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({
    $transaction: (work: (tx: unknown) => Promise<unknown>) => work({
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      alertViolation: { findFirst: violationFind, create: violationCreate, update: violationUpdate },
      notification: { findFirst: notificationFind },
    }),
    alertRule: { findMany },
    alertConditionState: { findUnique: stateFind, upsert: stateUpsert, deleteMany: stateDelete },
    gpuSnapshot: { findMany: gpuFindMany },
    alertViolation: { findFirst: violationFind, create: violationCreate, updateMany: violationUpdateMany },
  }),
}));
vi.mock('./notification-service.js', () => ({ createNotificationInTransaction: createNotification }));
vi.mock('./maintenance-service.js', () => ({ matchingMaintenance: vi.fn().mockResolvedValue(null) }));
vi.mock('./event-bus.js', () => ({
  EventChannels: { ALERT_FIRED: 'alert:fired' },
  eventBus: { publish },
}));

const { evaluateHealth, matchesNodeFilter } = await import('./alert-service.js');

describe('sustained GPU fan alerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findMany.mockResolvedValue([rule]);
    stateUpsert.mockResolvedValue({});
    stateDelete.mockResolvedValue({ count: 0 });
    violationFind.mockResolvedValue(null);
    violationCreate.mockResolvedValue({});
    violationUpdateMany.mockResolvedValue({ count: 0 });
    violationUpdate.mockResolvedValue({});
    notificationFind.mockResolvedValue(null);
    createNotification.mockResolvedValue({});
    publish.mockResolvedValue(undefined);
    gpuFindMany.mockResolvedValue([]);
  });

  it('starts tracking without alerting on the first 100% sample', async () => {
    const sampledAt = new Date('2026-09-04T00:00:00.000Z');
    gpuFindMany.mockResolvedValue([{ sampledAt, devices: JSON.stringify([{ index: 0, vendor: 'nvidia', uuid: 'GPU-1', fanPercent: 100 }]) }]);

    await evaluateHealth('node-1', 'gpu-host', {
      gpuFanPercent: 100,
      gpuSampledAt: sampledAt,
      gpuSampleIsNew: true,
      gpuDevices: [{ index: 0, vendor: 'nvidia', uuid: 'GPU-1', fanPercent: 100 }],
    });

    expect(gpuFindMany).toHaveBeenCalledOnce();
    expect(violationCreate).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('fires through existing violations and notifications after more than eight continuous hours', async () => {
    const devices = [{ index: 0, vendor: 'nvidia', uuid: 'GPU-1', fanPercent: 100 }];
    gpuFindMany.mockResolvedValue(Array.from({ length: 962 }, (_, index) => ({
      sampledAt: new Date(Date.parse('2026-09-04T08:00:30.000Z') - index * 30 * 1000),
      devices: JSON.stringify(devices),
    })));

    await evaluateHealth('node-1', 'gpu-host', {
      gpuFanPercent: 100,
      gpuSampledAt: new Date('2026-09-04T08:00:30.000Z'),
      gpuSampleIsNew: true,
      gpuDevices: devices,
    });

    expect(violationCreate).toHaveBeenCalledOnce();
    expect(createNotification).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      severity: 'critical',
      title: expect.stringContaining('GPU FAN 100.0%'),
    }), null);
    expect(publish).toHaveBeenCalledWith('alert:fired', expect.objectContaining({ type: 'health.alert' }));
  });

  it('resets the duration after a telemetry gap longer than five minutes', async () => {
    const sampledAt = new Date('2026-09-04T03:05:01.000Z');
    const devices = [{ index: 0, vendor: 'nvidia', uuid: 'GPU-1', fanPercent: 100 }];
    gpuFindMany.mockResolvedValue([
      { sampledAt, devices: JSON.stringify(devices) },
      { sampledAt: new Date('2026-09-04T03:00:00.000Z'), devices: JSON.stringify(devices) },
    ]);

    await evaluateHealth('node-1', 'gpu-host', {
      gpuFanPercent: 100,
      gpuSampledAt: sampledAt,
      gpuSampleIsNew: true,
      gpuDevices: devices,
    });

    expect(violationCreate).not.toHaveBeenCalled();
  });

  it('ignores duplicate heartbeat copies of a GPU sample', async () => {
    await evaluateHealth('node-1', 'gpu-host', {
      gpuFanPercent: 100,
      gpuSampledAt: new Date('2026-09-04T08:00:00.000Z'),
      gpuSampleIsNew: false,
    });

    expect(stateFind).not.toHaveBeenCalled();
    expect(stateUpsert).not.toHaveBeenCalled();
  });

  it('resolves every active reminder when the fan drops below saturation', async () => {
    await evaluateHealth('node-1', 'gpu-host', {
      gpuFanPercent: 99,
      gpuSampledAt: new Date('2026-09-04T08:01:00.000Z'),
      gpuSampleIsNew: true,
      gpuDevices: [{ index: 0, vendor: 'nvidia', uuid: 'GPU-1', fanPercent: 99 }],
    });

    expect(violationUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { ruleId: rule.id, nodeId: 'node-1', status: 'active' },
    }));
  });

  const saturated = () => {
    const devices = [{ index: 0, vendor: 'nvidia', uuid: 'GPU-1', fanPercent: 100 }];
    gpuFindMany.mockResolvedValue(Array.from({ length: 962 }, (_, index) => ({
      sampledAt: new Date(Date.parse('2026-09-04T08:00:30.000Z') - index * 30 * 1000),
      devices: JSON.stringify(devices),
    })));
    return { gpuFanPercent: 100, gpuSampledAt: new Date('2026-09-04T08:00:30.000Z'), gpuSampleIsNew: true, gpuDevices: devices };
  };

  it('reminds on the one active violation after the cooldown instead of adding another', async () => {
    violationFind.mockResolvedValue({ id: 'violation-1', createdAt: new Date(Date.now() - 9 * 60 * 60 * 1000) });
    notificationFind.mockResolvedValue({ createdAt: new Date(Date.now() - 8.5 * 60 * 60 * 1000) });

    await evaluateHealth('node-1', 'gpu-host', saturated());

    expect(violationCreate).not.toHaveBeenCalled();
    expect(violationUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'violation-1' } }));
    expect(createNotification).toHaveBeenCalledOnce();
  });

  it('counts the cooldown from the last reminder, not from when the violation began', async () => {
    violationFind.mockResolvedValue({ id: 'violation-1', createdAt: new Date(Date.now() - 20 * 60 * 60 * 1000) });
    notificationFind.mockResolvedValue({ createdAt: new Date(Date.now() - 60 * 60 * 1000) });

    await evaluateHealth('node-1', 'gpu-host', saturated());

    expect(violationCreate).not.toHaveBeenCalled();
    expect(violationUpdate).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });
});

describe('alert node filters', () => {
  it('matches node IDs and names exactly, not as substrings', () => {
    expect(matchesNodeFilter('web1', 'node-a', 'web1')).toBe(true);
    expect(matchesNodeFilter('web1', 'node-b', 'web10')).toBe(false);
    expect(matchesNodeFilter('node-b', 'node-b', 'web10')).toBe(true);
    expect(matchesNodeFilter('db1, web1', 'node-a', 'web1')).toBe(true);
  });

  it('treats * as a wildcard', () => {
    expect(matchesNodeFilter('*', 'node-a', 'anything')).toBe(true);
    expect(matchesNodeFilter('web*', 'node-b', 'web10')).toBe(true);
    expect(matchesNodeFilter('web*', 'node-c', 'db1')).toBe(false);
    expect(matchesNodeFilter('*.example.com', 'node-d', 'web1.example.com')).toBe(true);
    expect(matchesNodeFilter('web.*', 'node-e', 'webXexample')).toBe(false);
  });
});
