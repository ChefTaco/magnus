import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { embermendOperationSchema } from '@hivemagnus/magnus-contracts/embermend';
import { requestReboot, observeReboot, RebootOutcomeUnknown, type RebootSystem } from './embermend-reboot.js';
const before = '11111111-1111-4111-8111-111111111111'; const after = '22222222-2222-4222-8222-222222222222';
const config = { version: 1 as const, resources: {}, securityPackages: [], reboot: { managementProbeId: 'fixture-probe', continuationWindowSeconds: 300 } };
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'embermend-reboot-')); vi.stubEnv('AGENT_INSTALL_DIR', root); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
function fixture() {
  let now = Date.now(); const requestedAt = now; let currentBoot = before; let schedule: string | null = null; let uptime = 0;
  const request = embermendOperationSchema.parse({ operationId: 'fixture-reboot', planId: 'fixture-plan', planRevision: 1, planDigest: 'a'.repeat(64), installationId: 'fixture-installation', authorizationRef: 'fixture-decision', expiresAt: new Date(now + 30000).toISOString(), action: { id: 'fixture-action', version: 'reboot.v1', class: 'reboot', targetId: 'fixture-node', targetKind: 'host', requiredCapabilities: ['embermend:reboot.v1'], parameters: { beforeBootId: before, managementProbeId: 'fixture-probe' }, preconditions: { environment: 'lab' }, dependsOn: [], verificationIds: [], recovery: 'Separately authorized intervention', expectedRevision: null, patchDigest: null, disruption: 'reboot' } });
  const scheduleCall = vi.fn(async (marker: string) => { schedule = `USEC=${(now + 60000) * 1000 + 123}\nMODE=reboot\nWALL_MESSAGE=${marker}\n`; });
  const host: RebootSystem = { now: () => now, bootId: async () => currentBoot, uptime: async () => uptime, scheduled: async () => schedule, schedule: scheduleCall };
  return { request, host, scheduleCall, setBoot: (id: string, offset = 60000, up = 10) => { currentBoot = id; now = requestedAt + offset + up * 1000; uptime = up; }, scheduled: (value: string | null) => { schedule = value; } };
}
describe('acknowledged original reboot continuation', () => {
  it('keeps same-boot restarts and duplicate delivery unknown without scheduling again', async () => {
    const x = fixture(); await expect(requestReboot(x.request, config, x.host)).rejects.toBeInstanceOf(RebootOutcomeUnknown);
    expect(await observeReboot(x.request, config, x.host)).toBeUndefined();
    await expect(requestReboot(x.request, config, x.host)).rejects.toBeInstanceOf(RebootOutcomeUnknown); expect(x.scheduleCall).toHaveBeenCalledTimes(1);
  });
  it('observes a subsequent scheduled boot after the original admission deadline without executing', async () => {
    const x = fixture(); await expect(requestReboot(x.request, config, x.host)).rejects.toBeInstanceOf(RebootOutcomeUnknown); x.setBoot(after);
    expect(await observeReboot(x.request, config, x.host)).toMatchObject({ rebootCompleted: true, beforeBootId: before, afterBootId: after, operationalHealthVerification: 'outstanding' });
    expect(x.scheduleCall).toHaveBeenCalledTimes(1);
  });
  it.each(['missing-ack', 'wrong-mode', 'wrong-marker', 'lost-reply'])('never completes from %s followed by another boot', async mode => {
    const x = fixture(); x.scheduleCall.mockImplementation(async () => { if (mode === 'lost-reply') throw new Error('reply lost'); x.scheduled(mode === 'missing-ack' ? null : `USEC=${(Date.now() + 60000) * 1000}\nMODE=${mode === 'wrong-mode' ? 'poweroff' : 'reboot'}\nWALL_MESSAGE=another-operation\n`); });
    await expect(requestReboot(x.request, config, x.host)).rejects.toBeInstanceOf(RebootOutcomeUnknown); x.setBoot(after);
    expect(await observeReboot(x.request, config, x.host)).toBeUndefined(); expect(x.scheduleCall).toHaveBeenCalledTimes(1);
  });
  it.each(['early', 'late', 'invalid-uptime'])('does not infer completion from %s boot evidence', async mode => {
    const x = fixture(); await expect(requestReboot(x.request, config, x.host)).rejects.toBeInstanceOf(RebootOutcomeUnknown);
    x.setBoot(after, mode === 'early' ? 10000 : mode === 'late' ? 1200000 : 60000, mode === 'invalid-uptime' ? NaN : 10);
    expect(await observeReboot(x.request, config, x.host)).toBeUndefined();
  });
  it('requires exact current boot, explicit policy and no conflicting shutdown before intent', async () => {
    const x = fixture(); await expect(requestReboot(x.request, { ...config, reboot: undefined }, x.host)).rejects.toThrow('policy');
    x.setBoot(after); await expect(requestReboot(x.request, config, x.host)).rejects.toThrow('precondition');
    x.setBoot(before, 0, 0); x.scheduled('another shutdown'); await expect(requestReboot(x.request, config, x.host)).rejects.toThrow('already scheduled'); expect(x.scheduleCall).not.toHaveBeenCalled();
  });
  it('refuses changed request or management-path policy during observation', async () => {
    const x = fixture(); await expect(requestReboot(x.request, config, x.host)).rejects.toBeInstanceOf(RebootOutcomeUnknown); x.setBoot(after);
    await expect(observeReboot({ ...x.request, planDigest: 'b'.repeat(64) }, config, x.host)).rejects.toThrow('identity');
    await expect(observeReboot(x.request, { ...config, reboot: { ...config.reboot, managementProbeId: 'changed' } }, x.host)).rejects.toThrow('policy');
  });
});
