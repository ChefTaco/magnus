import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeApiClient } from './node-api-client.js';
import { commandRequestDigest } from '../security/command-request.js';
import { commandRequestDigest as agentDigest } from '../../../../packages/agent/src/executors/command-ledger.js';
import { signCommandResult } from '../../../../packages/agent/src/security/command-result-signature.js';
import { commandResultSchema } from '../schemas/node-responses.js';
import { verifyCommandResultSignature } from '../security/command-result-signature.js';
import { httpIdentity, httpReceiptBody } from '../security/managed-http.js';
import { COMMAND_COMPLETION_REGISTRY_SHA256 } from '../security/command-completion-registry.js';
const secret = 'cross-wire-receipt-test-signing-secret-32-characters';
const mocks = vi.hoisted(() => ({ admit: vi.fn(), mark: vi.fn(), fail: vi.fn(), settle: vi.fn(),
  correlateNoEffect: vi.fn() }));
vi.mock('../utils/env.js', async original => ({ ...await original<object>(), RESULT_SIGNING_SECRET: 'cross-wire-receipt-test-signing-secret-32-characters', RESULT_SIGNING_PREVIOUS_SECRET: '' }));
const input = () => ({ commandId: 'test', command: 'printf', args: ['done'], timeoutSeconds: 5,
  environment: { Z: 'x', a: 'y' },
  coordination: { version: 1 as const, resourceKey: 'node:fixture', fence: '17', expiresAt: Date.now() + 60_000 } });
function signed(request = input()) {
  const row = { commandId: request.commandId, stdout: 'done', stderr: '', exitCode: 0, durationMs: 1, truncated: false,
    coordination: { ...request.coordination, requestSha256: agentDigest(request) } };
  return { ...row, signature: signCommandResult(row, secret) };
}
vi.mock('../services/command-resource-leases.js', async original => ({ ...await original<object>(),
  admitResourceCommand: mocks.admit, markResourceDispatched: mocks.mark,
  failResourceCommand: mocks.fail, settleResourceResult: mocks.settle }));
vi.mock('../services/skill-publication-settlement.js', async original => ({ ...await original<object>(),
  correlateSkillPublicationNoEffect: mocks.correlateNoEffect }));
const client = () => new NodeApiClient({ baseUrl: 'http://node.invalid', nodeToken: 'test-node-auth', resourceNodeId: 'fixture' });
function serve(response: unknown, capability = 1) {
  const fetch = vi.fn(async (request: Request) => new Response(JSON.stringify({ success: true,
    data: request.url.endsWith('/ping') ? { features: { commandFencing: capability } } : response }), { headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch); return fetch;
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); mocks.admit.mockResolvedValue(null); });

describe('independently packaged command wire compatibility', () => {
  it('uses identical canonical requests and validates v2 through API parsing', () => {
    const request = input();
    expect(commandRequestDigest(request)).toBe(agentDigest(request));
    const result = commandResultSchema.parse(signed(request));
    expect(verifyCommandResultSignature(result, secret)).toBe(true);
    for (const patch of [{ fence: '18' }, { resourceKey: 'node:other' }, { expiresAt: 1 }, { requestSha256: 'a'.repeat(64) }]) {
      expect(verifyCommandResultSignature({ ...result, coordination: { ...result.coordination!, ...patch } }, secret)).toBe(false);
    }
    expect(verifyCommandResultSignature({ ...result, coordination: undefined }, secret)).toBe(false);
  });
  it('retains legacy v1 compatibility', async () => {
    const request = input(); const { coordination: _, ...legacy } = request;
    const { coordination: __, signature: ___, ...row } = signed(request);
    const result = { ...row, signature: signCommandResult(row, secret) };
    const fetch = serve(result);
    expect((await client().executeCommand(legacy)).data).toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('checks capability before sending a fenced command and accepts its exact receipt', async () => {
    const request = input(); const result = signed(request); const fetch = serve(result);
    expect((await client().executeCommand(request)).data).toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('dispatches registered completion only to an identical enabled node registry and requires its signed v3 receipt', async () => {
    const request = { commandId: 'diagnostic', command: '/usr/bin/uptime', args: [], timeoutSeconds: 60,
      coordination: { version: 1 as const, resourceKey: 'node:fixture', fence: '18', expiresAt: Date.now() + 60_000 } };
    const unsigned = { commandId: request.commandId, stdout: 'up', stderr: '', exitCode: 0, durationMs: 1, truncated: false,
      coordination: { ...request.coordination, requestSha256: agentDigest(request) },
      completion: { registryVersion: 1 as const, registrySha256: COMMAND_COMPLETION_REGISTRY_SHA256,
        descriptorId: 'diagnostics-uptime-v1' } };
    const result = { ...unsigned, signature: signCommandResult(unsigned, secret) };
    const fetch = vi.fn(async (call: Request) => new Response(JSON.stringify({ success: true, data: call.url.endsWith('/ping')
      ? { features: { commandFencing: 1, commandCompletionRegistry: { version: 1,
        sha256: COMMAND_COMPLETION_REGISTRY_SHA256, enabled: 1 } } } : result }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    expect((await client().executeCommand(request)).data).toEqual(result); expect(fetch).toHaveBeenCalledTimes(2);
    const legacyRequest = { ...request, commandId: 'diagnostic-legacy' };
    const legacyUnsigned = { commandId: legacyRequest.commandId, stdout: 'up', stderr: '', exitCode: 0, durationMs: 1, truncated: false,
      coordination: { ...legacyRequest.coordination, requestSha256: agentDigest(legacyRequest) } };
    const legacy = { ...legacyUnsigned, signature: signCommandResult(legacyUnsigned, secret) };
    vi.stubGlobal('fetch', vi.fn(async (call: Request) => new Response(JSON.stringify({ success: true, data: call.url.endsWith('/ping')
      ? { features: { commandFencing: 1, commandCompletionRegistry: { version: 1,
        sha256: COMMAND_COMPLETION_REGISTRY_SHA256, enabled: 1 } } } : legacy }))));
    await expect(client().executeCommand(legacyRequest)).rejects.toThrow('registry receipt differs');
    for (const changed of [{ version: 2, sha256: COMMAND_COMPLETION_REGISTRY_SHA256, enabled: 1 },
      { version: 1, sha256: '0'.repeat(64), enabled: 1 }, { version: 1, sha256: COMMAND_COMPLETION_REGISTRY_SHA256, enabled: 0 }]) {
      const mismatch = vi.fn(async () => new Response(JSON.stringify({ success: true,
        data: { features: { commandFencing: 1, commandCompletionRegistry: changed } } })));
      vi.stubGlobal('fetch', mismatch);
      await expect(client().executeCommand({ ...request, commandId: `diagnostic-${changed.version}-${changed.enabled}-${changed.sha256[0]}` }))
        .rejects.toThrow('registry differs');
      expect(mismatch).toHaveBeenCalledTimes(1);
    }
  });
  it('does not dispatch to an older node that would silently discard coordination', async () => {
    const fetch = serve({}, 0);
    await expect(client().executeCommand(input())).rejects.toThrow('does not support command fencing');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects a valid signature for different command input or a downgraded receipt', async () => {
    const request = input(); serve(signed({ ...request, args: ['different'] }));
    await expect(client().executeCommand(request)).rejects.toThrow('request/fence verification');
    const { coordination: _, signature: __, ...row } = signed(request);
    serve({ ...row, signature: signCommandResult(row, secret) });
    await expect(client().executeCommand(request)).rejects.toThrow('request/fence verification');
  });
  it('reads terminal receipts with verified signatures and keeps unknown outcomes explicit', async () => {
    const request = input(), result = signed(request);
    const receipt = { commandId: request.commandId, requestSha256: agentDigest(request), state: 'completed', result };
    serve(receipt); expect(await client().getCommandReceipt(request.commandId)).toEqual(receipt);
    serve({ ...receipt, result: { ...result, stdout: 'forged' } });
    await expect(client().getCommandReceipt(request.commandId)).rejects.toThrow('signature verification');
    serve({ ...receipt, state: 'unknown', result: undefined });
    expect((await client().getCommandReceipt(request.commandId)).state).toBe('unknown');
  });
  it('recovers the exact retained skill workflow without creating another admission', async () => {
    const bytes = Buffer.from('{}'); const payload = { skillName: 'fixture-skill', version: '1.0.0',
      bundleSha256: 'b'.repeat(64), bundle: { format: 'magnus-skill-bundle-v1' as const,
        entries: [{ path: 'manifest.json', mode: 420 as const,
          sha256: 'c'.repeat(64), contentBase64: bytes.toString('base64') }] } };
    const commandId = 'skill-recovery'; const coordination = input().coordination;
    const identity = { ...httpIdentity(commandId, 'POST', '/skills/install', JSON.stringify(payload), 15), coordination };
    const response = { status: 200, body: JSON.stringify({ success: true, data: { id: 'fixture-skill-1.0.0',
      skillName: 'fixture-skill', nodeId: 'fixture', version: '1.0.0', status: 'installed',
      publishedAt: new Date().toISOString(), bundleSha256: payload.bundleSha256, treeSha256: 'd'.repeat(64),
      commandId, requestSha256: agentDigest(identity) } }) };
    const unsigned = { commandId, exitCode: 0, stdout: httpReceiptBody('POST', '/skills/install', 200, response.body),
      stderr: '', durationMs: 0, truncated: false, coordination: { ...coordination, requestSha256: agentDigest(identity) } };
    const receipt = { ...unsigned, signature: signCommandResult(unsigned, secret) };
    const fetch = vi.fn(async (request: Request) => {
      expect(JSON.parse(await request.text())).toMatchObject({ recoveryOnly: true, commandId });
      return new Response(JSON.stringify({ success: true, data: { response, receipt } }),
        { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetch);
    const recovered = await client().recoverSkillBundle(payload, { leaseId: 'lease-fixture', commandId,
      nodeId: 'fixture', nodeFqdn: 'fixture.invalid', requestSha256: agentDigest(identity), timeoutSeconds: 15, coordination });
    expect(recovered.response.data).toMatchObject({ commandId, bundleSha256: payload.bundleSha256 });
    expect(recovered.evidence).toMatchObject({ commandId, commandSha256: agentDigest(identity),
      receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('correlates a signed typed no-effect response from the initial skill dispatch', async () => {
    const payload = { skillName: 'fixture-skill', version: '1.0.0', bundleSha256: 'b'.repeat(64),
      bundle: { format: 'magnus-skill-bundle-v1' as const, entries: [] } };
    const commandId = 'skill-initial'; const coordination = input().coordination;
    const identity = { ...httpIdentity(commandId, 'POST', '/skills/install', JSON.stringify(payload), 15), coordination };
    const requestSha256 = agentDigest(identity);
    mocks.admit.mockResolvedValueOnce({ leaseId: 'lease-initial', commandId, nodeId: 'fixture',
      nodeFqdn: 'fixture.invalid', payload: identity });
    const response = { status: 409, body: JSON.stringify({ success: false,
      error: { code: 'SKILL_PUBLICATION_NOT_COMMITTED', message: 'No visible version' },
      data: { skillName: payload.skillName, version: payload.version, bundleSha256: payload.bundleSha256,
        commandId, requestSha256, effect: 'none' } }) };
    const unsigned = { commandId, exitCode: 1, stdout: httpReceiptBody('POST', '/skills/install', 409, response.body),
      stderr: '', durationMs: 1, truncated: false, coordination: { ...coordination, requestSha256 } };
    const receipt = { ...unsigned, signature: signCommandResult(unsigned, secret) };
    vi.stubGlobal('fetch', vi.fn(async (request: Request) => {
      if (!request.url.endsWith('/ping')) expect(JSON.parse(await request.text())).not.toHaveProperty('recoveryOnly');
      return new Response(JSON.stringify({ success: true,
        data: request.url.endsWith('/ping') ? { features: { managedMutations: 1 } } : { response, receipt } }),
      { headers: { 'content-type': 'application/json' } });
    }));

    await expect(client().publishSkillBundle(payload, commandId)).rejects.toThrow('HTTP 409');
    expect(mocks.correlateNoEffect).toHaveBeenCalledWith({ commandId, requestSha256,
      skillName: payload.skillName, version: payload.version, bundleSha256: payload.bundleSha256,
      responseBody: response.body });
    expect(mocks.settle).toHaveBeenCalledWith(commandId, receipt);
  });
  it('does not repeat a POST after an ambiguous network failure', async () => {
    const fetch = vi.fn(async (request: Request) => {
      if (request.url.endsWith('/ping')) return new Response(JSON.stringify({ success: true, data: { features: { commandFencing: 1 } } }));
      throw new Error('connection lost after acceptance');
    });
    vi.stubGlobal('fetch', fetch);
    await expect(client().executeCommand(input())).rejects.toThrow('connection lost');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
