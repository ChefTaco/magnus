import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeApiClient, commandReconciliationSigningPayload, type CommandReconciliationAssertion } from './node-api-client.js';
import { commandReconciliationSigningPayload as agentPayload, verifyCommandReconciliation as agentVerify } from '../../../../packages/agent/src/security/command-result-signature.js';

const key = 'cross-wire-dedicated-reconciliation-secret-at-least-32-bytes';
const resultKey = 'cross-wire-dedicated-result-secret-at-least-32-bytes';
vi.mock('../utils/env.js', async original => ({ ...await original<object>(),
  RESULT_SIGNING_SECRET: 'cross-wire-dedicated-result-secret-at-least-32-bytes', RESULT_SIGNING_PREVIOUS_SECRET: '' }));
const expected = { nodeFqdn: 'fixture.lab', requestSha256: 'a'.repeat(64) };
const client = () => new NodeApiClient({ baseUrl: 'http://node.invalid', nodeToken: 'fixture-auth' });
function assertion(patch: Partial<CommandReconciliationAssertion> = {}): CommandReconciliationAssertion {
  const value = { ...expected, commandId: 'uncertain-1', coordination: { version: 1 as const, resourceKey: 'node:fixture', fence: '3', expiresAt: Date.now() - 1000 },
    disposition: 'effects_verified' as const, evidenceSha256: 'e'.repeat(64), approvalRef: 'telegram:reviewed-1', decisionId: 'decision-1', expiresAt: Date.now() + 60_000, ...patch };
  return { ...value, signature: createHmac('sha256', key).update(agentPayload(value)).digest('hex') };
}
function receipt(value: CommandReconciliationAssertion) {
  return { version: 1, commandId: value.commandId, requestSha256: value.requestSha256, state: 'reconciled',
    acceptedAt: Date.now() - 100_000, finishedAt: Date.now(), coordination: value.coordination, reconciliation: value };
}
function serve(data: unknown, capability = 1) {
  const bodies: unknown[] = [];
  const fetch = vi.fn(async (request: Request) => {
    if (request.method === 'POST') bodies.push(await request.clone().json());
    return new Response(JSON.stringify({ success: true,
    data: request.url.endsWith('/ping') ? { features: { commandReconciliation: capability } } : data }),
    { headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetch); return Object.assign(fetch, { bodies });
}
beforeEach(() => { vi.stubEnv('COMMAND_RECONCILIATION_SECRET', key); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('explicit signed command reconciliation SDK', () => {
  it('matches the independently packaged agent signing contract', () => {
    const value = assertion();
    expect(commandReconciliationSigningPayload(value)).toBe(agentPayload(value));
    expect(agentVerify(value, key)).toBe(true);
    const { coordination: _, ...legacy } = value;
    expect(commandReconciliationSigningPayload(legacy)).toBe(agentPayload(legacy));
  });

  it('verifies historical reconciled receipts after expiry against the expected node and command digest', async () => {
    const value = assertion({ expiresAt: Date.now() - 1000 });
    serve(receipt(value));
    expect(await client().getCommandReceipt(value.commandId, expected)).toEqual({ commandId: value.commandId,
      requestSha256: expected.requestSha256, state: 'reconciled', reconciliation: value });
    await expect(client().getCommandReceipt(value.commandId)).rejects.toThrow('expected node');
    await expect(client().getCommandReceipt(value.commandId, { ...expected, nodeFqdn: 'other.lab' })).rejects.toThrow('expected node');
    await expect(client().getCommandReceipt(value.commandId, { ...expected, requestSha256: 'b'.repeat(64) })).rejects.toThrow('Invalid command receipt');
  });

  it('rejects forged evidence, altered outer fences, invalid state combinations and reused result keys', async () => {
    const value = assertion();
    serve({ ...receipt(value), reconciliation: { ...value, evidenceSha256: 'f'.repeat(64) } });
    await expect(client().getCommandReceipt(value.commandId, expected)).rejects.toThrow('signature verification');
    serve({ ...receipt(value), coordination: { ...value.coordination!, fence: '4' } });
    await expect(client().getCommandReceipt(value.commandId, expected)).rejects.toThrow('fence binding');
    serve({ ...receipt(value), result: {} });
    await expect(client().getCommandReceipt(value.commandId, expected)).rejects.toThrow('cannot contain a result');
    serve({ ...receipt(value), state: 'unknown' });
    await expect(client().getCommandReceipt(value.commandId, expected)).rejects.toThrow('cannot contain an attestation');
    serve(receipt(value));
    await expect(new NodeApiClient({ baseUrl: 'http://node.invalid', nodeToken: key })
      .getCommandReceipt(value.commandId, expected)).rejects.toThrow('authority');
    vi.stubEnv('COMMAND_RECONCILIATION_SECRET', resultKey);
    serve(receipt(value));
    await expect(client().getCommandReceipt(value.commandId, expected)).rejects.toThrow('authority');
  });

  it('submits only an explicit signed assertion after checking node capability and returns its exact attestation', async () => {
    const value = assertion(); const fetch = serve(receipt(value));
    const result = await client().reconcileCommandReceipt(value, expected);
    expect(result.state).toBe('reconciled');
    expect(fetch).toHaveBeenCalledTimes(2);
    const sent = fetch.mock.calls[1]![0];
    expect(sent.url.endsWith('/commands/receipts/uncertain-1/reconcile')).toBe(true);
    expect(sent.method).toBe('POST');
    expect(fetch.bodies).toEqual([value]);
    expect(fetch.mock.calls.some(([request]) => request.url.endsWith('/commands/execute'))).toBe(false);
  });

  it('does not submit unsupported, expired, overlong, wrongly bound, or unsigned decisions', async () => {
    const value = assertion(); const fetch = serve(receipt(value), 0);
    await expect(client().reconcileCommandReceipt(value, expected)).rejects.toThrow('does not support');
    expect(fetch).toHaveBeenCalledTimes(1);
    for (const invalid of [assertion({ expiresAt: Date.now() - 1 }), assertion({ expiresAt: Date.now() + 600_000 }),
      assertion({ nodeFqdn: 'other.lab' }), { ...value, signature: 'b'.repeat(64) }]) {
      fetch.mockClear();
      await expect(client().reconcileCommandReceipt(invalid, expected)).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('rechecks expiry after capability lookup and does not mutate an expired claim', async () => {
    const value = assertion();
    const fetch = vi.fn(async () => {
      vi.spyOn(Date, 'now').mockReturnValue(value.expiresAt + 1);
      return new Response(JSON.stringify({ success: true, data: { features: { commandReconciliation: 1 } } }));
    });
    vi.stubGlobal('fetch', fetch);
    await expect(client().reconcileCommandReceipt(value, expected)).rejects.toThrow('validity');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a valid receipt for a different reconciliation decision', async () => {
    const value = assertion(); serve(receipt(assertion({ decisionId: 'different-decision' })));
    await expect(client().reconcileCommandReceipt(value, expected)).rejects.toThrow('exact reconciliation decision');
  });

  it('never retries an ambiguous reconciliation POST and never dispatches the original command', async () => {
    const fetch = vi.fn(async (request: Request) => {
      if (request.url.endsWith('/ping')) return new Response(JSON.stringify({ success: true, data: { features: { commandReconciliation: 1 } } }));
      throw new Error('lost after reconciliation commit');
    });
    vi.stubGlobal('fetch', fetch);
    await expect(client().reconcileCommandReceipt(assertion(), expected)).rejects.toThrow('lost after reconciliation');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.some(([request]) => request.url.endsWith('/commands/execute'))).toBe(false);
  });
});
