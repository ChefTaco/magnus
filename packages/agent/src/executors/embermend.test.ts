import { describe, expect, it, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { embermendCanonical, embermendOperationSchema, type EmbermendOperation } from '@hivemagnus/magnus-contracts/embermend';
import { embermendNodeConfigSchema, loadEmbermendConfig } from './embermend-config.js';
import { executeHostAction } from './embermend-host.js';
import { embermendRoutes } from './embermend.js';

const hash = (value: unknown) => createHash('sha256').update(embermendCanonical(value)).digest('hex');
const request = (): EmbermendOperation => embermendOperationSchema.parse({ operationId: 'fixture-operation', planId: 'fixture-plan', planRevision: 1, planDigest: 'a'.repeat(64), installationId: 'fixture-magnus', authorizationRef: 'fixture-authorization', expiresAt: new Date(Date.now() + 60000).toISOString(), action: { id: 'fixture-action', version: 'service-state.v1', class: 'host-change', targetId: 'fixture-node', targetKind: 'host', requiredCapabilities: ['embermend:service-state.v1'], parameters: { resourceId: 'fixture-service', enabled: false, active: false, beforeDigest: hash({ unit: 'fixture-app.service', active: 'active', enabled: 'enabled' }) }, preconditions: {}, dependsOn: [], verificationIds: ['fixture-verification'], recovery: 'Restore original state with separately authorized recovery', expectedRevision: null, patchDigest: null, disruption: 'restart' } });
afterEach(() => vi.unstubAllEnvs());
describe('bounded Embermend node boundary', () => {
  it('advertises no security actions without protected node configuration', async () => {
    vi.stubEnv('MAGNUS_EMBERMEND_CONFIG', '');
    const response = await embermendRoutes.request('/capabilities'); expect(await response.json()).toMatchObject({ success: true, data: { actions: [] } });
  });
  it('denies privileged changes before opening configuration on an unprivileged node', async () => {
    vi.stubEnv('MAGNUS_AGENT_PRIVILEGED', 'false'); const app = new Hono().route('/embermend', embermendRoutes);
    const response = await app.request('/embermend/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request()) });
    expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ error: { code: 'AGENT_NOT_PRIVILEGED' } });
  });
  it('refuses direct action dispatch even when the node is privileged', async () => {
    vi.stubEnv('MAGNUS_AGENT_PRIVILEGED', 'true'); vi.stubEnv('MAGNUS_EXECUTION_SUPERVISOR_ENABLED', 'true');
    const response = await embermendRoutes.request('/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request()) });
    expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ error: { code: 'MANAGED_SUPERVISOR_REQUIRED' } });
  });
  it('requires protected configuration and rejects generated commands', async () => {
    await expect(loadEmbermendConfig('')).rejects.toThrow('not configured');
    expect(embermendNodeConfigSchema.safeParse({ version: 1, resources: {}, securityPackages: [], command: 'arbitrary shell' }).success).toBe(false);
    expect(embermendOperationSchema.safeParse({ ...request(), command: 'arbitrary shell' }).success).toBe(false);
  });
  it('denies resources outside the root-controlled service allowlist', async () => {
    await expect(executeHostAction(request(), { version: 1, resources: {}, securityPackages: [] })).rejects.toThrow('Allowlisted service');
  });
  it('denies malformed firewall scope and management-port removal without running ufw', async () => {
    const operation = request(); operation.action.version = 'firewall-rule.v1'; operation.action.parameters = { resourceId: 'firewall', protocol: 'tcp', port: 4100, sourceCidr: '0.0.0.0/0', allow: false, beforeDigest: 'a'.repeat(64), managementProbeId: 'fixture-probe' };
    const config = { version: 1 as const, resources: { firewall: { kind: 'firewall' as const, protectedPorts: [22, 4100], managementProbeId: 'fixture-probe' } }, securityPackages: [] };
    await expect(executeHostAction(operation, config)).rejects.toThrow('management ports');
    operation.action.parameters['sourceCidr'] = '0.0.0.0/999'; await expect(executeHostAction(operation, config)).rejects.toThrow('CIDR');
  });
  it('preserves old native completion identities without retroactively granting Embermend', async () => {
    const registry = await import('../security/native-completion-registry.js'); const previous = 'c248ac35d858536199a2426069aa8dfab6e858a4668abbec93a166907cd053ed';
    expect(registry.knownNativeCompletionIdentity(1, previous, 'codex-update')).toBe(true);
    expect(registry.knownNativeCompletionIdentity(1, previous, 'embermend-action')).toBe(false);
    expect(registry.knownNativeCompletionIdentity(1, registry.NATIVE_COMPLETION_REGISTRY_SHA256, 'embermend-action')).toBe(true);
  });
});
