import { createHmac } from 'node:crypto';
import { HTTPError } from 'ky';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// These cases exercise shared-secret paths, which 3.0.0 keeps only under an explicit NODE_AUTH_MODE=compat (or warn).
beforeEach(() => { process.env['NODE_AUTH_MODE'] = 'compat'; });
afterEach(() => { delete process.env['NODE_AUTH_MODE']; });
import { verifyNodeDecision } from './server-authorization.js';
// Evidence policy: a node without a key, so the shared result key applies (docs/NODE_CREDENTIALS.md).
vi.mock('./node-credential-store.js', async () => ({ nodeCredentialStore: (await import('./node-credential-test-fixture.js')).createFakeCredentialStore().store }));


type Lease = { commandId: string; nodeId: string; state: string; label: string | null; completionDescriptorId: string | null; completionClass?: string | null;
  requestSha256: string; coordinationJson: string; acquiredAt: Date; dispatchedAt: Date | null; deadline: Date;
  settlement: string | null; evidenceSha256: string | null };
const RECONCILE_KEY = 'fixture-command-reconciliation-key-0123456789';
const state = vi.hoisted(() => ({
  leases: new Map<string, Lease>(),
  audit: [] as Array<{ action: string; actorId: string; details: Record<string, unknown> }>,
  receipt: vi.fn(), reconcile: vi.fn(), inventory: vi.fn(), recover: vi.fn(),
  decisions: { serverSignatures: false, hmac: true },
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
  // Obviously fake fixture keys, repeated characters only.
  RESULT_SIGNING_SECRET: 'r'.repeat(40), RESULT_SIGNING_PREVIOUS_SECRET: '',
  API_SECRET: 'p'.repeat(40), getNodeManagerSecret: () => 'n'.repeat(40) }));
vi.mock('../sdk/node-api-client.js', async original => {
  const actual = await original<typeof import('../sdk/node-api-client.js')>();
  class NodeApiClient {
    getCommandReceipt(commandId: string, expected: unknown) { return state.receipt(commandId, expected); }
    reconcileCommandReceipt(assertion: unknown, expected: unknown) { return state.reconcile(assertion, expected); }
    getArdentState() { return state.inventory(); }
    async decisionCapabilities() { return state.decisions; }
  }
  return { ...actual, NodeApiClient };
});
vi.mock('./agent-upgrade-preflight.js', () => ({ recoverNodeLeases: state.recover }));
vi.mock('./audit-service.js', () => ({ logAuditEvent: async (event: { action: string; actorId: string; details: Record<string, unknown> }) => { state.audit.push(event); } }));

const { reconcileCommandOwner } = await import('./command-owner-reconcile.js');
const { commandReconciliationSigningPayload } = await import('../sdk/node-api-client.js');

/**
 * The same decision as the Ardent command-reconcile action, for any other
 * command: a plain command whose node holds an unknown outcome (for example one
 * an older agent ran in its supervisor and then refused) is settled only by the
 * node's evidence or by an ADMIN's server-signed decision.
 */
const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const coordination = { version: 1, resourceKey: 'node:node-1', fence: '7', expiresAt: NOW - 120_000 };
const actor = { actorId: 'alice', details: {} };
const scope = { kind: 'command' as const, audit: 'command.resource_reconcile' as const };
const decision = { disposition: 'no_effect_verified' as const, reason: 'Read-only uptime probe; the agent refused it and nothing changed.' };
function lease(overrides: Partial<Lease> = {}): Lease {
  return { commandId: 'plain-1', nodeId: 'node-1', state: 'unknown', label: null, completionDescriptorId: null,
    requestSha256: 'a'.repeat(64), coordinationJson: JSON.stringify(coordination), acquiredAt: new Date(NOW - 300_000),
    dispatchedAt: new Date(NOW - 299_000), deadline: new Date(NOW - 120_000), settlement: null, evidenceSha256: null, ...overrides };
}
function settle(settlement: string) {
  Object.assign(state.leases.get('plain-1')!, { state: 'released', settlement, evidenceSha256: 'b'.repeat(64) });
}

beforeEach(() => {
  state.leases.clear();
  state.audit.length = 0;
  for (const mock of [state.receipt, state.reconcile, state.inventory, state.recover]) mock.mockReset();
  vi.stubEnv('COMMAND_RECONCILIATION_SECRET', RECONCILE_KEY);
  state.leases.set('plain-1', lease());
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('reconciling a non-Ardent command owner', () => {
  it('signs an ADMIN no-effect decision bound to the exact request and audits it as command.resource_reconcile', async () => {
    state.receipt.mockResolvedValue({ commandId: 'plain-1', requestSha256: 'a'.repeat(64), state: 'unknown' });
    state.reconcile.mockImplementation(async () => { settle('signed-reconciliation:no_effect_verified'); return { state: 'reconciled' }; });
    const result = await reconcileCommandOwner('plain-1', decision, actor, scope, NOW);
    expect(result).toMatchObject({ commandId: 'plain-1', outcome: 'settled', receipt: 'unknown', settlement: 'signed-reconciliation:no_effect_verified' });
    const [assertion, expected] = state.reconcile.mock.calls[0]! as [Record<string, unknown> & { signature: string }, unknown];
    expect(expected).toEqual({ nodeFqdn: 'node-1.example.com', requestSha256: 'a'.repeat(64) });
    expect(assertion).toMatchObject({ nodeFqdn: 'node-1.example.com', commandId: 'plain-1', requestSha256: 'a'.repeat(64), coordination,
      disposition: 'no_effect_verified', decisionId: result.decisionId, approvalRef: `magnus:command-reconcile:${result.decisionId}` });
    const { signature, ...unsigned } = assertion;
    expect(signature).toBe(createHmac('sha256', RECONCILE_KEY).update(commandReconciliationSigningPayload(unsigned as never)).digest('hex'));
    // No Ardent inventory is read for a plain command.
    expect(state.inventory).not.toHaveBeenCalled();
    expect(state.audit).toEqual([expect.objectContaining({ action: 'command.resource_reconcile', actorId: 'alice', targetId: 'plain-1',
      details: expect.objectContaining({ nodeId: 'node-1', outcome: 'settled', disposition: 'no_effect_verified', reason: decision.reason, decisionId: result.decisionId }) })]);
  });

  it('signs with the server key for an agent with a node key', async () => {
    vi.stubEnv('COMMAND_RECONCILIATION_SECRET', '');
    state.decisions = { serverSignatures: true, hmac: false };
    try {
      state.receipt.mockResolvedValue({ commandId: 'plain-1', requestSha256: 'a'.repeat(64), state: 'unknown' });
      state.reconcile.mockImplementation(async () => { settle('signed-reconciliation:no_effect_verified'); return { state: 'reconciled' }; });
      expect(await reconcileCommandOwner('plain-1', decision, actor, scope, NOW)).toMatchObject({ outcome: 'settled' });
      const [assertion] = state.reconcile.mock.calls[0]! as [Record<string, unknown>];
      const { serverSignature, ...unsigned } = assertion as { serverSignature: unknown };
      expect(assertion['signature']).toBeUndefined();
      expect(verifyNodeDecision('node-1', 'command-reconciliation', commandReconciliationSigningPayload(unsigned as never), assertion)).toBe(true);
      expect(serverSignature).toMatchObject({ alg: 'ed25519', nodeId: 'node-1' });
    } finally { state.decisions = { serverSignatures: false, hmac: true }; }
  });

  it('prefers the node\'s own evidence and never signs over a completed or still running command', async () => {
    state.receipt.mockImplementationOnce(async () => { settle('signed-command-result'); return { state: 'completed' }; });
    expect(await reconcileCommandOwner('plain-1', decision, actor, scope, NOW)).toMatchObject({ outcome: 'settled', receipt: 'completed', decisionId: null });
    expect(await reconcileCommandOwner('plain-1', decision, actor, scope, NOW)).toMatchObject({ outcome: 'already-settled' });
    state.leases.set('plain-1', lease());
    state.receipt.mockResolvedValue({ commandId: 'plain-1', requestSha256: 'a'.repeat(64), state: 'running' });
    await expect(reconcileCommandOwner('plain-1', decision, actor, scope, NOW)).rejects.toMatchObject({ code: 'COMMAND_IN_PROGRESS' });
    expect(state.reconcile).not.toHaveBeenCalled();
  });

  it('refuses before the deadline margin, an unknown command, and an Ardent action', async () => {
    state.leases.set('plain-1', lease({ deadline: new Date(NOW - 30_000) }));
    await expect(reconcileCommandOwner('plain-1', decision, actor, scope, NOW)).rejects.toMatchObject({ code: 'COMMAND_IN_PROGRESS' });
    await expect(reconcileCommandOwner('missing', decision, actor, scope, NOW)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    state.leases.set('plain-1', lease({ completionDescriptorId: 'ardent-action', label: 'ardent:ember:service-start' }));
    await expect(reconcileCommandOwner('plain-1', decision, actor, scope, NOW)).rejects.toMatchObject({ code: 'ARDENT_COMMAND' });
    expect(state.receipt).not.toHaveBeenCalled();
    expect(state.leases.get('plain-1')!.state).toBe('unknown');
    expect(state.audit.map(event => [event.action, event.details['outcome'], event.details['code']])).toEqual([
      ['command.resource_reconcile', 'refused', 'COMMAND_IN_PROGRESS'], ['command.resource_reconcile', 'refused', 'NOT_FOUND'],
      ['command.resource_reconcile', 'refused', 'ARDENT_COMMAND']]);
  });

  it.each([
    ['a managed scheduler occurrence', { completionClass: 'managed-scheduler' }],
    ['a skill publication', { completionDescriptorId: 'skill-install', completionClass: 'native-http' }],
  ])('never takes a decision for %s, which settles only from its own retained evidence', async (_name, overrides) => {
    state.leases.set('plain-1', lease(overrides));
    state.receipt.mockResolvedValue({ commandId: 'plain-1', requestSha256: 'a'.repeat(64), state: 'unknown' });
    await expect(reconcileCommandOwner('plain-1', decision, actor, scope, NOW)).rejects.toMatchObject({ status: 409, code: 'RETAINED_EVIDENCE_REQUIRED' });
    expect(state.receipt).not.toHaveBeenCalled();
    expect(state.reconcile).not.toHaveBeenCalled();
    expect(state.leases.get('plain-1')!.state).toBe('unknown');
    expect(state.audit).toEqual([expect.objectContaining({ action: 'command.resource_reconcile',
      details: expect.objectContaining({ outcome: 'refused', code: 'RETAINED_EVIDENCE_REQUIRED' }) })]);
  });

  it('settles a command with no receipt only when the signed ledger trace proves it never ran', async () => {
    const notFound = () => new HTTPError(new Response('{}', { status: 404 }), new Request('https://node-1.example.com/'), {} as never);
    state.receipt.mockRejectedValue(notFound());
    state.recover.mockResolvedValueOnce([{ commandId: 'plain-1', outcome: 'unverified', code: 'LEDGER_NO_FENCE', detail: 'no fence' }]);
    await expect(reconcileCommandOwner('plain-1', decision, actor, scope, NOW)).rejects.toMatchObject({ code: 'RECEIPT_ABSENT_UNPROVEN',
      message: expect.stringContaining('LEDGER_NO_FENCE: no fence') });
    expect(state.leases.get('plain-1')!.state).toBe('unknown');
    state.recover.mockImplementationOnce(async () => { settle('not-dispatched'); return [{ commandId: 'plain-1', outcome: 'settled' }]; });
    expect(await reconcileCommandOwner('plain-1', decision, actor, scope, NOW)).toMatchObject({ outcome: 'settled', receipt: 'absent',
      settlement: 'not-dispatched', decisionId: null });
    expect(state.recover).toHaveBeenCalledWith('node-1', 'alice', NOW);
    // A missing receipt is never covered by a signed decision.
    expect(state.reconcile).not.toHaveBeenCalled();
    expect(state.audit.map(event => event.details['outcome'])).toEqual(['refused', 'settled']);
  });
});
