import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = { id: string; nodeId: string; profile: string; agentId: string; workspaceId: string; issuedAt: Date; expiresAt: Date;
  lastRenewedAt: Date | null; lastAttemptAt: Date | null; nextAttemptAt: Date; failures: number; lastError: string | null;
  renewals: number; leaseUntil: Date | null; leaseToken: string | null; pendingJson: string | null; recoveryRequired: boolean; updatedAt: Date };
type Operation = { nodeId: string; profile: string; status: string; stepsJson: string; completedAt: Date | null };
const store = vi.hoisted(() => ({ rows: new Map<string, Row>(), operations: [] as Operation[],
  audit: [] as Array<{ action: string; actorId: string; targetId: string; details?: Record<string, unknown> }>,
  notifications: [] as Array<{ type: string; severity: string; title: string; message: string; sourceRef?: string | null }> }));
const matches = (row: Row, where: Record<string, unknown>): boolean => Object.entries(where).every(([key, value]) => {
  if (key === 'OR') return (value as Record<string, unknown>[]).some(option => matches(row, option));
  const actual = row[key as keyof Row];
  if (value instanceof Date) return actual instanceof Date && actual.getTime() === value.getTime();
  if (value && typeof value === 'object') return Object.entries(value).every(([op, bound]) => {
    if (op === 'in') return (bound as unknown[]).includes(actual);
    if (!(actual instanceof Date) || !(bound instanceof Date)) return false;
    return op === 'lte' ? actual <= bound : op === 'lt' ? actual < bound : op === 'gt' ? actual > bound : false;
  });
  return actual === value;
});
vi.mock('../db/index.js', () => ({ getDb: () => ({
  ardentHiveMemCredential: {
    createMany: async ({ data }: { data: Row }) => {
      if ([...store.rows.values()].some(row => row.nodeId === data.nodeId && row.profile === data.profile)) return { count: 0 };
      const row = { ...data, id: `cred-${store.rows.size + 1}`, lastAttemptAt: null, lastRenewedAt: null, renewals: 0, updatedAt: new Date() };
      store.rows.set(row.id, row); return { count: 1 };
    },
    upsert: async ({ where, create, update }: { where: { nodeId_profile: { nodeId: string; profile: string } }; create: Partial<Row>; update: Partial<Row> }) => {
      const existing = [...store.rows.values()].find(row => row.nodeId === where.nodeId_profile.nodeId && row.profile === where.nodeId_profile.profile);
      if (existing) { Object.assign(existing, update); return { ...existing }; }
      const row = { id: `cred-${store.rows.size + 1}`, lastRenewedAt: null, lastAttemptAt: null, renewals: 0, updatedAt: new Date(), ...create } as Row;
      store.rows.set(row.id, row);
      return { ...row };
    },
    findMany: async ({ where = {} }: { where?: Record<string, unknown> } = {}) => [...store.rows.values()]
      .filter(row => matches(row, where)).sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime()).map(row => ({ ...row })),
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      const row = [...store.rows.values()].find(row => matches(row, where)); return row ? { ...row } : null;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
      const row = [...store.rows.values()].find(row => matches(row, where));
      if (!row) return { count: 0 };
      Object.assign(row, data, { updatedAt: new Date(row.updatedAt.getTime() + 1) });
      return { count: 1 };
    },
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      const row = [...store.rows.values()].find(row => matches(row, where));
      if (!row) return { count: 0 }; store.rows.delete(row.id); return { count: 1 };
    },
  },
  ardentAgentOperation: {
    findFirst: async ({ where }: { where: { nodeId: string; profile: string; status: string } }) =>
      store.operations.find(item => item.nodeId === where.nodeId && item.profile === where.profile && item.status === where.status) ?? null,
    findMany: async () => [...store.operations].filter(item => item.status === 'succeeded')
      .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0)),
  },
}) }));
vi.mock('./audit-service.js', () => ({ logAuditEvent: async (event: typeof store.audit[number]) => { store.audit.push(event); } }));
vi.mock('./notification-service.js', () => ({ createNotification: async (input: typeof store.notifications[number]) => { store.notifications.push(input); return 'n1'; } }));

const renewal = await import('./ardent-hivemem-renewal.js');
const { AgentResponseError } = await import('../sdk/node-api-client.js');
const { HiveMemEnrollmentError } = await import('./ardent-hivemem.js');

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJmaXh0dXJlIjp0cnVlfQ.fixture-signature-value';
const HOUR = 3_600_000;
const START = new Date('2026-11-01T00:00:00.000Z');
const settings = { apiUrl: 'https://hivemem.example.com/', agentUrl: 'https://hivemem.example.com/', auth: { kind: 'token' as const, token: 'fixture' },
  workspaceId: 'ardent-agents', hours: 720 };
let now: Date;
let running: boolean;
let profilePresent: boolean;
let reloadSupported: boolean;
let actions: string[];
let delivered: string[];
const credential = vi.fn();
const supportsRenewal = vi.fn();
let restore: () => void;

beforeEach(() => {
  store.rows.clear();
  store.operations.length = 0;
  store.audit.length = 0;
  store.notifications.length = 0;
  now = START;
  running = true;
  profilePresent = true;
  reloadSupported = true;
  actions = [];
  delivered = [];
  credential.mockReset();
  credential.mockImplementation(async (_settings: unknown, plan: { agentId: string; expiresAt: string }) =>
    ({ token: TOKEN, agentId: plan.agentId, expiresAt: plan.expiresAt, operationId: 'e'.repeat(64) }));
  supportsRenewal.mockReset();
  supportsRenewal.mockResolvedValue(true);
  restore = renewal.setArdentHiveMemRenewalDeps({
    settings: () => settings,
    supportsRenewal,
    credential,
    installation: async nodeId => ({ nodeId, nodeName: 'node-1', hostname: 'node-1.example.com', reachable: true, installed: true, version: '2.2.0',
      owner: 'operator', checkedAt: now.toISOString(), error: null,
      profiles: profilePresent ? [{ id: 'lead', name: 'lead', backend: 'llamacpp', apiPort: 9910, running, a2aEnabled: false, channels: {}, error: null }] : [] }),
    read: async <T,>() => ({ status: 'ready' }) as T,
    action: async (_nodeId, _profile, action, _target, body) => {
      actions.push(action);
      if (action === 'hivemem-credential-reload' && !reloadSupported) throw new AgentResponseError(404, null);
      if (action === 'hivemem-credential-set') delivered.push((body as { token: string }).token);
      return {};
    },
    delay: async () => undefined,
    now: () => now,
  });
});
afterEach(() => restore());

async function enrolled(expiresInHours = 720): Promise<Row> {
  await renewal.recordArdentHiveMemCredential({ nodeId: 'node-1', profile: 'lead', agentId: 'ardent-lead-0000', workspaceId: 'ardent-agents',
    expiresAt: new Date(now.getTime() + expiresInHours * HOUR).toISOString() });
  return [...store.rows.values()][0]!;
}

describe('Ardent HiveMem credential renewal', () => {
  it('schedules renewal at half the lifetime and backs off failures up to six hours', () => {
    expect(renewal.renewalDueAt(START, new Date(START.getTime() + 720 * HOUR)).toISOString()).toBe(new Date(START.getTime() + 360 * HOUR).toISOString());
    expect(renewal.renewalDueAt(START, new Date(START.getTime() - HOUR)).getTime()).toBe(START.getTime());
    expect([1, 2, 3, 4, 5, 6, 7, 40].map(failures => (renewal.renewalRetryAt(START, failures).getTime() - START.getTime()) / 60_000))
      .toEqual([15, 30, 60, 120, 240, 360, 360, 360]);
  });

  it('renews nothing before half the lifetime, then renews, delivers, reloads and records the new deadline', async () => {
    const row = await enrolled();
    expect(row.nextAttemptAt.toISOString()).toBe(new Date(START.getTime() + 360 * HOUR).toISOString());
    now = new Date(START.getTime() + 359 * HOUR);
    expect(await renewal.renewDueArdentHiveMemCredentials()).toEqual({ renewed: 0, failed: 0, untracked: 0, skipped: 0 });
    expect(credential).not.toHaveBeenCalled();

    now = new Date(START.getTime() + 361 * HOUR);
    expect(await renewal.renewDueArdentHiveMemCredentials()).toMatchObject({ renewed: 1, failed: 0 });
    const plan = credential.mock.calls[0]![1] as { action: string; agentId: string; workspaceId: string; graceSeconds: number; key: string; displayName: string };
    expect(plan).toMatchObject({ action: 'renew', agentId: 'ardent-lead-0000', workspaceId: 'ardent-agents', graceSeconds: 86_400, displayName: 'Ardent lead on node-1' });
    expect(actions).toEqual(['hivemem-credential-set', 'hivemem-credential-reload']);
    expect(delivered).toEqual([TOKEN]);
    const updated = store.rows.get(row.id)!;
    expect(updated.expiresAt.getTime()).toBe(now.getTime() + 720 * HOUR - 60_000);
    expect(updated.lastRenewedAt?.toISOString()).toBe(now.toISOString());
    expect(updated.nextAttemptAt.getTime()).toBe(now.getTime() + (720 * HOUR - 60_000) / 2);
    expect(updated).toMatchObject({ failures: 0, lastError: null, leaseUntil: null, renewals: 1 });
    const audit = store.audit.find(event => event.action === 'ardent.hivemem.renew');
    expect(audit).toMatchObject({ actorId: 'system:ardent-hivemem-renewal', targetId: 'node-1:lead',
      details: { status: 'succeeded', activation: 'reloaded', agentId: 'ardent-lead-0000', previousExpiresAt: new Date(START.getTime() + 720 * HOUR).toISOString() } });
    expect(JSON.stringify(store.audit)).not.toContain(TOKEN);
    expect(store.notifications).toEqual([]);
  });

  it('restarts a running profile on an Ardent without credential reload, and leaves a stopped one to read it at start', async () => {
    await enrolled();
    now = new Date(START.getTime() + 361 * HOUR);
    reloadSupported = false;
    await renewal.renewDueArdentHiveMemCredentials();
    expect(actions).toEqual(['hivemem-credential-set', 'hivemem-credential-reload', 'service-restart']);
    expect(store.audit.at(-1)?.details).toMatchObject({ activation: 'restarted' });

    actions = [];
    running = false;
    now = new Date(now.getTime() + 400 * HOUR);
    await renewal.renewDueArdentHiveMemCredentials();
    expect(actions).toEqual(['hivemem-credential-set']);
    expect(store.audit.at(-1)?.details).toMatchObject({ activation: 'deferred' });
  });

  it('records a failure, retries with backoff, alerts, and goes critical near the deadline', async () => {
    const row = await enrolled();
    credential.mockRejectedValue(new HiveMemEnrollmentError(503, 'HiveMem renew answered HTTP 503'));
    now = new Date(START.getTime() + 361 * HOUR);
    expect(await renewal.renewDueArdentHiveMemCredentials()).toMatchObject({ failed: 1 });
    let current = store.rows.get(row.id)!;
    expect(current).toMatchObject({ failures: 1, leaseUntil: null, lastAttemptAt: now });
    expect(current.lastError).toContain('HTTP 503');
    expect(current.nextAttemptAt.getTime()).toBe(now.getTime() + 60_000);
    expect(renewal.ardentHiveMemCredentialStatus(current, now)).toMatchObject({ state: 'renewal-failing', failures: 1 });
    expect(store.notifications.at(-1)).toMatchObject({ type: 'ardent.hivemem.renewal_failed', severity: 'warning', sourceRef: 'ardent-hivemem:node-1:lead' });
    expect(store.audit.at(-1)).toMatchObject({ action: 'ardent.hivemem.renew', details: { status: 'failed', failures: 1 } });
    expect(actions).toEqual([]);

    // Not due again until the backoff passes.
    now = new Date(now.getTime() + 30_000);
    expect(await renewal.renewDueArdentHiveMemCredentials()).toMatchObject({ failed: 0, renewed: 0 });
    now = new Date(now.getTime() + 31_000);
    await renewal.renewDueArdentHiveMemCredentials();
    current = store.rows.get(row.id)!;
    expect(current.failures).toBe(2);
    expect(current.nextAttemptAt.getTime()).toBe(now.getTime() + 60_000);

    // Within three days of the deadline the alert is critical; after it the credential reads as expired.
    now = new Date(START.getTime() + 700 * HOUR);
    store.rows.get(row.id)!.nextAttemptAt = now;
    await renewal.renewDueArdentHiveMemCredentials();
    expect(store.notifications.at(-1)?.severity).toBe('critical');
    expect(renewal.ardentHiveMemCredentialStatus(store.rows.get(row.id)!, new Date(START.getTime() + 721 * HOUR)).state).toBe('expired');

    // A later success clears the failures.
    credential.mockImplementation(async (_settings: unknown, plan: { agentId: string; expiresAt: string }) =>
      ({ token: TOKEN, agentId: plan.agentId, expiresAt: plan.expiresAt, operationId: 'e'.repeat(64) }));
    store.rows.get(row.id)!.nextAttemptAt = now;
    expect(await renewal.renewDueArdentHiveMemCredentials()).toMatchObject({ renewed: 1 });
    expect(store.rows.get(row.id)).toMatchObject({ failures: 0, lastError: null });
  });

  it('holds an expired receipt for explicit recovery, refuses older HiveMem, and never runs beside an operation or another claim', async () => {
    const row = await enrolled();
    now = new Date(START.getTime() + 361 * HOUR);
    credential.mockRejectedValueOnce(new HiveMemEnrollmentError(410, 'receipt expired'));
    await renewal.renewDueArdentHiveMemCredentials();
    const keys = credential.mock.calls.map(call => (call[1] as { key: string }).key);
    expect(keys).toHaveLength(1);
    expect(store.rows.get(row.id)).toMatchObject({ renewals: 0, recoveryRequired: true });
    now = new Date(now.getTime() + HOUR);
    expect(await renewal.renewDueArdentHiveMemCredentials()).toMatchObject({ renewed: 0, failed: 0 });
    expect(credential).toHaveBeenCalledTimes(1);
    store.rows.get(row.id)!.recoveryRequired = false;

    credential.mockClear();
    now = new Date(now.getTime() + 400 * HOUR);
    supportsRenewal.mockResolvedValue(false);
    await renewal.renewDueArdentHiveMemCredentials();
    expect(credential).not.toHaveBeenCalled();
    expect(store.rows.get(row.id)!.lastError).toContain('HIVEMEM_RENEWAL_UNSUPPORTED');

    supportsRenewal.mockResolvedValue(true);
    store.rows.get(row.id)!.nextAttemptAt = now;
    store.operations.push({ nodeId: 'node-1', profile: 'lead', status: 'running', stepsJson: '[]', completedAt: null });
    expect(await renewal.renewDueArdentHiveMemCredentials()).toMatchObject({ skipped: 1, renewed: 0 });
    store.operations.length = 0;
    store.rows.get(row.id)!.leaseUntil = new Date(now.getTime() + 60_000);
    expect(await renewal.renewDueArdentHiveMemCredentials()).toMatchObject({ skipped: 1, renewed: 0 });
    expect(credential).not.toHaveBeenCalled();
  });

  it('replays the full frozen plan across a worker restart and setting/name drift', async () => {
    const row = await enrolled();
    now = new Date(START.getTime() + 361 * HOUR);
    credential.mockRejectedValueOnce(new Error('response lost'));
    await renewal.renewDueArdentHiveMemCredentials();
    const first = structuredClone(credential.mock.calls[0]![1]);
    expect(JSON.parse(store.rows.get(row.id)!.pendingJson!).plan).toEqual(first);
    // Replace all process-local dependencies; only the database survives.
    restore();
    now = new Date(now.getTime() + 2 * 60_000);
    restore = renewal.setArdentHiveMemRenewalDeps({ settings: () => ({ ...settings, hours: 24 }), now: () => now,
      supportsRenewal, credential,
      installation: async nodeId => ({ nodeId, nodeName: 'renamed', hostname: 'node-1.example.com', reachable: true, installed: true,
        checkedAt: now.toISOString(), profiles: [{ id: 'lead', running: false }] }) as never,
      action: async () => ({}) });
    expect(await renewal.renewDueArdentHiveMemCredentials()).toMatchObject({ renewed: 1 });
    expect(credential.mock.calls[1]![1]).toEqual(first);
    expect(store.rows.get(row.id)).toMatchObject({ pendingJson: null, renewals: 1 });
  });

  it('holds a digest conflict without advancing the key and raises a critical recovery notification', async () => {
    const row = await enrolled(); now = new Date(START.getTime() + 361 * HOUR);
    credential.mockRejectedValue(new HiveMemEnrollmentError(409, 'Operation belongs to another operator or policy'));
    expect(await renewal.renewDueArdentHiveMemCredentials()).toMatchObject({ failed: 1 });
    expect(store.rows.get(row.id)).toMatchObject({ recoveryRequired: true, renewals: 0 });
    expect(store.notifications.at(-1)).toMatchObject({ severity: 'critical' });
    now = new Date(now.getTime() + HOUR);
    expect(await renewal.renewDueArdentHiveMemCredentials()).toMatchObject({ failed: 0, renewed: 0 });
    expect(credential).toHaveBeenCalledTimes(1);
  });

  it('adoption never resets an existing pending renewal or its recovery hold', async () => {
    const row = await enrolled();
    row.pendingJson = '{"fixture":"pending"}'; row.recoveryRequired = true;
    await renewal.recordArdentHiveMemCredential({ nodeId: row.nodeId, profile: row.profile, agentId: 'older-enrollment',
      workspaceId: 'default', expiresAt: new Date(now.getTime() + HOUR).toISOString(), adopt: true });
    expect(store.rows.get(row.id)).toMatchObject({ agentId: row.agentId, pendingJson: '{"fixture":"pending"}', recoveryRequired: true });
  });

  it('does not overwrite a replacement enrollment when an old worker returns', async () => {
    await enrolled();
    now = new Date(START.getTime() + 361 * HOUR);
    credential.mockImplementationOnce(async () => {
      await renewal.recordArdentHiveMemCredential({ nodeId: 'node-1', profile: 'lead', agentId: 'replacement', workspaceId: 'ardent-agents',
        expiresAt: new Date(now.getTime() + 48 * HOUR).toISOString() });
      return { token: TOKEN, agentId: 'ardent-lead-0000', expiresAt: new Date(now.getTime() + 720 * HOUR).toISOString(), operationId: 'e'.repeat(64) };
    });
    expect(await renewal.renewDueArdentHiveMemCredentials()).toMatchObject({ skipped: 1 });
    expect(delivered).toEqual([]);
    expect([...store.rows.values()][0]).toMatchObject({ agentId: 'replacement', renewals: 0, pendingJson: null });
  });

  it('stops tracking a profile removed from its node, and does nothing without HiveMem settings', async () => {
    const row = await enrolled();
    now = new Date(START.getTime() + 361 * HOUR);
    restore();
    restore = renewal.setArdentHiveMemRenewalDeps({ settings: () => null, now: () => now });
    expect(await renewal.renewDueArdentHiveMemCredentials()).toEqual({ renewed: 0, failed: 0, untracked: 0, skipped: 0 });
    restore();
    restore = renewal.setArdentHiveMemRenewalDeps({ settings: () => settings, supportsRenewal, credential, now: () => now,
      installation: async nodeId => ({ nodeId, nodeName: 'node-1', hostname: 'node-1.example.com', reachable: true, installed: true, version: '2.2.0',
        owner: 'operator', checkedAt: now.toISOString(), error: null, profiles: [] }) });
    expect(await renewal.renewDueArdentHiveMemCredentials()).toMatchObject({ untracked: 1 });
    expect(store.rows.has(row.id)).toBe(false);
    expect(store.audit.at(-1)).toMatchObject({ action: 'ardent.hivemem.untrack', targetId: 'node-1:lead' });
    expect(credential).not.toHaveBeenCalled();
  });

  it('adopts profiles enrolled before credentials were recorded, from their latest enrollment receipt', async () => {
    const step = (agentId: string, expiresAt: string) => JSON.stringify([{ name: 'hivemem-enroll', status: 'succeeded', finishedAt: '2026-10-20T00:00:00.000Z',
      receipt: { agentId, workspaceId: 'ardent-agents', expiresAt } }]);
    store.operations.push({ nodeId: 'node-1', profile: 'lead', status: 'succeeded', stepsJson: step('ardent-lead-old', '2026-11-10T00:00:00.000Z'), completedAt: new Date('2026-10-01') });
    store.operations.push({ nodeId: 'node-1', profile: 'lead', status: 'succeeded', stepsJson: step('ardent-lead-new', '2026-11-19T00:00:00.000Z'), completedAt: new Date('2026-10-20') });
    store.operations.push({ nodeId: 'node-1', profile: 'other', status: 'succeeded', stepsJson: '[]', completedAt: new Date('2026-10-20') });
    // An already expired credential cannot be renewed, so it is not adopted.
    store.operations.push({ nodeId: 'node-1', profile: 'expired', status: 'succeeded', stepsJson: step('ardent-expired', '2026-10-30T00:00:00.000Z'), completedAt: new Date('2026-10-01') });
    expect(await renewal.adoptEnrolledArdentProfiles()).toBe(1);
    expect(await renewal.adoptEnrolledArdentProfiles()).toBe(0);
    const [row] = [...store.rows.values()];
    expect(row).toMatchObject({ agentId: 'ardent-lead-new', expiresAt: new Date('2026-11-19T00:00:00.000Z') });
    expect(row!.nextAttemptAt.toISOString()).toBe('2026-11-04T00:00:00.000Z');
  });

  it('reports each profile\'s credential status by node and profile', async () => {
    await enrolled(48);
    const statuses = await renewal.ardentHiveMemCredentialStatuses(['node-1', 'node-2']);
    expect(statuses.get('node-1:lead')).toEqual({ agentId: 'ardent-lead-0000', workspaceId: 'ardent-agents',
      expiresAt: new Date(START.getTime() + 48 * HOUR).toISOString(), lastRenewedAt: null, lastAttemptAt: null,
      nextRenewalAt: new Date(START.getTime() + 24 * HOUR).toISOString(), failures: 0, lastError: null, state: 'ok' });
    expect(statuses.has('node-2:lead')).toBe(false);
    expect((await renewal.ardentHiveMemCredentialStatuses([])).size).toBe(0);
  });
});
