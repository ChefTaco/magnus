import { describe, it, expect } from 'vitest';
import { scanWorkerConfigSchema, scanModelBody } from './embermend-scan.js';
const worker = { user: 'worker', uid: 1000, home: '/opt/worker', workspaceRoot: '/opt/workspaces', scannerImage: 'sha256:' + 'a'.repeat(64), repositories: {}, model: { baseUrl: 'https://inference.example.com/v1', model: 'fixture-provider', ref: 'fixture-provider', local: false, embermendBroker: true, tokenFile: '/opt/worker-broker.token' } };
const request = { repositoryId: 'fixture-repo', providerId: '12345', commit: 'a'.repeat(40), operationId: 'fixture-scan', deadline: '2026-12-01T00:00:00Z', sourcePolicy: { providerRef: 'fixture-provider', allowRemoteModel: true } };
describe('managed scanner inference forwarding', () => {
  it('pins reviewed runtime executable paths and refuses a repository-selected executable', () => {
    expect(scanWorkerConfigSchema.parse(worker).nodeExecutable).toBe('/usr/bin/node');
    expect(scanWorkerConfigSchema.safeParse({ ...worker, nodeExecutable: '/source/node' }).success).toBe(false);
    expect(scanWorkerConfigSchema.parse({ ...worker, nodeExecutable: '/usr/local/bin/node' }).nodeExecutable).toBe('/usr/local/bin/node');
  });
  it('binds broker context to admitted operation and source policy', () => {
    const model = scanWorkerConfigSchema.parse(worker).model;
    expect(scanModelBody(model, request, 'system', 'source')).toMatchObject({ model: 'fixture-provider', embermend_context: { providerRef: 'fixture-provider', operationId: 'fixture-scan', allowRemoteModel: true } });
    expect(() => scanModelBody(model, { ...request, sourcePolicy: { providerRef: 'fixture-provider', allowRemoteModel: false } }, 'system', 'source')).toThrow(/policy denied/);
    expect(() => scanModelBody(model, { ...request, sourcePolicy: { providerRef: 'other', allowRemoteModel: true } }, 'system', 'source')).toThrow(/policy denied/);
  });
  it('permits loopback broker transport without treating cloud models as local', () => {
    expect(scanWorkerConfigSchema.safeParse({ ...worker, model: { ...worker.model, baseUrl: 'http://127.0.0.1:4181/v1' } }).success).toBe(true);
    expect(scanWorkerConfigSchema.safeParse({ ...worker, model: { ...worker.model, baseUrl: 'http://inference.example.com/v1' } }).success).toBe(false);
    expect(scanWorkerConfigSchema.safeParse({ ...worker, model: { ...worker.model, model: 'different-provider' } }).success).toBe(false);
  });
  it('keeps direct model protocol free of broker fields and preserves disclosure checks', () => {
    const model = scanWorkerConfigSchema.parse({ ...worker, model: { ...worker.model, embermendBroker: false, local: true } }).model;
    expect(scanModelBody(model, request, 'system', 'source')).not.toHaveProperty('embermend_context');
  });
});
