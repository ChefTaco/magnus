import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { embermendCanonical, embermendOperationSchema } from '@hivemagnus/magnus-contracts/embermend';
const fixture = vi.hoisted(() => ({ command: vi.fn(), recovery: vi.fn(), files: new Map<string, string>(), temporary: '' }));
vi.mock('node:child_process', () => ({ execFile: Object.assign(() => undefined, { [Symbol.for('nodejs.util.promisify.custom')]: fixture.command }) }));
vi.mock('./embermend-config.js', () => ({ rootControlled: async () => undefined }));
vi.mock('./execution-supervisor-state.js', () => ({ privateDirectory: async () => undefined, syncDirectory: async () => undefined, writeJson: fixture.recovery, readJson: async () => undefined }));
vi.mock('node:fs/promises', () => ({
  lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, uid: 0, nlink: 1, mode: 0o100600, size: 100 }),
  readFile: async (path: string) => fixture.files.get(path) ?? '',
  open: async () => ({ writeFile: async (value: string) => { fixture.temporary = value; }, sync: async () => undefined, close: async () => undefined }),
  rename: async (_source: string, destination: string) => { fixture.files.set(destination, fixture.temporary); }, unlink: async () => undefined,
}));
import { executeHostAction, hostResourceObservations } from './embermend-host.js';
const hash = (value: unknown): string => createHash('sha256').update(embermendCanonical(value)).digest('hex');
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const config = { version: 1 as const, resources: { app: { kind: 'compose' as const, path: '/opt/fixture/compose.json', overridePath: '/opt/fixture/image.json', service: 'web', imageRepository: 'registry.example.com/fixture/app', healthUrl: 'https://app.example.com/health' } }, securityPackages: [] };
const image = config.resources.app.imageRepository + '@sha256:' + 'a'.repeat(64);
const instance = () => ({ id: 'b'.repeat(64), imageId: 'sha256:' + 'c'.repeat(64), imageRef: image, status: 'running', running: true, health: 'healthy', startedAt: '2026-11-10T12:00:00Z', service: 'web', project: 'fixture' });
beforeEach(() => {
  vi.clearAllMocks(); fixture.files = new Map([['/opt/fixture/compose.json', 'fixture-base'], ['/opt/fixture/image.json', 'fixture-override']]);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ healthy: true })));
  fixture.command.mockImplementation(async (_binary: string, args: string[]) => ({ stdout: args.includes('ps') ? 'b'.repeat(64) : args[0] === 'inspect' ? JSON.stringify(instance()) : args[0] === 'image' ? 'sha256:' + 'c'.repeat(64) : '', stderr: '' }));
});
afterEach(() => vi.unstubAllGlobals());
function request() { return embermendOperationSchema.parse({ operationId: 'fixture-rollout', planId: 'fixture-plan', planRevision: 1, planDigest: 'd'.repeat(64), installationId: 'fixture-magnus', authorizationRef: 'fixture-deploy-approval', expiresAt: new Date(Date.now() + 300000).toISOString(), action: { id: 'rollout', version: 'compose-deploy.v1', class: 'deploy', targetId: 'fixture-host', targetKind: 'host', requiredCapabilities: ['embermend:compose-deploy.v1'], parameters: { deploymentId: 'app', artifactDigest: 'a'.repeat(64), configurationDigest: sha('fixture-base'), beforeDigest: hash({ exists: true, contentDigest: sha('fixture-override'), mode: 0o600 }) }, preconditions: { environment: 'lab' }, dependsOn: [], verificationIds: [], recovery: 'Separate approved previous-digest rollout', expectedRevision: null, patchDigest: null, disruption: 'outage' } }); }
describe('bounded Compose artifact rollout and independent inventory', () => {
  it('pins the immutable image and changes only the approved service without building dependencies', async () => {
    const result = await executeHostAction(request(), config);
    expect(result).toMatchObject({ deployedArtifactDigest: 'a'.repeat(64), healthPassed: true, securityVerification: 'outstanding' });
    expect(JSON.parse(fixture.files.get('/opt/fixture/image.json') ?? '')).toEqual({ services: { web: { image } } });
    const up = fixture.command.mock.calls.find(call => Array.isArray(call[1]) && call[1].includes('up'))?.[1];
    expect(up).toContain('--no-deps'); expect(up).toContain('--no-build'); expect(up).toContain('--wait-timeout'); expect(up?.at(-1)).toBe('web');
    expect(fixture.recovery).toHaveBeenCalledTimes(1);
  });
  it('refuses changed configuration before writing an override or invoking Docker', async () => {
    const operation = request(); operation.action.parameters['configurationDigest'] = 'e'.repeat(64);
    await expect(executeHostAction(operation, config)).rejects.toThrow('configuration changed'); expect(fixture.command).not.toHaveBeenCalled(); expect(fixture.recovery).not.toHaveBeenCalled();
  });
  it.each(['wrong-image', 'wrong-service', 'unhealthy', 'stopped'])('refuses successful rollout proof for %s readback', async mode => {
    const value = { ...instance(), ...(mode === 'wrong-image' ? { imageRef: 'registry.example.com/fixture/app:latest' } : mode === 'wrong-service' ? { service: 'unapproved' } : mode === 'unhealthy' ? { health: 'unhealthy' } : { running: false }) };
    fixture.command.mockImplementation(async (_binary: string, args: string[]) => ({ stdout: args.includes('ps') ? 'b'.repeat(64) : args[0] === 'inspect' ? JSON.stringify(value) : args[0] === 'image' ? 'sha256:' + 'c'.repeat(64) : '', stderr: '' }));
    await expect(executeHostAction(request(), config)).rejects.toThrow(/binding differs|running state differs/);
  });
  it('independently reads current instances instead of trusting a previous deployment receipt', async () => {
    const observation = await hostResourceObservations(config);
    expect(observation['app']).toMatchObject({ configurationDigest: sha('fixture-base'), instances: [instance()] });
    expect(fixture.command.mock.calls.every(call => Array.isArray(call[1]) && !call[1].includes('up'))).toBe(true); expect(fixture.recovery).not.toHaveBeenCalled();
  });
});


it('keeps missing Docker health as unknown while retaining native instance identity', async () => {
  const current = { ...instance(), health: null };
  fixture.command.mockImplementation(async (_binary: string, args: string[]) => ({ stdout: args.includes('inspect') ? JSON.stringify(current) : current.id + '\n', stderr: '' }));
  const result = await hostResourceObservations(config);
  expect(result['app']).toMatchObject({ instances: [{ id: current.id, imageId: current.imageId, health: null }] });
});
