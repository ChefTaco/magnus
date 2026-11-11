import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { embermendOperationSchema, embermendCanonical } from '@hivemagnus/magnus-contracts/embermend';
import { httpIdentity, httpReceiptBody } from '../security/managed-http.js';
import { commandRequestDigest } from './command-ledger.js';
import { privateDirectory, writeJson, requestDigest, type SupervisorInput } from './execution-supervisor-state.js';
const fixture = vi.hoisted(() => ({ status: vi.fn(), run: vi.fn(), config: vi.fn(), containerGone: vi.fn(), reboot: vi.fn() }));
vi.mock('./execution-supervisor.js', () => ({ ExecutionSupervisor: class { status = fixture.status; run = fixture.run; } }));
vi.mock('./embermend-reboot.js', () => ({ observeReboot: fixture.reboot }));
vi.mock('./embermend-config.js', () => ({ loadEmbermendConfig: fixture.config }));
vi.mock('./embermend-scan.js', () => ({ workerContainerGone: fixture.containerGone }));
const signingKey = 'fixture-native-adoption-signing-key-not-real-0000';
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown): string => sha(embermendCanonical(value));
let root: string;
beforeEach(async () => { vi.resetModules(); fixture.status.mockReset(); fixture.run.mockReset(); root = await mkdtemp(join(tmpdir(), 'embermend-adoption-')); vi.stubEnv('AGENT_INSTALL_DIR', root); vi.stubEnv('RESULT_SIGNING_SECRET', signingKey); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
async function interrupted(worker: boolean | 'reboot' = false) {
  const operation = embermendOperationSchema.parse({ operationId: 'fixture-operation', planId: 'fixture-plan', planRevision: 1, planDigest: 'a'.repeat(64), installationId: 'fixture-installation', authorizationRef: 'fixture-decision', expiresAt: '2026-12-01T00:00:00Z', action: { id: 'fixture-action', version: worker === 'reboot' ? 'reboot.v1' : worker ? 'repository-scan.v1' : 'file-mode.v1', class: worker === 'reboot' ? 'reboot' : worker ? 'assess' : 'host-change', targetId: 'fixture-node', targetKind: worker ? 'worker' : 'host', requiredCapabilities: ['embermend:file-mode.v1'], parameters: worker ? { request: { operationId: 'fixture-scan' } } : {}, preconditions: {}, dependsOn: [], verificationIds: [], recovery: 'Separately authorized', expectedRevision: null, patchDigest: null, disruption: 'none' } });
  const coordination = { version: 1 as const, resourceKey: 'node:fixture', fence: '1', expiresAt: Date.now() + 60000 };
  const identity = { ...httpIdentity('fixture-native', 'POST', '/embermend/action', JSON.stringify(operation), 780), coordination };
  const outerDigest = commandRequestDigest(identity);
  const input: SupervisorInput = { commandId: 'embermend-' + sha(identity.commandId + ':' + outerDigest), command: '/usr/bin/node', args: ['fixture-worker'], environment: { EMBERMEND_REQUEST: JSON.stringify(operation) }, timeoutSeconds: 780, coordination };
  const result = { success: true, data: { securityCheckPassed: true } }; const resultKey = sha(operation.operationId + ':' + digest(operation)); const pointer = { success: true, data: { resultKey, resultDigest: digest(result) } };
  const { retainEmbermendExecution } = await import('./embermend-execution.js');
  const { commandLedger, recoverCommandReceipt } = await import('./command-executor.js');
  await expect(commandLedger.execute(identity, async () => { await retainEmbermendExecution({ commandId: identity.commandId, requestSha256: outerDigest, coordination }, operation, input); throw new Error('Crash after detached worker start'); })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
  const resultRoot = join(root, '.magnus/embermend-results'); await privateDirectory(resultRoot); await writeJson(resultRoot, resultKey + '.json', result);
  const status = { state: 'completed', evidence: { version: 1, commandId: input.commandId, requestSha256: requestDigest(input), groupEmpty: true }, result: { exitCode: 0, stdout: JSON.stringify(pointer.data), stderr: '', durationMs: 12, truncated: false } };
  return { commandLedger, recoverCommandReceipt, identity, outerDigest, input, status, resultRoot, resultKey, pointer };
}
describe('original Embermend worker completion adoption', () => {
  it('adopts an exact completed worker after HTTP-process loss without another execution', async () => {
    const x = await interrupted(); fixture.status.mockResolvedValue(x.status);
    const { recoverEmbermendResponse } = await import('./embermend-execution.js');
    const { executionSupervisor } = await import('./command-executor.js');
    expect(await recoverEmbermendResponse(x.identity.commandId, x.outerDigest, x.identity.coordination, executionSupervisor)).toBeDefined();
    const recovered = await x.recoverCommandReceipt(x.identity.commandId);
    expect(recovered?.state).toBe('completed'); expect(recovered?.result?.stdout).toBe(httpReceiptBody('POST', '/embermend/action', 200, JSON.stringify(x.pointer)));
    const { verifyCommandResult } = await import('../security/command-result-signature.js');
    expect(recovered?.result && verifyCommandResult(recovered.result, signingKey)).toBe(true);
    expect((await x.commandLedger.drainSnapshot()).unknownCount).toBe(0);
    expect((await x.recoverCommandReceipt(x.identity.commandId))?.result?.signature).toBe(recovered?.result?.signature);
    expect(fixture.run).not.toHaveBeenCalled(); expect(fixture.status).toHaveBeenCalledWith(x.input.commandId, requestDigest(x.input));
  });
  it('adopts only subsequent-boot evidence without asking the previous supervisor to run', async () => {
    const x = await interrupted('reboot'); await rm(join(x.resultRoot, x.resultKey + '.json')); fixture.config.mockResolvedValue({});
    fixture.reboot.mockResolvedValue(undefined); expect((await x.recoverCommandReceipt(x.identity.commandId))?.state).toBe('unknown');
    fixture.reboot.mockResolvedValue({ rebootCompleted: true, beforeBootId: 'fixture-before', afterBootId: 'fixture-after', scheduleDigest: 'b'.repeat(64) });
    expect((await x.recoverCommandReceipt(x.identity.commandId))?.state).toBe('completed');
    expect(fixture.run).not.toHaveBeenCalled(); expect(fixture.status).toHaveBeenCalledTimes(1);
  });
  it('keeps detached rootless work unknown until container and mount absence is established', async () => {
    const x = await interrupted(true); fixture.status.mockResolvedValue(x.status); fixture.config.mockResolvedValue({ worker: { fixture: true } }); fixture.containerGone.mockResolvedValue(false);
    expect((await x.recoverCommandReceipt(x.identity.commandId))?.state).toBe('unknown'); expect((await x.commandLedger.drainSnapshot()).unknownCount).toBe(1);
    fixture.containerGone.mockResolvedValue(true); expect((await x.recoverCommandReceipt(x.identity.commandId))?.state).toBe('completed'); expect(fixture.run).not.toHaveBeenCalled();
  });
  it.each(['running', 'wrong-request', 'nonempty', 'truncated', 'failed', 'wrong-result', 'missing-result'])('retains original ownership for %s evidence', async mode => {
    const x = await interrupted(); const status = structuredClone(x.status);
    if (mode === 'running') status.state = 'running';
    if (mode === 'wrong-request') status.evidence.requestSha256 = '0'.repeat(64);
    if (mode === 'nonempty') status.evidence.groupEmpty = false;
    if (mode === 'truncated') status.result.truncated = true;
    if (mode === 'failed') status.result.exitCode = 1;
    if (mode === 'wrong-result') await writeJson(x.resultRoot, x.resultKey + '.json', { success: true, data: { securityCheckPassed: false } });
    if (mode === 'missing-result') await rm(join(x.resultRoot, x.resultKey + '.json'));
    fixture.status.mockResolvedValue(status);
    expect((await x.recoverCommandReceipt(x.identity.commandId))?.state).toBe('unknown'); expect((await x.commandLedger.drainSnapshot()).unknownCount).toBe(1); expect(fixture.run).not.toHaveBeenCalled();
  });
});
