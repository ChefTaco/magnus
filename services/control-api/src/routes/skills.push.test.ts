import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '../middleware/error-handler.js';
import { commandRequestDigest } from '../security/command-request.js';
import { httpIdentity } from '../security/managed-http.js';
import { nextSkillPublicationCommandId, skillPublicationCommandId } from '../services/skill-publication-state.js';

const fixture = vi.hoisted(() => ({
  publish: vi.fn(), recover: vi.fn(), retain: vi.fn(), audit: vi.fn(),
  bundle: { skillName: 'maps', version: '2.0.0', registryContentSha256: '1'.repeat(64),
    bundleSha256: '2'.repeat(64), treeSha256: '3'.repeat(64),
    bundle: { format: 'magnus-skill-bundle-v1' as const, entries: [] } },
}));

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  requireRole: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getUser: () => ({ userId: 'operator', email: 'operator@example.test' }),
}));
vi.mock('../utils/idempotency.js', () => ({ enforceIdempotencyFromHeader: async () => {} }));
vi.mock('../utils/env.js', () => ({ getNodeManagerSecret: () => 'node-secret' }));
vi.mock('../services/audit-service.js', () => ({ logAuditEvent: fixture.audit }));
vi.mock('../services/skill-service.js', () => ({ getSkill: async () => ({ name: 'maps', version: '2.0.0' }) }));
vi.mock('../services/skill-registry-service.js', () => ({}));
vi.mock('../services/skill-publication-bundle.js', () => ({ buildSkillPublicationBundle: async () => fixture.bundle }));
vi.mock('../services/command-resource-leases.js', () => ({ retainUnknownResourceCommand: fixture.retain }));
vi.mock('../sdk/index.js', () => ({ NodeApiClient: class {
  publishSkillBundle = fixture.publish;
  recoverSkillBundle = fixture.recover;
} }));

interface Installation {
  id: string; skillName: string; nodeId: string; version: string; status: string;
  registryEntryId: string | null; versionHash: string | null; bundleSha256: string | null;
  treeSha256: string | null; workflowCommandId: string | null; workflowRequestSha256: string | null;
  workflowReceiptSha256: string | null; installedAt: Date | null; error: string | null;
}

const v1 = (): Installation => ({ id: 'install-one', skillName: 'maps', nodeId: 'node-one', version: '1.0.0',
  status: 'installed', registryEntryId: 'registry-one', versionHash: 'a'.repeat(64),
  bundleSha256: 'b'.repeat(64), treeSha256: 'c'.repeat(64), workflowCommandId: 'skill-v1',
  workflowRequestSha256: 'd'.repeat(64), workflowReceiptSha256: 'e'.repeat(64),
  installedAt: new Date('2026-09-20T00:00:00.000Z'), error: null });

const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
  Object.entries(where).every(([key, value]) => value instanceof Date && row[key] instanceof Date
    ? row[key].getTime() === value.getTime() : row[key] === value);

function database(initial: Installation = v1()) {
  const state: { install: Installation; lease: Record<string, unknown> | null; command: Record<string, unknown> | null } = {
    install: structuredClone(initial), lease: null, command: null,
  };
  const db: any = {
    $executeRaw: async () => 1,
    $transaction: async (run: (tx: unknown) => unknown) => run(db),
    node: { findMany: async () => [{ id: 'node-one', hostname: 'node-one.example',
      ipAddress: 'node-one.example', port: 4100, status: 'ONLINE' }] },
    skillRegistryEntry: { findUnique: async () => ({ id: 'registry-one', versions: [{ version: '2.0.0',
      contentHash: '1'.repeat(64), files: '[]' }] }) },
    skillInstallation: {
      findUnique: async ({ where }: any) => where.id && where.id !== state.install.id ? null : structuredClone(state.install),
      upsert: async ({ update, create }: any) => {
        state.install = state.install ? { ...state.install, ...update } : { ...create, id: 'install-one' };
        return structuredClone(state.install);
      },
      updateMany: async ({ where, data }: any) => {
        if (!matches(state.install as unknown as Record<string, unknown>, where)) return { count: 0 };
        state.install = { ...state.install, ...data }; return { count: 1 };
      },
    },
    remoteCommand: {
      findFirst: async () => state.command && ({ id: state.command.id, status: state.command.status }),
      findUnique: async ({ where }: any) => state.command?.id === where.id ? state.command : null,
    },
    commandResourceLease: { findUnique: async ({ where }: any) => state.lease?.commandId === where.commandId ? state.lease : null },
  };
  return { db, state };
}

const { getDb } = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock('../db/index.js', () => ({ getDb }));
const { skillsRouter } = await import('./skills.js');
const app = new Hono().onError(errorHandler).route('/skills', skillsRouter);

const push = () => app.request('/skills/push', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ nodeIds: ['node-one'], skillName: 'maps', version: '2.0.0' }) });

const successorId = skillPublicationCommandId({ nodeId: 'node-one', skillName: 'maps', version: '2.0.0',
  versionHash: '1'.repeat(64), bundleSha256: '2'.repeat(64), treeSha256: '3'.repeat(64) });
const success = (commandId = successorId) => ({ response: { success: true, data: { skillName: 'maps', version: '2.0.0',
  nodeId: 'node-one', status: 'installed', bundleSha256: '2'.repeat(64), treeSha256: '3'.repeat(64),
  commandId, requestSha256: '4'.repeat(64), publishedAt: '2026-09-20T01:00:00.000Z' } },
  evidence: { commandId, commandSha256: '4'.repeat(64), receiptSha256: '5'.repeat(64) } });

describe('/skills/push successor isolation', () => {
  beforeEach(() => { vi.clearAllMocks(); fixture.audit.mockResolvedValue(undefined); fixture.retain.mockResolvedValue(undefined); });

  it.each(['offline before admission', 'cancelled/no-effect recovery'])('preserves installed v1 when v2 is %s', async mode => {
    const { db, state } = database(); getDb.mockReturnValue(db);
    if (mode.startsWith('cancelled')) {
      const coordination = { version: 1 as const, resourceKey: 'node:node-one', fence: '2', expiresAt: Date.now() + 60_000 };
      const payload = { skillName: 'maps', version: '2.0.0', bundleSha256: fixture.bundle.bundleSha256,
        bundle: fixture.bundle.bundle };
      const command = { ...httpIdentity(successorId, 'POST', '/skills/install', JSON.stringify(payload), 300), coordination };
      state.command = { id: successorId, nodeId: 'node-one', status: 'CANCELLED', command: command.command,
        args: JSON.stringify(command.args), timeoutSeconds: 300 };
      state.lease = { id: 'lease-v2', commandId: successorId, nodeId: 'node-one',
        ownerActor: 'skill-installation:install-one', state: 'released', coordinationJson: JSON.stringify(coordination),
        requestSha256: commandRequestDigest(command) };
      fixture.recover.mockRejectedValueOnce(new Error('no retained terminal receipt'));
    } else fixture.publish.mockRejectedValueOnce(new Error('offline'));

    const response = await push();
    expect(response.status).toBe(201);
    expect((await response.json()).data.installations[0].status).toBe('failed');
    expect(state.install).toMatchObject({ version: '1.0.0', status: 'installed', workflowCommandId: 'skill-v1',
      workflowRequestSha256: 'd'.repeat(64), workflowReceiptSha256: 'e'.repeat(64) });
  });

  it('does not let a concurrent same-bundle error downgrade the exact installed success', async () => {
    const { db, state } = database({ ...v1(), version: '2.0.0', status: 'failed',
      versionHash: '1'.repeat(64), bundleSha256: '2'.repeat(64), treeSha256: '3'.repeat(64),
      workflowCommandId: successorId, workflowRequestSha256: null, workflowReceiptSha256: null,
      installedAt: null, error: 'prior failure' }); getDb.mockReturnValue(db);
    let releaseSuccess!: () => void; let releaseFailure!: () => void;
    const successGate = new Promise<void>(resolve => { releaseSuccess = resolve; });
    const failureGate = new Promise<void>(resolve => { releaseFailure = resolve; });
    fixture.publish.mockImplementationOnce(async (_payload, commandId) => { expect(commandId).toBe(successorId); await successGate; return success(); });
    fixture.publish.mockImplementationOnce(async (_payload, commandId) => { expect(commandId).toBe(successorId); await failureGate; throw new Error('late transport error'); });
    const first = push(); const second = push();
    await vi.waitFor(() => expect(fixture.publish).toHaveBeenCalledTimes(2));
    releaseSuccess(); await vi.waitFor(() => expect(state.install.version).toBe('2.0.0'));
    releaseFailure();
    const responses = await Promise.all([first, second]);
    expect(responses.map(response => response.status)).toEqual([201, 201]);
    expect(state.install).toMatchObject({ version: '2.0.0', status: 'installed', workflowCommandId: successorId,
      workflowRequestSha256: '4'.repeat(64), workflowReceiptSha256: '5'.repeat(64) });
  });

  it('recovers the exact successor once and makes later replay read-only', async () => {
    const { db, state } = database(); getDb.mockReturnValue(db);
    const coordination = { version: 1 as const, resourceKey: 'node:node-one', fence: '3', expiresAt: Date.now() + 60_000 };
    const payload = { skillName: 'maps', version: '2.0.0', bundleSha256: fixture.bundle.bundleSha256,
      bundle: fixture.bundle.bundle };
    const command = { ...httpIdentity(successorId, 'POST', '/skills/install', JSON.stringify(payload), 300), coordination };
    state.command = { id: successorId, nodeId: 'node-one', status: 'COMPLETED', command: command.command,
      args: JSON.stringify(command.args), timeoutSeconds: 300 };
    state.lease = { id: 'lease-v2', commandId: successorId, nodeId: 'node-one',
      ownerActor: 'skill-installation:install-one', state: 'released', coordinationJson: JSON.stringify(coordination),
      requestSha256: commandRequestDigest(command) };
    fixture.recover.mockResolvedValueOnce(success());

    expect((await push()).status).toBe(201);
    expect((await push()).status).toBe(201);
    expect(fixture.recover).toHaveBeenCalledTimes(1);
    expect(fixture.publish).not.toHaveBeenCalled();
    expect(state.install).toMatchObject({ version: '2.0.0', status: 'installed', workflowCommandId: successorId,
      workflowReceiptSha256: '5'.repeat(64) });
  });

  it.each([
    { commandStatus: 'CANCELLED', leaseState: 'unknown', settlement: null },
    { commandStatus: 'FAILED', leaseState: 'released', settlement: 'signed-command-result' },
  ])('blocks a distinct successor behind uncorrelated effect state: %j', async prior => {
    const { db, state } = database(); getDb.mockReturnValue(db);
    state.command = { id: 'skill-unsettled-successor', status: prior.commandStatus };
    state.lease = { commandId: 'skill-unsettled-successor', state: prior.leaseState, settlement: prior.settlement };

    const response = await push();
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('SKILL_PUBLICATION_BUSY');
    expect(fixture.publish).not.toHaveBeenCalled();
    expect(fixture.recover).not.toHaveBeenCalled();
    expect(state.install).toMatchObject({ version: '1.0.0', status: 'installed',
      workflowCommandId: 'skill-v1', workflowReceiptSha256: 'e'.repeat(64) });
  });

  it('blocks a distinct successor when its retained command has lost the lease authority record', async () => {
    const { db, state } = database(); getDb.mockReturnValue(db);
    state.command = { id: 'skill-missing-lease', status: 'CANCELLED' };
    state.lease = null;
    const response = await push();
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('SKILL_PUBLICATION_BUSY');
    expect(fixture.publish).not.toHaveBeenCalled();
  });

  it('blocks the exact successor command when its durable lease authority record is missing', async () => {
    const { db, state } = database(); getDb.mockReturnValue(db);
    state.command = { id: successorId, status: 'FAILED' };
    state.lease = null;
    const response = await push();
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('SKILL_PUBLICATION_BUSY');
    expect(fixture.publish).not.toHaveBeenCalled();
    expect(fixture.recover).not.toHaveBeenCalled();
  });

  it('advances from proved no-effect to a fresh exact generation that can succeed', async () => {
    const { db, state } = database(); getDb.mockReturnValue(db);
    state.command = { id: successorId, status: 'FAILED' };
    state.lease = { commandId: successorId, state: 'released', settlement: 'not-dispatched' };
    const retryId = nextSkillPublicationCommandId({ nodeId: 'node-one', skillName: 'maps', version: '2.0.0',
      versionHash: '1'.repeat(64), bundleSha256: '2'.repeat(64), treeSha256: '3'.repeat(64) }, successorId);
    fixture.publish.mockImplementationOnce(async (_payload, commandId) => {
      expect(commandId).toBe(retryId); return success(commandId);
    });

    expect((await push()).status).toBe(201);
    expect(fixture.recover).not.toHaveBeenCalled();
    expect(state.install).toMatchObject({ version: '2.0.0', status: 'installed',
      workflowCommandId: retryId, workflowReceiptSha256: '5'.repeat(64) });
  });

  it('advances from signed typed no-effect to a fresh exact generation that can succeed', async () => {
    const { db, state } = database(); getDb.mockReturnValue(db);
    state.command = { id: successorId, status: 'FAILED' };
    state.lease = { commandId: successorId, state: 'released',
      settlement: `signed-skill-no-effect:${'6'.repeat(64)}` };
    const retryId = nextSkillPublicationCommandId({ nodeId: 'node-one', skillName: 'maps', version: '2.0.0',
      versionHash: '1'.repeat(64), bundleSha256: '2'.repeat(64), treeSha256: '3'.repeat(64) }, successorId);
    fixture.publish.mockResolvedValueOnce(success(retryId));
    expect((await push()).status).toBe(201);
    expect(state.install).toMatchObject({ status: 'installed', workflowCommandId: retryId,
      workflowReceiptSha256: '5'.repeat(64) });
  });

  it('correlates expired lost-POST recovery as typed no-effect, then succeeds with a fresh generation', async () => {
    const { db, state } = database(); getDb.mockReturnValue(db);
    const coordination = { version: 1 as const, resourceKey: 'node:node-one', fence: '7',
      expiresAt: Date.now() - 1_000 };
    const payload = { skillName: 'maps', version: '2.0.0', bundleSha256: fixture.bundle.bundleSha256,
      bundle: fixture.bundle.bundle };
    const command = { ...httpIdentity(successorId, 'POST', '/skills/install', JSON.stringify(payload), 300), coordination };
    state.command = { id: successorId, nodeId: 'node-one', status: 'RUNNING', command: command.command,
      args: JSON.stringify(command.args), timeoutSeconds: 300 };
    state.lease = { id: 'lease-expired', commandId: successorId, nodeId: 'node-one',
      ownerActor: 'skill-installation:install-one', state: 'running', settlement: null,
      coordinationJson: JSON.stringify(coordination), requestSha256: commandRequestDigest(command) };
    fixture.recover.mockImplementationOnce(async () => {
      state.lease!.state = 'released';
      state.lease!.settlement = `signed-skill-no-effect:${'7'.repeat(64)}`;
      throw new Error('signed recovery proved no effect');
    });

    expect(((await (await push()).json()).data.installations[0]).status).toBe('failed');
    expect(state.install).toMatchObject({ version: '1.0.0', status: 'installed', workflowCommandId: 'skill-v1' });
    const retryId = nextSkillPublicationCommandId({ nodeId: 'node-one', skillName: 'maps', version: '2.0.0',
      versionHash: '1'.repeat(64), bundleSha256: '2'.repeat(64), treeSha256: '3'.repeat(64) }, successorId);
    fixture.publish.mockResolvedValueOnce(success(retryId));
    expect((await push()).status).toBe(201);
    expect(fixture.recover).toHaveBeenCalledTimes(1);
    expect(state.install).toMatchObject({ version: '2.0.0', status: 'installed',
      workflowCommandId: retryId, workflowReceiptSha256: '5'.repeat(64) });
  });
});
