import { createHmac } from 'node:crypto';
import { HTTPError } from 'ky';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Lease = { commandId: string; nodeId: string; state: string; label: string | null; completionDescriptorId: string | null;
  requestSha256: string; coordinationJson: string; acquiredAt: Date; dispatchedAt: Date | null; deadline: Date;
  settlement: string | null; evidenceSha256: string | null };
const RECONCILE_KEY = 'fixture-command-reconciliation-key-0123456789';
const state = vi.hoisted(() => ({
  leases: new Map<string, Lease>(),
  audit: [] as Array<{ action: string; actorId: string; details: Record<string, unknown> }>,
  receipt: vi.fn(), reconcile: vi.fn(), inventory: vi.fn(), recover: vi.fn(),
}));
vi.mock('../db/index.js', () => ({ getDb: () => ({
  commandResourceLease: {
    findUnique: async ({ where }: { where: { commandId: string } }) => { const row = state.leases.get(where.commandId); return row ? { ...row } : null; },
    findUniqueOrThrow: async ({ where }: { where: { commandId: string } }) => ({ ...state.leases.get(where.commandId)! }),
    findFirst: async ({ where }: { where: { nodeId: string; state: { in: string[] } } }) =>
      [...state.leases.values()].find(row => row.nodeId === where.nodeId && where.state.in.includes(row.state)) ?? null,
    findMany: async ({ where }: { where: { nodeId: { in: string[] }; state: { in: string[] } } }) =>
      [...state.leases.values()].filter(row => where.nodeId.in.includes(row.nodeId) && where.state.in.includes(row.state)),
  },
  node: { findUnique: async ({ where }: { where: { id: string } }) => where.id === 'node-1'
    ? { id: 'node-1', hostname: 'node-1.example.com', ipAddress: '192.0.2.10', port: 4100 } : null },
}) }));
vi.mock('../utils/env.js', async original => ({ ...await original<typeof import('../utils/env.js')>(),
  RESULT_SIGNING_SECRET: 'fixture-result-signing-secret-0123456789', RESULT_SIGNING_PREVIOUS_SECRET: '',
  API_SECRET: 'fixture-api-secret-0123456789-0123456789', getNodeManagerSecret: () => 'fixture-node-manager-secret-0123456789' }));
vi.mock('../sdk/node-api-client.js', async original => {
  const actual = await original<typeof import('../sdk/node-api-client.js')>();
  class NodeApiClient {
    getCommandReceipt(commandId: string, expected: unknown) { return state.receipt(commandId, expected); }
    reconcileCommandReceipt(assertion: unknown, expected: unknown) { return state.reconcile(assertion, expected); }
    getArdentState() { return state.inventory(); }
  }
  return { ...actual, NodeApiClient };
});
vi.mock('./agent-upgrade-preflight.js', () => ({ recoverNodeLeases: state.recover }));
vi.mock('./audit-service.js', () => ({ logAuditEvent: async (event: { action: string; actorId: string; details: Record<string, unknown> }) => { state.audit.push(event); } }));

const owners = await import('./ardent-command-owner.js');
const { commandReconciliationSigningPayload } = await import('../sdk/node-api-client.js');

const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const coordination = { version: 1, resourceKey: 'node:node-1:ardent', fence: '7', expiresAt: NOW - 120_000 };
const actor = { actorId: 'alice', details: {} };
const decision = { disposition: 'effects_verified' as const, reason: 'Unit is active; profile answers on its port.' };
function lease(overrides: Partial<Lease> = {}): Lease {
  return { commandId: 'native-1', nodeId: 'node-1', state: 'unknown', label: 'ardent:ember:service-start', completionDescriptorId: 'ardent-action',
    requestSha256: 'a'.repeat(64), coordinationJson: JSON.stringify(coordination), acquiredAt: new Date(NOW - 300_000),
    dispatchedAt: new Date(NOW - 299_000), deadline: new Date(NOW - 120_000), settlement: null, evidenceSha256: null, ...overrides };
}
function settle(settlement: string) {
  const row = state.leases.get('native-1')!;
  Object.assign(row, { state: 'released', settlement, evidenceSha256: 'b'.repeat(64) });
}
const notFound = () => new HTTPError(new Response('{}', { status: 404 }), new Request('https://node-1.example.com/'), {} as never);

beforeEach(() => {
  state.leases.clear();
  state.audit.length = 0;
  for (const mock of [state.receipt, state.reconcile, state.inventory, state.recover]) mock.mockReset();
  state.inventory.mockResolvedValue({ success: true, data: { installed: true, profiles: [] } });
  vi.stubEnv('COMMAND_RECONCILIATION_SECRET', RECONCILE_KEY);
  state.leases.set('native-1', lease());
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('Ardent command owners', () => {
  it('lists held owners per node with the action they ran', async () => {
    state.leases.set('native-2', lease({ commandId: 'native-2', nodeId: 'node-2', state: 'released' }));
    const listed = await owners.ardentCommandOwners(['node-1', 'node-2']);
    expect(listed.get('node-1')).toEqual([expect.objectContaining({ commandId: 'native-1', state: 'unknown', profile: 'ember', action: 'service-start',
      ardent: true, reconcilableAfter: new Date(NOW - 60_000).toISOString() })]);
    expect(listed.get('node-2')).toEqual([]);
  });

  it('explains a block by the owner that causes it', async () => {
    const tagged = Object.defineProperty(new Error('Request failed with status code 409'), 'managedCommandId', { value: 'native-1' });
    expect(await owners.ardentOwnerBlock('node-1', tagged)).toMatchObject({ status: 409, code: 'ARDENT_OUTCOME_UNKNOWN',
      message: expect.stringMatching(/^The node could not confirm the outcome of service-start on ember \(command native-1\)\. An ADMIN must/) });
    const { HttpError } = await import('../middleware/error-handler.js');
    expect(await owners.ardentOwnerBlock('node-1', new HttpError(409, 'RESOURCE_LEASE_CONFLICT', 'held'))).toMatchObject({ code: 'RESOURCE_LEASE_CONFLICT',
      message: expect.stringMatching(/^Ardent actions on this node wait for service-start on ember/) });
    expect(await owners.ardentOwnerBlock('node-1', new Error('unrelated'))).toBeUndefined();
    settle('signed-command-result');
    // A failure that settled its own owner is not a block.
    expect(await owners.ardentOwnerBlock('node-1', tagged)).toBeUndefined();
  });

  it('records an ADMIN decision about an unknown outcome as a signed reconciliation bound to the exact request', async () => {
    state.receipt.mockResolvedValue({ commandId: 'native-1', requestSha256: 'a'.repeat(64), state: 'unknown' });
    state.reconcile.mockImplementation(async () => { settle('signed-reconciliation:effects_verified'); return { state: 'reconciled' }; });
    const result = await owners.reconcileArdentCommandOwner('node-1', 'native-1', decision, actor, NOW);
    expect(result).toMatchObject({ commandId: 'native-1', outcome: 'settled', receipt: 'unknown', settlement: 'signed-reconciliation:effects_verified' });
    const [assertion, expected] = state.reconcile.mock.calls[0]! as [Record<string, unknown> & { signature: string }, unknown];
    expect(expected).toEqual({ nodeFqdn: 'node-1.example.com', requestSha256: 'a'.repeat(64) });
    expect(assertion).toMatchObject({ nodeFqdn: 'node-1.example.com', commandId: 'native-1', requestSha256: 'a'.repeat(64), coordination,
      disposition: 'effects_verified', decisionId: result.decisionId, approvalRef: `magnus:ardent-command-reconcile:${result.decisionId}` });
    const { signature, ...unsigned } = assertion;
    expect(signature).toBe(createHmac('sha256', RECONCILE_KEY).update(commandReconciliationSigningPayload(unsigned as never)).digest('hex'));
    expect(state.audit).toEqual([expect.objectContaining({ action: 'ardent.command-reconcile', actorId: 'alice',
      details: expect.objectContaining({ nodeId: 'node-1', outcome: 'settled', disposition: 'effects_verified', reason: decision.reason, decisionId: result.decisionId }) })]);
  });

  it('settles from the node\'s own result or decision without signing anything', async () => {
    state.receipt.mockImplementation(async () => { settle('signed-command-result'); return { state: 'completed' }; });
    expect(await owners.reconcileArdentCommandOwner('node-1', 'native-1', decision, actor, NOW)).toMatchObject({ outcome: 'settled', receipt: 'completed', decisionId: null });
    expect(state.reconcile).not.toHaveBeenCalled();
    expect(await owners.reconcileArdentCommandOwner('node-1', 'native-1', decision, actor, NOW)).toMatchObject({ outcome: 'already-settled' });
  });

  it('settles a missing receipt only when the signed ledger trace proves it never ran', async () => {
    state.receipt.mockRejectedValue(notFound());
    state.recover.mockResolvedValueOnce([{ commandId: 'native-1', outcome: 'unverified', code: 'LEDGER_NO_FENCE', detail: 'no fence' }]);
    await expect(owners.reconcileArdentCommandOwner('node-1', 'native-1', decision, actor, NOW)).rejects.toMatchObject({ code: 'RECEIPT_ABSENT_UNPROVEN',
      message: expect.stringContaining('LEDGER_NO_FENCE: no fence') });
    state.recover.mockImplementationOnce(async () => { settle('not-dispatched'); return [{ commandId: 'native-1', outcome: 'settled' }]; });
    expect(await owners.reconcileArdentCommandOwner('node-1', 'native-1', decision, actor, NOW)).toMatchObject({ outcome: 'settled', receipt: 'absent' });
    expect(state.reconcile).not.toHaveBeenCalled();
  });

  it('never releases what may still run, another node\'s owner, or a command that is not an Ardent action', async () => {
    state.leases.set('native-1', lease({ deadline: new Date(NOW - 30_000) }));
    await expect(owners.reconcileArdentCommandOwner('node-1', 'native-1', decision, actor, NOW)).rejects.toMatchObject({ code: 'COMMAND_IN_PROGRESS' });
    state.leases.set('native-1', lease());
    state.receipt.mockResolvedValue({ commandId: 'native-1', requestSha256: 'a'.repeat(64), state: 'running' });
    await expect(owners.reconcileArdentCommandOwner('node-1', 'native-1', decision, actor, NOW)).rejects.toMatchObject({ code: 'COMMAND_IN_PROGRESS' });
    await expect(owners.reconcileArdentCommandOwner('node-2', 'native-1', decision, actor, NOW)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    state.leases.set('native-1', lease({ completionDescriptorId: 'file-write' }));
    await expect(owners.reconcileArdentCommandOwner('node-1', 'native-1', decision, actor, NOW)).rejects.toMatchObject({ code: 'NOT_ARDENT_COMMAND' });
    expect(state.reconcile).not.toHaveBeenCalled();
    expect(state.leases.get('native-1')!.state).toBe('unknown');
    expect(state.audit.map(event => event.details['code'])).toEqual(['COMMAND_IN_PROGRESS', 'COMMAND_IN_PROGRESS', 'NOT_FOUND', 'NOT_ARDENT_COMMAND']);
  });

  it('needs an independent reconciliation key on the server and the node', async () => {
    state.receipt.mockResolvedValue({ commandId: 'native-1', requestSha256: 'a'.repeat(64), state: 'unknown' });
    vi.stubEnv('COMMAND_RECONCILIATION_SECRET', 'fixture-api-secret-0123456789-0123456789');
    await expect(owners.reconcileArdentCommandOwner('node-1', 'native-1', decision, actor, NOW)).rejects.toMatchObject({ code: 'RECONCILIATION_UNAVAILABLE' });
    vi.stubEnv('COMMAND_RECONCILIATION_SECRET', RECONCILE_KEY);
    state.reconcile.mockRejectedValue(new Error('Node does not support explicit command reconciliation'));
    await expect(owners.reconcileArdentCommandOwner('node-1', 'native-1', decision, actor, NOW)).rejects.toMatchObject({ code: 'RECONCILIATION_UNAVAILABLE',
      message: expect.stringMatching(/node agent has no COMMAND_RECONCILIATION_SECRET/) });
    expect(state.leases.get('native-1')!.state).toBe('unknown');
  });
});
