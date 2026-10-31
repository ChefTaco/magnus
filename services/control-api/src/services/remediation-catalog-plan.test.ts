import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRemediationPlan } from './remediation-service.js';
import { describeRemediationPlan } from './team-approvals.js';

let directory: string | undefined;
afterEach(() => { vi.unstubAllEnvs(); if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined; });

describe('remediation catalog plan producer', () => {
  it('carries the full catalog digest inside the independently hashed Telegram presentation', () => {
    directory = mkdtempSync(join(tmpdir(), 'magnus-catalog-plan-'));
    const probesPath = join(directory, 'probes.json'); const catalogPath = join(directory, 'catalog.json');
    writeFileSync(probesPath, JSON.stringify({ schemaVersion: 1, applications: [{ id: 'api', projectId: 'magnus',
      serviceId: 'api', nodeId: 'magnus', baseUrl: 'https://api.invalid/', healthPath: '/health', kind: 'http',
      restartService: 'magnus-control-api.service' }] }), { mode: 0o600 });
    writeFileSync(catalogPath, JSON.stringify({ schemaVersion: 1, applications: [{ id: 'api', nodeId: 'magnus',
      deploySource: 'repo:magnus', runtimePath: '/opt/magnus-api', healthContract: { method: 'GET', path: '/health',
        successStatuses: [200], maxAgeMs: 60_000 }, dataOwner: 'magnus', recoveryOrder: 1, dependsOn: [],
      investigationSequence: ['Inspect health'], recoverySequence: ['Verify health'] }], runbooks: [{
      id: 'api-recovery', version: '1.0.0', executionVersion: 'restart-service.v1', kind: 'remediation', mutatesState: true,
      timeoutSeconds: 60, maxAttempts: 1, command: '/usr/bin/systemctl', args: ['restart', 'magnus-control-api.service'],
      preflight: ['Capture health'], steps: ['Restart exact service'], postconditions: ['Verify health'],
      directPostcondition: { kind: 'application_health', requirement: 'Verify health' }, rollbackCriteria: ['Stop on failure'],
    }, {
      id: 'api-diagnostics', version: '1.0.0', executionVersion: 'diagnostics.v1', kind: 'diagnostics', mutatesState: false,
      timeoutSeconds: 60, maxAttempts: 1, command: '/usr/bin/uptime', args: [], preflight: ['Capture health'],
      steps: ['Read uptime'], postconditions: ['Verify health'],
      directPostcondition: { kind: 'application_health', requirement: 'Verify health' }, rollbackCriteria: ['Retain result'],
    }] }), { mode: 0o600 });
    vi.stubEnv('MAGNUS_APPLICATION_PROBES_FILE', probesPath); vi.stubEnv('MAGNUS_OPERATIONS_CATALOG_FILE', catalogPath);
    const plan = buildRemediationPlan({ agentDefinitionId: 'restart-service.v1', input: JSON.stringify({ applicationId: 'api' }) }, 'magnus');
    expect(plan).toMatchObject({ catalogRunbookId: 'api-recovery', catalogRunbookVersion: '1.0.0',
      catalogPlanSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const presentation = describeRemediationPlan({ id: 'execution-1', input: JSON.stringify(plan), nodeId: 'magnus', anomalyEventId: 'anomaly-1' });
    expect(presentation.steps).toContain(`Catalog plan: ${plan.catalogPlanSha256}`);
    expect(presentation.plan_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(presentation.plan_sha256).not.toBe(plan.catalogPlanSha256);

    const diagnostic = buildRemediationPlan({ agentDefinitionId: 'diagnostics.v1',
      input: JSON.stringify({ applicationId: 'api' }) }, 'magnus');
    expect(diagnostic).toMatchObject({ applicationId: 'api', catalogRunbookId: 'api-diagnostics',
      catalogRunbookVersion: '1.0.0', catalogPlanSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      command: '/usr/bin/uptime', args: [] });
    const diagnosticPresentation = describeRemediationPlan({ id: 'execution-2', input: JSON.stringify(diagnostic),
      nodeId: 'magnus', anomalyEventId: 'anomaly-2' });
    expect(diagnosticPresentation.risk).toMatch(/Read-only/);
    expect(diagnosticPresentation.steps).toContain(`Catalog plan: ${diagnostic.catalogPlanSha256}`);
  });
});
