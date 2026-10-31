import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  outbox: {
    id: 'outbox-1', actionId: 'action-1', operation: 'execute', actorId: 'admin-1',
    status: 'pending', remoteCommandId: null as string | null, attempts: 0,
    nextAttemptAt: new Date(0), leaseExpiresAt: null as Date | null,
    lastError: null as string | null, createdAt: new Date(0), updatedAt: new Date(0),
    dispatchedAt: null as Date | null,
  },
  remoteUpsert: vi.fn(), enqueue: vi.fn(),
}));

const db = {
  securityFusionCommandOutbox: {
    findMany: vi.fn(async ({ where }: { where: { operation?: string } }) =>
      where.operation === harness.outbox.operation
      && ['pending', 'failed', 'dispatching'].includes(harness.outbox.status)
        ? [{ ...harness.outbox }]
        : []),
    findUnique: vi.fn(async () => ({ ...harness.outbox })),
    updateMany: vi.fn(async ({ where, data }: { where: { operation?: string; id?: string }, data: Record<string, unknown> }) => {
      if (where.operation === 'execute' && harness.outbox.operation === 'execute') {
        const states = (where as { status?: { in?: string[] } }).status?.in ?? [];
        if (!states.includes(harness.outbox.status)) return { count: 0 };
        Object.assign(harness.outbox, data);
        return { count: 1 };
      }
      if (where.id === harness.outbox.id && harness.outbox.operation === 'release') {
        if (data['status'] === 'dispatching') {
          harness.outbox.status = 'dispatching';harness.outbox.attempts += 1;
        } else if (data['status'] === 'failed') {
          harness.outbox.status = 'failed';harness.outbox.lastError = String(data['lastError']);
          harness.outbox.nextAttemptAt = data['nextAttemptAt'] as Date;
        }
        return { count: 1 };
      }
      return { count: 0 };
    }),
    update: vi.fn(({ data }: { data: Record<string, unknown> }) => {
      Object.assign(harness.outbox, data);return Promise.resolve({ ...harness.outbox });
    }),
  },
  securityFusionAction: {
    findUnique: vi.fn(async () => ({ id: 'action-1', nodeId: 'node-1', kind: 'host_isolation',
      serviceName: null, isolationMinutes: 15, status: 'release_pending' })),
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
  node: { findUnique: vi.fn(async () => ({ id: 'node-1', ipAddress: '127.0.0.1', port: 4100 })) },
  remoteCommand: { upsert: harness.remoteUpsert },
  $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
};

vi.mock('../db/index.js', () => ({ getDb: () => db }));
vi.mock('../queue/workers.js', () => ({ enqueueCommand: harness.enqueue }));
const { dispatchSecurityFusionOutbox } = await import('./security-fusion-outbox.js');

describe('embedded Security Fusion release-only outbox', () => {
  beforeEach(() => {
    Object.assign(harness.outbox, { operation: 'execute', status: 'pending', remoteCommandId: null,
      attempts: 0, nextAttemptAt: new Date(0), leaseExpiresAt: null, lastError: null,
      dispatchedAt: null });
    vi.clearAllMocks();
    harness.enqueue.mockResolvedValue(undefined);
    harness.remoteUpsert.mockResolvedValue({ id: 'remote-1' });
  });

  it.each(['pending', 'failed', 'dispatching', 'unknown'])('quarantines legacy %s execute without queueing a command', async status => {
    harness.outbox.status = status;
    expect(await dispatchSecurityFusionOutbox()).toBe(0);
    expect(harness.outbox.status).toBe('blocked');
    expect(harness.outbox.lastError).toContain(['dispatching', 'unknown'].includes(status)
      ? 'may have occurred' : 'standalone Security Fusion approval is required');
    expect(harness.remoteUpsert).not.toHaveBeenCalled();
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(db.securityFusionCommandOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { operation: 'execute', status: { in: ['pending', 'failed'] } },
    }));
    expect(db.securityFusionCommandOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { operation: 'execute', status: { in: ['dispatching', 'unknown'] } },
    }));
  });

  it('fails release closed when no containment helper is configured', async () => {
    harness.outbox.operation = 'release';
    expect(await dispatchSecurityFusionOutbox()).toBe(0);
    expect(harness.outbox.status).toBe('failed');
    expect(harness.outbox.lastError).toContain('SECURITY_FUSION_CONTAINMENT_COMMAND');
    expect(harness.remoteUpsert).not.toHaveBeenCalled();
  });

  it('retains unconditional release and its idempotent queue retry', async () => {
    vi.stubEnv('SECURITY_FUSION_CONTAINMENT_COMMAND', '/usr/local/sbin/example-containment');
    harness.outbox.operation = 'release';
    harness.enqueue.mockRejectedValueOnce(new Error('redis unavailable'));
    expect(await dispatchSecurityFusionOutbox()).toBe(0);
    expect(harness.outbox.status).toBe('failed');
    harness.outbox.nextAttemptAt = new Date(0);
    harness.enqueue.mockResolvedValueOnce(undefined);
    expect(await dispatchSecurityFusionOutbox()).toBe(1);
    expect(harness.outbox.status).toBe('dispatched');
    expect(harness.outbox.remoteCommandId).toBe('remote-1');
    expect(harness.remoteUpsert).toHaveBeenCalledTimes(2);
    expect(harness.remoteUpsert.mock.calls[0]?.[0].where).toEqual(harness.remoteUpsert.mock.calls[1]?.[0].where);
    expect(harness.enqueue).toHaveBeenNthCalledWith(1, 'remote-1');
    expect(harness.enqueue).toHaveBeenNthCalledWith(2, 'remote-1');
    expect(harness.remoteUpsert.mock.calls[0]?.[0].create.command).toBe('/usr/local/sbin/example-containment');
    vi.unstubAllEnvs();
  });
});
