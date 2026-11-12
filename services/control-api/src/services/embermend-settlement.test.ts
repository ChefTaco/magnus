import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { embermendOperationSchema } from '@hivemagnus/magnus-contracts/embermend';
import { NodeApiClient, type CommandReceipt, type CommandReconciliationAssertion } from '../sdk/node-api-client.js';
const db = vi.hoisted(() => ({ operation: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() }, lease: { findUnique: vi.fn() } }));
vi.mock('../db/index.js', () => ({ getDb: () => ({ embermendOperation: db.operation, commandResourceLease: db.lease }) }));
vi.mock('../utils/env.js', async original => ({ ...await original<object>(), RESULT_SIGNING_SECRET: 'fixture-result-signing-secret-000000000000', getNodeManagerSecret: () => 'fixture-node-management-secret-0000000000' }));
vi.mock('./audit-service.js', () => ({ logAuditEvent: vi.fn(async () => undefined) }));
import { settleEmbermendOwner, observeOwnerSettlement } from './embermend-settlement.js';
const node = { id: 'fixture-node', hostname: 'node.example.com' };
const original = () => embermendOperationSchema.parse({ operationId: 'original', planId: 'original-plan', planRevision: 1, planDigest: 'a'.repeat(64), installationId: 'fixture-installation', authorizationRef: 'original-approval', expiresAt: new Date(Date.now() - 600000).toISOString(), action: { id: 'reboot', version: 'reboot.v1', class: 'reboot', targetId: 'fixture-target', targetKind: 'host', requiredCapabilities: ['embermend:reboot.v1'], parameters: {}, preconditions: { environment: 'lab' }, dependsOn: [], verificationIds: [], recovery: 'Separate approval', expectedRevision: null, patchDigest: null, disruption: 'reboot' } });
const request = () => embermendOperationSchema.parse({ ...original(), operationId: 'recovery', planId: 'recovery-plan', authorizationRef: 'recovery-approval', expiresAt: new Date(Date.now() + 240000).toISOString(), action: { ...original().action, id: 'settle', version: 'execution-settle.v1', class: 'recovery', disruption: 'none', requiredCapabilities: ['embermend:execution-settle.v1'], parameters: { originalOperationId: 'original', originalRequestDigest: 'b'.repeat(64), nativeCommandId: 'original-command', nativeRequestDigest: 'c'.repeat(64), evidenceId: 'review', evidenceDigest: 'd'.repeat(64), disposition: 'effects_verified', originalOutcome: 'unknown' } } });
let assertion: CommandReconciliationAssertion | undefined;
let acknowledged: boolean;
let retained: unknown;
const client = () => new NodeApiClient({ baseUrl: 'http://127.0.0.1:4100', nodeToken: 'fixture-node-management-secret-0000000000' });
const receipt = (): CommandReceipt => acknowledged && assertion ? { commandId: 'original-command', requestSha256: 'c'.repeat(64), state: 'reconciled', reconciliation: assertion } : { commandId: 'original-command', requestSha256: 'c'.repeat(64), state: 'unknown' };
beforeEach(() => {
  vi.stubEnv('COMMAND_RECONCILIATION_SECRET', 'fixture-separate-reconciliation-secret-00000'); vi.stubEnv('HIVE_REHEARSAL', 'false');
  assertion = undefined; acknowledged = false; retained = null; vi.clearAllMocks();
  db.operation.findUnique.mockResolvedValue({ id: 'original-row', operationId: 'original', commandId: 'original-command', requestDigest: 'b'.repeat(64), nodeId: node.id, request: original(), state: 'unknown' });
  db.operation.findUniqueOrThrow.mockImplementation(async () => ({ id: 'recovery-row', result: retained }));
  db.operation.update.mockImplementation(async (input: { data: { result?: unknown } }) => { if (input.data.result !== undefined) retained = input.data.result; return {}; });
  db.lease.findUnique.mockResolvedValue({ nodeId: node.id, requestSha256: 'c'.repeat(64), state: 'unknown', deadline: new Date(Date.now() - 600000), coordinationJson: JSON.stringify({ version: 1, resourceKey: 'node:fixture-node', fence: '3', expiresAt: Date.now() - 600000 }) });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe('explicit unknown-owner settlement', () => {
  it('persists the exact assertion before delivery and preserves unknown historical outcome', async () => {
    const api = client(); vi.spyOn(api, 'getCommandReceipt').mockImplementation(async () => receipt());
    const send = vi.spyOn(api, 'reconcileCommandReceipt').mockImplementation(async value => { expect(retained).toEqual({ assertion: value }); assertion = value; acknowledged = true; return receipt(); });
    const operation = request(); await settleEmbermendOwner('fixture-grant', operation, node, api);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await observeOwnerSettlement('fixture-grant', operation, node, api)).toMatchObject({ ownershipSettled: true, originalOutcome: 'unknown', originalOperationId: 'original' });
    expect(db.operation.update.mock.calls.every(([input]) => input.where.id === 'recovery-row' || input.where.integrationId_operationId.operationId === 'recovery')).toBe(true);
  });
  it('adopts a lost acknowledgement through observation without sending another assertion', async () => {
    const api = client(); vi.spyOn(api, 'getCommandReceipt').mockImplementation(async () => receipt());
    const send = vi.spyOn(api, 'reconcileCommandReceipt').mockImplementation(async value => { assertion = value; acknowledged = true; throw new Error('Lost reply'); });
    const operation = request(); await expect(settleEmbermendOwner('fixture-grant', operation, node, api)).rejects.toThrow('Lost reply');
    expect(await observeOwnerSettlement('fixture-grant', operation, node, api)).toMatchObject({ originalOutcome: 'unknown', ownershipSettled: true });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('fails a superseded decision only after another immutable native settlement is verified', async () => {
    const api = client(); vi.spyOn(api, 'getCommandReceipt').mockImplementation(async () => receipt());
    vi.spyOn(api, 'reconcileCommandReceipt').mockImplementation(async value => { assertion = value; throw new Error('Pre-delivery interruption'); });
    const operation = request(); await expect(settleEmbermendOwner('fixture-grant', operation, node, api)).rejects.toThrow();
    if (!assertion) throw new Error('Retained decision required');
    assertion = { ...assertion, decisionId: 'different-explicit-recovery', signature: 'e'.repeat(64) }; acknowledged = true;
    expect(await observeOwnerSettlement('fixture-grant', operation, node, api)).toMatchObject({ superseded: true, winningRecoveryOperationId: 'different-explicit-recovery', originalOutcome: 'unknown' });
    expect(db.operation.update).toHaveBeenLastCalledWith({ where: { id: 'recovery-row' }, data: { state: 'failed' } });
  });
  it.each(['request-digest', 'native-digest', 'target', 'unexpired', 'active'])('refuses changed or active ownership: %s', async mode => {
    const operation = request();
    if (mode === 'request-digest') operation.action.parameters['originalRequestDigest'] = '0'.repeat(64);
    if (mode === 'native-digest') operation.action.parameters['nativeRequestDigest'] = '0'.repeat(64);
    if (mode === 'target') operation.action.targetId = 'other-target';
    if (mode === 'unexpired') db.operation.findUnique.mockResolvedValue({ id: 'original-row', commandId: 'original-command', requestDigest: 'b'.repeat(64), nodeId: node.id, request: { ...original(), expiresAt: new Date(Date.now() + 60000).toISOString() }, state: 'unknown' });
    const api = client(); vi.spyOn(api, 'getCommandReceipt').mockResolvedValue(mode === 'active' ? { commandId: 'original-command', requestSha256: 'c'.repeat(64), state: 'running' } : receipt());
    const send = vi.spyOn(api, 'reconcileCommandReceipt');
    await expect(settleEmbermendOwner('fixture-grant', operation, node, api)).rejects.toThrow(); expect(send).not.toHaveBeenCalled(); expect(db.operation.update).not.toHaveBeenCalled();
  });
  it('cannot settle in a restored rehearsal or without separate reconciliation authority', async () => {
    const api = client(); const send = vi.spyOn(api, 'reconcileCommandReceipt');
    vi.stubEnv('HIVE_REHEARSAL', 'true'); await expect(settleEmbermendOwner('fixture-grant', request(), node, api)).rejects.toThrow('Isolated rehearsal');
    vi.stubEnv('HIVE_REHEARSAL', 'false'); vi.stubEnv('COMMAND_RECONCILIATION_SECRET', ''); await expect(settleEmbermendOwner('fixture-grant', request(), node, api)).rejects.toThrow('authority'); expect(send).not.toHaveBeenCalled();
  });
});
