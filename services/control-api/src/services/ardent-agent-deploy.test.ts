import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';

type Row = { id: string; kind: string; nodeId: string; profile: string; status: string; requestJson: string; stepsJson: string;
  error: string | null; createdBy: string; actingJson: string | null; attempts: number; createdAt: Date; updatedAt: Date; completedAt: Date | null };
const store = vi.hoisted(() => ({ rows: new Map<string, Row>(), audit: [] as Array<{ action: string; actorId: string; details?: Record<string, unknown> }> }));
function tick(row: Row): Row { row.updatedAt = new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1)); return row; }
vi.mock('../db/index.js', () => ({ getDb: () => ({ ardentAgentOperation: {
  create: async ({ data }: { data: Partial<Row> & { id: string; nodeId: string; profile: string } }) => {
    if ([...store.rows.values()].some(row => row.status === 'running' && row.nodeId === data.nodeId && row.profile === data.profile))
      throw Object.assign(new Error('unique'), { code: 'P2002' });
    const row: Row = { status: 'running', stepsJson: '[]', error: null, actingJson: null, attempts: 1, createdAt: new Date(), updatedAt: new Date(), completedAt: null,
      kind: '', requestJson: '', createdBy: '', ...data };
    store.rows.set(row.id, row);
    return { ...row };
  },
  findUnique: async ({ where }: { where: { id: string } }) => { const row = store.rows.get(where.id); return row ? { ...row } : null; },
  update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
    const row = store.rows.get(where.id)!;
    Object.assign(row, data);
    return { ...tick(row) };
  },
  updateMany: async ({ where, data }: { where: { id: string; status: string; updatedAt: Date }; data: Partial<Row> & { attempts?: { increment: number } } }) => {
    const row = store.rows.get(where.id);
    if (!row || row.status !== where.status || row.updatedAt.getTime() !== where.updatedAt.getTime()) return { count: 0 };
    const { attempts, ...rest } = data;
    Object.assign(row, rest);
    if (attempts) row.attempts += attempts.increment;
    tick(row);
    return { count: 1 };
  },
} }) }));
vi.mock('./audit-service.js', () => ({ logAuditEvent: async (event: { action: string; actorId: string; details?: Record<string, unknown> }) => { store.audit.push(event); } }));

const deploy = await import('./ardent-agent-deploy.js');
let fakeDeps: Partial<import('./ardent-agent-deploy.js').ArdentDeployDeps> = {};
const { HiveMemEnrollmentError } = await import('./ardent-hivemem.js');

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJmaXh0dXJlIjp0cnVlfQ.fixture-signature-value';
const TEMPLATE = 'schema_version: 1\nprofile: lead\nname: lead\nexecution:\n  backend: llamacpp\nproviders:\n  llamacpp:\n    base_url: ${ARDENT_LLAMA_BASE_URL}\n    model: ${ARDENT_LLAMA_MODEL}\nmemory:\n  provider: none\nskills:\n  directories: [skills]\n  enabled: [grounded-answers]\n';
const actor = { actorId: 'alice', details: {} };
const input = { nodeId: 'node-1', profile: 'lead', soul_md: '# Soul\n', identity_md: '# Identity\n',
  model: { base_url: 'http://192.0.2.10:8080/v1', model: 'fixture-model' }, skills: ['grounded-answers', 'research'], hivemem: true };

interface Node { profiles: Array<{ id: string; name: string; backend: 'llamacpp'; apiPort: number; running: boolean; a2aEnabled: boolean; channels: Record<string, boolean>; error: null }>;
  config: string; identity: Record<string, string>; env: string[]; actions: string[]; failOnce: Set<string>; failMessage?: string }
let node: Node;
let ardentVersion = '2.1.2';
let owners: Array<import('@hivemagnus/magnus-contracts').ArdentCommandOwner> = [];
const credential = vi.fn();
const prepare = vi.fn();
const record = vi.fn();
let renewalSupported = false;
const keyChecks: Array<{ baseUrl: string; key: string; alias: string }> = [];
let keyAnswer: () => Promise<import('./ardent-emberpath-key.js').EmberpathKeyCheck> = async () => ({ checked: true });

beforeEach(() => {
  store.rows.clear();
  store.audit.length = 0;
  owners = [];
  credential.mockReset();
  prepare.mockReset();
  prepare.mockResolvedValue(undefined);
  record.mockReset();
  record.mockResolvedValue(undefined);
  renewalSupported = false;
  keyChecks.length = 0;
  keyAnswer = async () => ({ checked: true });
  ardentVersion = '2.1.2';
  credential.mockImplementation(async (_settings: unknown, plan: { agentId: string; action: string }) => ({ token: TOKEN, agentId: plan.agentId, expiresAt: '2026-12-01T00:00:00.000Z', operationId: 'f'.repeat(64) }));
  node = { profiles: [{ id: 'existing', name: 'existing', backend: 'llamacpp', apiPort: 9910, running: true, a2aEnabled: false, channels: {}, error: null }],
    config: TEMPLATE, identity: { soul: 'template soul', identity: 'template identity' }, env: [], actions: [], failOnce: new Set() };
  fakeDeps = {
    installation: async nodeId => ({ nodeId, nodeName: 'node-1', hostname: 'node-1.example.com', reachable: true, installed: true, version: ardentVersion,
      owner: 'operator', profiles: node.profiles, checkedAt: new Date().toISOString(), error: null }),
    read: async <T,>(_nodeId: string, profile: string, resource: string) => {
      if (!node.profiles.some(item => item.id === profile && item.running)) throw new Error('Ardent management listener identity differs or is unavailable');
      if (resource === 'config') return { revision: `rev-${node.config.length}`, text: node.config } as T;
      if (resource.startsWith('identity/')) { const text = node.identity[resource.slice(9)]!; return { text, revision: `rev-${text.length}` } as T; }
      if (resource === 'status') return { version: '2.1.2', backend: 'llamacpp' } as T;
      if (resource === 'memory/status') return { status: 'ready', agent_id: 'fixture' } as T;
      throw new Error(`unexpected read ${resource}`);
    },
    action: async (_nodeId, profile, action, target, body) => {
      node.actions.push(target ? `${action}:${target}` : action);
      if (node.failOnce.delete(action)) throw new Error(node.failMessage ?? `${action} failed on the node`);
      const value = body as Record<string, unknown> | undefined;
      if (action === 'profile-create') node.profiles.push({ id: profile, name: profile, backend: 'llamacpp', apiPort: value!['api_port'] as number, running: false, a2aEnabled: false, channels: {}, error: null });
      if (action === 'service-start' || action === 'service-restart') node.profiles.find(item => item.id === profile)!.running = true;
      if (action === 'identity-save') { node.identity[target!] = value!['text'] as string; return { revision: 'saved' }; }
      if (action === 'config-save') { node.config = value!['text'] as string; return { revision: 'saved', activation_required: true }; }
      if (action === 'skill-set') { const doc = YAML.parse(node.config) as { skills: { enabled: string[] } }; doc.skills.enabled.push(target!); node.config = YAML.stringify(doc); return { revision: 'saved' }; }
      if (action === 'hivemem-credential-set') node.env.push(value!['token'] as string);
      if (action === 'instance-ref-set') node.env.push(`ARDENT_INSTANCE_REF=${String(value!['instance_ref'])}`);
      if (action === 'model-credential-set') node.env.push(`ARDENT_LLAMA_API_KEY=${String(value!['api_key'])}`);
      return { running: true };
    },
    studio: async () => undefined,
    hivemem: () => ({ apiUrl: 'https://memory.example.com/', agentUrl: 'https://memory.example.com/', auth: { kind: 'token', token: 'fixture-enrollment-token' }, workspaceId: 'agents', hours: 720 }),
    prepare,
    credential,
    supportsRenewal: async () => renewalSupported,
    record,
    delay: async () => undefined,
    owners: async () => owners,
    explain: async (_nodeId, error) => (error instanceof Error && error.message === 'outcome unknown' ? new Error('The node could not confirm the outcome of service-start on lead (command native-1).') : undefined),
    emberpathExplicit: () => true,
    emberpathKey: async (baseUrl, key, alias) => { keyChecks.push({ baseUrl, key, alias }); return keyAnswer(); },
  };
  deploy.setArdentDeployDeps(fakeDeps);
});
afterEach(() => { deploy.setArdentDeployDeps({}); vi.unstubAllEnvs(); });

async function run(start: () => Promise<string>) {
  const id = await start();
  await deploy.settleArdentAgentOperation(id);
  return deploy.getArdentAgentOperation(id);
}

describe('New Agent operation', () => {
  it('leaves ARDENT_INSTANCE_REF to a later upgrade when the node agent cannot write it, and still creates the agent', async () => {
    const { HttpError } = await import('../middleware/error-handler.js');
    deploy.setArdentDeployDeps({ ...fakeDeps, studio: async (_nodeId, level) => {
      if ((level ?? 1) >= 4) throw new HttpError(409, 'AGENT_UPGRADE_REQUIRED', 'Upgrade the Magnus agent on node-1');
    } });
    const operation = await run(() => deploy.startArdentAgentDeploy(input, actor));
    expect(operation.status).toBe('succeeded');
    expect(node.actions).not.toContain('instance-ref-set');
    expect(operation.steps[0]!.receipt).toMatchObject({ instanceRef: null, instanceRefNote: expect.stringContaining('ARDENT_INSTANCE_REF') });
  });

  it('creates, configures and starts an agent with HiveMem, step by step', async () => {
    const operation = await run(() => deploy.startArdentAgentDeploy(input, actor));
    expect(operation.status).toBe('succeeded');
    expect(operation.steps.map(step => [step.name, step.status])).toEqual([
      ['profile-create', 'succeeded'], ['service-start', 'succeeded'], ['identity-soul', 'succeeded'], ['identity-identity', 'succeeded'],
      ['hivemem-enroll', 'succeeded'], ['config-save', 'succeeded'], ['skill-set', 'succeeded'], ['service-restart', 'succeeded'], ['ready-probe', 'succeeded'],
    ]);
    // 9910 is taken by the existing profile, so the first free port is chosen.
    expect(operation.request.apiPort).toBe(9911);
    expect(node.actions).toEqual(['profile-create', 'instance-ref-set', 'service-start', 'identity-save:soul', 'identity-save:identity', 'hivemem-credential-set',
      'config-save', 'skill-set:research', 'service-restart']);
    expect(operation.steps[0]!.receipt).toMatchObject({ instanceRef: `node-1.${operation.profile}` });
    const config = YAML.parse(node.config) as Record<string, any>;
    expect(config['providers']['llamacpp']).toMatchObject({ base_url: 'http://192.0.2.10:8080/v1', model: 'fixture-model' });
    expect(config['memory']).toEqual({ provider: 'hivemem', base_url: 'https://memory.example.com/', token_env: 'ARDENT_HIVEMEM_TOKEN',
      agent_id: operation.steps[4]!.receipt!['agentId'], workspace_id: 'agents', default_scope: 'private' });
    expect(node.identity).toEqual({ soul: '# Soul\n', identity: '# Identity\n' });
    expect(node.env).toEqual([`ARDENT_INSTANCE_REF=node-1.${operation.profile}`, TOKEN]);
    expect(operation.steps.find(step => step.name === 'skill-set')!.receipt).toMatchObject({ enabled: ['research'], alreadyEnabled: ['grounded-answers'] });
    // The token reached the node and nothing else: not the operation record, not the audit.
    expect(JSON.stringify([...store.rows.values()])).not.toContain(TOKEN);
    expect(JSON.stringify(store.audit)).not.toContain(TOKEN);
    expect(store.audit.filter(event => event.action === 'ardent.agent.step')).toHaveLength(9);
    expect(store.audit.map(event => event.action)).toContain('ardent.agent.complete');
  });

  it('sets the artifact limit on Ardent 2.2.0 or later, 64 MiB unless asked otherwise', async () => {
    ardentVersion = '2.2.0';
    await run(() => deploy.startArdentAgentDeploy(input, actor));
    expect((YAML.parse(node.config) as Record<string, any>)['artifacts']).toEqual({ max_bytes: 64 * 1024 * 1024 });
    node.profiles = node.profiles.filter(item => item.id !== 'lead');
    node.config = TEMPLATE;
    await run(() => deploy.startArdentAgentDeploy({ ...input, artifacts_max_bytes: 8 * 1024 * 1024 }, actor));
    expect((YAML.parse(node.config) as Record<string, any>)['artifacts']).toEqual({ max_bytes: 8 * 1024 * 1024 });
    await expect(deploy.startArdentAgentDeploy({ ...input, profile: 'other', artifacts_max_bytes: 128 * 1024 * 1024 }, actor)).rejects.toMatchObject({ status: 400 });
  });

  it('names Magnus as the Agent Card provider on Ardent 3.4.0 or later, as older Ardent did, and keeps one the template sets', async () => {
    await run(() => deploy.startArdentAgentDeploy(input, actor));
    expect((YAML.parse(node.config) as Record<string, any>)['a2a']?.['provider']).toBeUndefined();
    ardentVersion = '3.4.0';
    node.profiles = node.profiles.filter(item => item.id !== 'lead');
    node.config = TEMPLATE;
    await run(() => deploy.startArdentAgentDeploy(input, actor));
    expect((YAML.parse(node.config) as Record<string, any>)['a2a']).toMatchObject({ provider: { organization: 'Magnus', url: 'https://github.com/ChefTaco/magnus' } });
    node.profiles = node.profiles.filter(item => item.id !== 'lead');
    node.config = `${TEMPLATE.trimEnd()}\na2a:\n  enabled: false\n  provider:\n    organization: Example Lab\n    url: https://example.com/\n`;
    await run(() => deploy.startArdentAgentDeploy(input, actor));
    expect((YAML.parse(node.config) as Record<string, any>)['a2a']).toEqual({ enabled: false, provider: { organization: 'Example Lab', url: 'https://example.com/' } });
  });

  it('leaves the artifact limit alone on an older Ardent and says so', async () => {
    const plain = await run(() => deploy.startArdentAgentDeploy(input, actor));
    expect((YAML.parse(node.config) as Record<string, any>)['artifacts']).toBeUndefined();
    expect(plain.steps.find(step => step.name === 'config-save')!.receipt!['notes']).toEqual([]);
    node.profiles = node.profiles.filter(item => item.id !== 'lead');
    node.config = TEMPLATE;
    const asked = await run(() => deploy.startArdentAgentDeploy({ ...input, artifacts_max_bytes: 8 * 1024 * 1024 }, actor));
    expect((YAML.parse(node.config) as Record<string, any>)['artifacts']).toBeUndefined();
    expect(asked.steps.find(step => step.name === 'config-save')!.receipt!['notes']).toEqual([expect.stringMatching(/needs Ardent 2\.2\.0.*2\.1\.2/)]);
  });

  it('stops at a failed step with its receipts, and resume reruns only what did not finish', async () => {
    node.failOnce.add('config-save');
    const failed = await run(() => deploy.startArdentAgentDeploy(input, actor));
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/^config-save: config-save failed on the node/);
    expect(failed.steps.map(step => step.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'failed', 'pending', 'pending', 'pending']);
    expect(failed.steps[4]!.receipt).toMatchObject({ action: 'enroll', tokenEnv: 'ARDENT_HIVEMEM_TOKEN' });
    const resumed = await run(() => deploy.resumeArdentAgentOperation(failed.id, { actorId: 'bob', details: {} }));
    expect(resumed.status).toBe('succeeded');
    expect(resumed.attempts).toBe(2);
    expect(node.actions.filter(action => action === 'profile-create')).toHaveLength(1);
    expect(credential).toHaveBeenCalledTimes(1);
    expect(store.audit).toContainEqual(expect.objectContaining({ action: 'ardent.agent.resume', actorId: 'bob' }));
    await expect(deploy.resumeArdentAgentOperation(failed.id, actor)).rejects.toMatchObject({ code: 'OPERATION_NOT_RESUMABLE' });
  });

  it('names an unknown command outcome in the failed step, and resumes only once it is reconciled', async () => {
    node.failOnce.add('service-start');
    node.failMessage = 'outcome unknown';
    const stopped = await run(() => deploy.startArdentAgentDeploy(input, actor));
    expect(stopped.status).toBe('failed');
    expect(stopped.steps.find(step => step.name === 'service-start')!.error).toBe('The node could not confirm the outcome of service-start on lead (command native-1).');
    owners = [{ commandId: 'native-1', state: 'unknown', label: 'ardent:lead:service-start', profile: 'lead', action: 'service-start', ardent: true,
      acquiredAt: '2026-11-08T00:00:00.000Z', dispatchedAt: '2026-11-08T00:00:01.000Z', deadline: '2026-11-08T00:02:05.000Z', reconcilableAfter: '2026-11-08T00:03:05.000Z' }];
    await expect(deploy.resumeArdentAgentOperation(stopped.id, actor)).rejects.toMatchObject({ status: 409, code: 'COMMAND_OWNER_UNSETTLED',
      message: expect.stringMatching(/could not confirm the outcome of service-start on lead \(command native-1\).*reconcile it on the Ardent installations page/) });
    owners = [{ ...owners[0]!, state: 'running' }];
    await expect(deploy.resumeArdentAgentOperation(stopped.id, actor)).rejects.toMatchObject({ message: expect.stringMatching(/still running on the node/) });
    expect((await deploy.getArdentAgentOperation(stopped.id)).status).toBe('failed');
    // Reconciled: nothing holds the node, and the operation finishes from service-start.
    owners = [];
    expect((await run(() => deploy.resumeArdentAgentOperation(stopped.id, actor))).status).toBe('succeeded');
  });

  it('refuses an existing profile, a used port and a missing HiveMem setup before creating anything', async () => {
    await expect(deploy.startArdentAgentDeploy({ ...input, profile: 'existing' }, actor)).rejects.toMatchObject({ code: 'PROFILE_EXISTS' });
    await expect(deploy.startArdentAgentDeploy({ ...input, apiPort: 9910 }, actor)).rejects.toMatchObject({ code: 'PORT_IN_USE' });
    await expect(deploy.startArdentAgentDeploy({ ...input, hivemem: false }, actor)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(deploy.startArdentAgentDeploy({ ...input, model: { base_url: 'https://user:pw@models.example.com/v1', model: 'm' } }, actor)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    // Magnus cannot reach HiveMem as itself: stop before the node is touched.
    prepare.mockRejectedValue(Object.assign(new Error('Oathweave refused the client credentials (HTTP 401)'), { status: 503, code: 'HIVEMEM_IDENTITY_UNAVAILABLE' }));
    await expect(deploy.startArdentAgentDeploy(input, actor)).rejects.toMatchObject({ code: 'HIVEMEM_IDENTITY_UNAVAILABLE' });
    await expect(deploy.startArdentHiveMemEnable('node-1', 'existing', actor)).rejects.toMatchObject({ code: 'HIVEMEM_IDENTITY_UNAVAILABLE' });
    expect(node.actions).toEqual([]);
    deploy.setArdentDeployDeps({ hivemem: () => { throw Object.assign(new Error('HiveMem enrollment is not configured'), { code: 'HIVEMEM_ENROLLMENT_UNAVAILABLE' }); } });
    await expect(deploy.startArdentAgentDeploy(input, actor)).rejects.toMatchObject({ code: 'HIVEMEM_ENROLLMENT_UNAVAILABLE' });
    expect(store.rows.size).toBe(0);
  });

  it('allows one running operation per profile', async () => {
    let release!: () => void;
    deploy.setArdentDeployDeps({ studio: async () => undefined, installation: async nodeId => ({ nodeId, nodeName: 'node-1', hostname: 'node-1.example.com', reachable: true,
      installed: true, version: '2.1.2', owner: 'operator', profiles: [{ id: 'existing', name: 'existing', backend: 'llamacpp', apiPort: 9910, running: true, a2aEnabled: false, channels: {}, error: null }],
      checkedAt: new Date().toISOString(), error: null }),
    hivemem: () => ({ apiUrl: 'https://memory.example.com/', agentUrl: 'https://memory.example.com/', auth: { kind: 'token', token: 't' }, workspaceId: 'agents', hours: 720 }),
    credential: () => new Promise(resolve => { release = () => resolve({ token: TOKEN, agentId: 'a', expiresAt: null, operationId: 'f'.repeat(64) }); }),
    read: async <T,>() => ({ status: 'ready' }) as T, action: async () => ({}) });
    const first = await deploy.startArdentHiveMemEnable('node-1', 'existing', actor);
    await expect(deploy.startArdentHiveMemEnable('node-1', 'existing', actor)).rejects.toMatchObject({ code: 'OPERATION_RUNNING' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await deploy.settleArdentAgentOperation(first);
  });
});

describe('Enable HiveMem', () => {
  it('rotates the credential of an agent HiveMem already knows, then activates it', async () => {
    credential.mockImplementationOnce(async () => { throw new HiveMemEnrollmentError(409, 'HiveMem enroll answered HTTP 409'); });
    const operation = await run(() => deploy.startArdentHiveMemEnable('node-1', 'existing', actor));
    expect(operation.status).toBe('succeeded');
    expect(operation.steps.map(step => step.name)).toEqual(['profile-check', 'hivemem-enroll', 'config-save', 'service-restart', 'ready-probe']);
    expect(credential.mock.calls.map(call => (call[1] as { action: string }).action)).toEqual(['enroll', 'rotate']);
    expect(operation.steps[1]!.receipt).toMatchObject({ action: 'rotate' });
    expect(node.actions).toEqual(['hivemem-credential-set', 'config-save', 'service-restart']);
    // A backfill changes memory only: the model settings are untouched.
    expect((YAML.parse(node.config) as Record<string, any>)['providers']['llamacpp']['model']).toBe('${ARDENT_LLAMA_MODEL}');
    // The delivered credential is recorded for the renewal job, never with its token.
    expect(record).toHaveBeenCalledWith({ nodeId: 'node-1', profile: 'existing', agentId: expect.stringMatching(/^ardent-existing-/), workspaceId: 'agents',
      expiresAt: '2026-12-01T00:00:00.000Z' });
    expect(JSON.stringify(record.mock.calls)).not.toContain(TOKEN);
  });

  it('renews instead of rotating where HiveMem supports it, so a known agent gets a fresh deadline', async () => {
    renewalSupported = true;
    credential.mockImplementationOnce(async () => { throw new HiveMemEnrollmentError(409, 'HiveMem enroll answered HTTP 409'); });
    const operation = await run(() => deploy.startArdentHiveMemEnable('node-1', 'existing', actor));
    expect(operation.status).toBe('succeeded');
    expect(credential.mock.calls.map(call => (call[1] as { action: string }).action)).toEqual(['enroll', 'renew']);
    expect(credential.mock.calls[1]![1]).toMatchObject({ graceSeconds: 3600 });
    expect(operation.steps[1]!.receipt).toMatchObject({ action: 'renew' });
  });

  it('falls back to rotation when HiveMem refuses the renewal, and stops after that', async () => {
    renewalSupported = true;
    credential.mockImplementationOnce(async () => { throw new HiveMemEnrollmentError(409, 'exists'); })
      .mockImplementationOnce(async () => { throw new HiveMemEnrollmentError(403, 'not a member'); });
    const operation = await run(() => deploy.startArdentHiveMemEnable('node-1', 'existing', actor));
    expect(operation.status).toBe('succeeded');
    expect(credential.mock.calls.map(call => (call[1] as { action: string }).action)).toEqual(['enroll', 'renew', 'rotate']);

    credential.mockReset();
    credential.mockImplementationOnce(async () => { throw new HiveMemEnrollmentError(409, 'exists'); })
      .mockImplementation(async () => { throw new HiveMemEnrollmentError(400, 'deadline'); });
    const failed = await run(() => deploy.startArdentHiveMemEnable('node-1', 'existing', actor));
    expect(failed.status).toBe('failed');
    expect(credential.mock.calls.map(call => (call[1] as { action: string }).action)).toEqual(['enroll', 'renew']);
    expect(node.actions.filter(action => action === 'hivemem-credential-set')).toHaveLength(1);
  });

  it('refuses a stopped profile and leaves it unchanged', async () => {
    node.profiles[0]!.running = false;
    const operation = await run(() => deploy.startArdentHiveMemEnable('node-1', 'existing', actor));
    expect(operation.status).toBe('failed');
    expect(operation.error).toMatch(/Start the Ardent profile/);
    expect(node.actions).toEqual([]);
    expect(credential).not.toHaveBeenCalled();
  });
});

describe('New Agent with an Emberpath alias', () => {
  const GATEWAY = 'https://models.example.com/v1';
  const KEY = 'fixture-emberpath-client-key-0002';
  const aliased = { ...input, model: { emberpath_alias: 'general' }, emberpath_client_key: KEY };
  const { emberpath_client_key: _key, ...keyless } = aliased;
  beforeEach(() => { vi.stubEnv('MAGNUS_ARDENT_EMBERPATH_URL', GATEWAY); });

  it('checks the key with Emberpath, writes it to the profile before the configuration names it, and never keeps it', async () => {
    const levels: number[] = [];
    deploy.setArdentDeployDeps({ ...fakeDeps, studio: async (_nodeId, level) => { levels.push(level ?? 1); } });
    const operation = await run(() => deploy.startArdentAgentDeploy(aliased, actor));
    expect(operation.status).toBe('succeeded');
    expect(keyChecks).toEqual([{ baseUrl: GATEWAY, key: KEY, alias: 'general' }]);
    expect(levels).toContain(6);
    expect(node.actions).toEqual(['profile-create', 'instance-ref-set', 'service-start', 'identity-save:soul', 'identity-save:identity', 'hivemem-credential-set',
      'model-credential-set', 'config-save', 'skill-set:research', 'service-restart']);
    expect(node.env).toContain(`ARDENT_LLAMA_API_KEY=${KEY}`);
    const config = YAML.parse(node.config) as Record<string, any>;
    expect(config['providers']['llamacpp']).toEqual({ base_url: GATEWAY, model: 'general', api_key_env: 'ARDENT_LLAMA_API_KEY' });
    expect(operation.steps.find(step => step.name === 'config-save')!.receipt).toMatchObject({ modelKeyEnv: 'ARDENT_LLAMA_API_KEY', modelKeyConfigured: true });
    expect(operation.request.model).toEqual({ emberpath_alias: 'general' });
    expect(store.audit.find(event => event.action === 'ardent.agent.deploy')!.details).toMatchObject({ emberpathClientKey: 'checked' });
    expect(JSON.stringify([operation, [...store.rows.values()], store.audit])).not.toContain(KEY);
  });

  it('refuses an alias without a key, a key without an alias, and a key for an Emberpath only the Registry named, before creating anything', async () => {
    await expect(deploy.startArdentAgentDeploy(keyless, actor)).rejects.toMatchObject({ status: 400, code: 'EMBERPATH_KEY_REQUIRED',
      message: expect.stringMatching(/^Emberpath key missing: .*emberpath_client_key$/u) });
    await expect(deploy.startArdentAgentDeploy({ ...input, emberpath_client_key: KEY }, actor)).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    await expect(deploy.startArdentAgentDeploy({ ...aliased, emberpath_client_key: 'short' }, actor)).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    deploy.setArdentDeployDeps({ ...fakeDeps, emberpathExplicit: () => false });
    await expect(deploy.startArdentAgentDeploy(aliased, actor)).rejects.toMatchObject({ status: 409, code: 'EMBERPATH_NOT_EXPLICIT',
      message: expect.stringContaining('MAGNUS_ARDENT_EMBERPATH_URL') });
    expect(keyChecks).toEqual([]);
    expect(node.actions).toEqual([]);
    expect(store.rows.size).toBe(0);
  });

  it('refuses a key Emberpath rejects, and a node agent that cannot deliver one', async () => {
    const { HttpError } = await import('../middleware/error-handler.js');
    keyAnswer = async () => { throw new HttpError(422, 'EMBERPATH_KEY_INVALID', 'Emberpath refused the client key (401)'); };
    await expect(deploy.startArdentAgentDeploy(aliased, actor)).rejects.toMatchObject({ status: 422, code: 'EMBERPATH_KEY_INVALID' });
    keyAnswer = async () => ({ checked: true });
    deploy.setArdentDeployDeps({ ...fakeDeps, studio: async (_nodeId, level) => {
      if ((level ?? 1) >= 6) throw new HttpError(409, 'AGENT_UPGRADE_REQUIRED', 'Upgrade the Magnus agent on node-1');
    } });
    await expect(deploy.startArdentAgentDeploy(aliased, actor)).rejects.toMatchObject({ status: 409, code: 'AGENT_UPGRADE_REQUIRED' });
    expect(node.actions).toEqual([]);
    expect(store.rows.size).toBe(0);
  });

  it('goes on when Emberpath cannot be asked from the server, and says so in the audit', async () => {
    keyAnswer = async () => ({ checked: false, reason: 'Emberpath could not be reached from the Magnus server to check the client key' });
    const operation = await run(() => deploy.startArdentAgentDeploy(aliased, actor));
    expect(operation.status).toBe('succeeded');
    expect(store.audit.find(event => event.action === 'ardent.agent.deploy')!.details!['emberpathClientKey']).toMatch(/^unchecked: Emberpath could not be reached/u);
  });

  it('needs the key again on resume only when it never reached the profile and the server no longer holds it', async () => {
    const { releaseEmberpathClientKey } = await import('./ardent-emberpath-key.js');
    node.failOnce.add('hivemem-credential-set');
    const failed = await run(() => deploy.startArdentAgentDeploy(aliased, actor));
    expect(failed.status).toBe('failed');
    // As after a server restart: the key lived only in the old process's memory.
    releaseEmberpathClientKey(failed.id);
    await expect(deploy.resumeArdentAgentOperation(failed.id, actor)).rejects.toMatchObject({ status: 409, code: 'EMBERPATH_KEY_REQUIRED',
      message: expect.stringContaining('resume with it again') });
    await expect(deploy.resumeArdentAgentOperation(failed.id, actor, { emberpath_client_key: 'not a key' })).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    const resumed = await run(() => deploy.resumeArdentAgentOperation(failed.id, actor, { emberpath_client_key: KEY }));
    expect(resumed.status).toBe('succeeded');
    expect(node.actions.filter(action => action === 'model-credential-set')).toHaveLength(1);
    expect(keyChecks).toHaveLength(2);
    expect(store.audit.find(event => event.action === 'ardent.agent.resume')!.details).toMatchObject({ emberpathClientKey: 'supplied' });
    expect(JSON.stringify([resumed, [...store.rows.values()], store.audit])).not.toContain(KEY);
  });

  it('does not deliver the key twice when the configuration fails after it, and refuses a key it no longer needs', async () => {
    node.failOnce.add('config-save');
    const failed = await run(() => deploy.startArdentAgentDeploy(aliased, actor));
    expect(failed.status).toBe('failed');
    expect(failed.steps.find(step => step.name === 'config-save')!.receipt).toMatchObject({ modelKeyConfigured: true });
    await expect(deploy.resumeArdentAgentOperation(failed.id, actor, { emberpath_client_key: KEY })).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    const resumed = await run(() => deploy.resumeArdentAgentOperation(failed.id, actor));
    expect(resumed.status).toBe('succeeded');
    expect(node.actions.filter(action => action === 'model-credential-set')).toHaveLength(1);
    expect((YAML.parse(node.config) as Record<string, any>)['providers']['llamacpp']['api_key_env']).toBe('ARDENT_LLAMA_API_KEY');
  });
});

describe('Set Emberpath key on an existing agent', () => {
  const GATEWAY = 'https://models.example.com/v1';
  const KEY = 'fixture-emberpath-client-key-0005';
  const ROTATED = 'fixture-emberpath-client-key-0006';
  const EXISTING = 'schema_version: 1\nprofile: existing\nname: existing\nexecution:\n  backend: llamacpp\nproviders:\n  llamacpp:\n'
    + `    base_url: ${GATEWAY}/\n    model: general\nmemory:\n  provider: none\nskills:\n  directories: [skills]\n  enabled: []\n`;
  let logged: string[] = [];
  beforeEach(() => {
    vi.stubEnv('MAGNUS_ARDENT_EMBERPATH_URL', GATEWAY);
    node.config = EXISTING;
    logged = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const)
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  });
  afterEach(() => { vi.restoreAllMocks(); });
  const set = (body: unknown, profile = 'existing') => deploy.startArdentModelCredentialSet('node-1', profile, body, actor);

  it('checks the key with Emberpath, writes it to the profile, names it in the configuration and restarts, keeping nothing', async () => {
    const levels: number[] = [];
    deploy.setArdentDeployDeps({ ...fakeDeps, studio: async (_nodeId, level) => { levels.push(level ?? 1); } });
    const operation = await run(() => set({ emberpath_client_key: KEY }));
    expect(operation.status).toBe('succeeded');
    expect(operation.kind).toBe('model-credential');
    expect(operation.steps.map(step => [step.name, step.status])).toEqual([
      ['profile-check', 'succeeded'], ['config-save', 'succeeded'], ['service-restart', 'succeeded'], ['ready-probe', 'succeeded']]);
    expect(levels).toContain(6);
    // The alias comes from the profile's configuration; the base URL matches with or without its final slash.
    expect(keyChecks).toEqual([{ baseUrl: GATEWAY, key: KEY, alias: 'general' }]);
    expect(node.actions).toEqual(['model-credential-set', 'config-save', 'service-restart']);
    expect(node.env).toEqual([`ARDENT_LLAMA_API_KEY=${KEY}`]);
    const config = YAML.parse(node.config) as Record<string, any>;
    expect(config['providers']['llamacpp']).toEqual({ base_url: `${GATEWAY}/`, model: 'general', api_key_env: 'ARDENT_LLAMA_API_KEY' });
    // Only the model key changes: memory, skills and everything else stay as they were.
    expect(config['memory']).toEqual({ provider: 'none' });
    expect(credential).not.toHaveBeenCalled();
    expect(operation.request.model).toEqual({ emberpath_alias: 'general' });
    expect(operation.steps[1]!.receipt).toMatchObject({ modelKeyEnv: 'ARDENT_LLAMA_API_KEY', modelKeyConfigured: true, previousKeyEnv: null });
    expect(store.audit.find(event => event.action === 'ardent.agent.model-credential')!.details).toMatchObject({
      model: { emberpath_alias: 'general' }, keyEnv: 'ARDENT_LLAMA_API_KEY', emberpathClientKey: 'checked' });
    expect(JSON.stringify([operation, [...store.rows.values()], store.audit, logged])).not.toContain(KEY);
  });

  it('rotates a key, and restarts nothing when neither the key nor the configuration changed', async () => {
    let changed = true;
    deploy.setArdentDeployDeps({ ...fakeDeps, action: async (nodeId, profile, action, target, body) => {
      const result = await fakeDeps.action!(nodeId, profile, action, target, body);
      return action === 'model-credential-set' ? { keyEnv: 'ARDENT_LLAMA_API_KEY', configured: true, changed } : result;
    } });
    expect((await run(() => set({ emberpath_client_key: KEY }))).status).toBe('succeeded');
    const rotated = await run(() => set({ emberpath_client_key: ROTATED }));
    expect(rotated.status).toBe('succeeded');
    // The configuration already names the key, so only the .env changed; the restart activates the new key.
    expect(rotated.steps.map(step => [step.name, step.status])).toEqual([
      ['profile-check', 'succeeded'], ['config-save', 'skipped'], ['service-restart', 'succeeded'], ['ready-probe', 'succeeded']]);
    expect(rotated.steps[1]!.receipt).toMatchObject({ modelKeyChanged: true, unchanged: true, previousKeyEnv: 'ARDENT_LLAMA_API_KEY' });
    changed = false;
    node.actions = [];
    const same = await run(() => set({ emberpath_client_key: ROTATED }));
    expect(same.steps.map(step => [step.name, step.status])).toEqual([
      ['profile-check', 'succeeded'], ['config-save', 'skipped'], ['service-restart', 'skipped'], ['ready-probe', 'succeeded']]);
    expect(node.actions).toEqual(['model-credential-set']);
    expect(JSON.stringify([[...store.rows.values()], store.audit, logged])).not.toMatch(/fixture-emberpath-client-key-000[56]/u);
  });

  it('refuses a missing or malformed key, an implicit Emberpath, an old node agent and a model that is not an Emberpath alias, before anything runs', async () => {
    const { HttpError } = await import('../middleware/error-handler.js');
    await expect(set({})).rejects.toMatchObject({ status: 400, code: 'EMBERPATH_KEY_REQUIRED', message: expect.stringMatching(/^Emberpath key missing/u) });
    await expect(set(null)).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    const malformed = set({ emberpath_client_key: 'has a space in it, not a key' });
    await expect(malformed).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    await malformed.catch((error: Error) => expect(error.message).not.toContain('not a key'));
    await expect(set({ emberpath_client_key: KEY, extra: true })).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    deploy.setArdentDeployDeps({ ...fakeDeps, emberpathExplicit: () => false });
    await expect(set({ emberpath_client_key: KEY })).rejects.toMatchObject({ status: 409, code: 'EMBERPATH_NOT_EXPLICIT' });
    deploy.setArdentDeployDeps({ ...fakeDeps, studio: async (_nodeId, level) => {
      if ((level ?? 1) >= 6) throw new HttpError(409, 'AGENT_UPGRADE_REQUIRED', 'Upgrade the Magnus agent on node-1 to deliver an Emberpath client key');
    } });
    await expect(set({ emberpath_client_key: KEY })).rejects.toMatchObject({ status: 409, code: 'AGENT_UPGRADE_REQUIRED' });
    deploy.setArdentDeployDeps(fakeDeps);
    await expect(set({ emberpath_client_key: KEY }, 'missing')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    for (const config of [TEMPLATE, EXISTING.replace(`${GATEWAY}/`, 'http://192.0.2.10:8080/v1'), EXISTING.replace('backend: llamacpp', 'backend: codex')]) {
      node.config = config;
      await expect(set({ emberpath_client_key: KEY })).rejects.toMatchObject({ status: 409, code: 'MODEL_NOT_EMBERPATH' });
    }
    node.config = EXISTING;
    node.profiles[0]!.running = false;
    await expect(set({ emberpath_client_key: KEY })).rejects.toMatchObject({ status: 409, code: 'PROFILE_NOT_RUNNING' });
    expect(keyChecks).toEqual([]);
    expect(node.actions).toEqual([]);
    expect(store.rows.size).toBe(0);
    expect(store.audit).toEqual([]);
  });

  it('refuses a key Emberpath rejects or that may not use the alias, and reports one it could not check', async () => {
    const { HttpError } = await import('../middleware/error-handler.js');
    for (const code of ['EMBERPATH_KEY_INVALID', 'EMBERPATH_KEY_FORBIDDEN', 'EMBERPATH_ALIAS_UNAVAILABLE']) {
      keyAnswer = async () => { throw new HttpError(422, code, 'Emberpath refused the client key'); };
      await expect(set({ emberpath_client_key: KEY })).rejects.toMatchObject({ status: 422, code });
    }
    expect(node.actions).toEqual([]);
    expect(store.rows.size).toBe(0);
    keyAnswer = async () => ({ checked: false, reason: 'Emberpath could not be reached from the Magnus server to check the client key' });
    expect((await run(() => set({ emberpath_client_key: KEY }))).status).toBe('succeeded');
    expect(store.audit.find(event => event.action === 'ardent.agent.model-credential')!.details!['emberpathClientKey']).toMatch(/^unchecked: /u);
  });

  it('needs the key again on resume only when it never reached the profile and the server no longer holds it', async () => {
    const { releaseEmberpathClientKey } = await import('./ardent-emberpath-key.js');
    node.failOnce.add('model-credential-set');
    const failed = await run(() => set({ emberpath_client_key: KEY }));
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/^config-save: /u);
    releaseEmberpathClientKey(failed.id);
    await expect(deploy.resumeArdentAgentOperation(failed.id, actor)).rejects.toMatchObject({ status: 409, code: 'EMBERPATH_KEY_REQUIRED' });
    const resumed = await run(() => deploy.resumeArdentAgentOperation(failed.id, actor, { emberpath_client_key: KEY }));
    expect(resumed.status).toBe('succeeded');
    expect(keyChecks.at(-1)).toEqual({ baseUrl: GATEWAY, key: KEY, alias: 'general' });
    expect(node.env).toEqual([`ARDENT_LLAMA_API_KEY=${KEY}`]);
    // A failure after the key arrived resumes without it, and refuses it.
    node.failOnce.add('service-restart');
    const later = await run(() => set({ emberpath_client_key: ROTATED }));
    expect(later.status).toBe('failed');
    await expect(deploy.resumeArdentAgentOperation(later.id, actor, { emberpath_client_key: ROTATED })).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect((await run(() => deploy.resumeArdentAgentOperation(later.id, actor))).status).toBe('succeeded');
    expect(node.actions.filter(action => action === 'model-credential-set')).toHaveLength(3);
    expect(JSON.stringify([[...store.rows.values()], store.audit, logged])).not.toMatch(/fixture-emberpath-client-key-000[56]/u);
  });

  it('allows one running operation per profile', async () => {
    let release: () => void = () => undefined;
    deploy.setArdentDeployDeps({ ...fakeDeps, delay: () => new Promise<void>(resolve => { release = resolve; }),
      read: async <T,>(nodeId: string, profile: string, resource: string) => {
        if (resource === 'status') throw new Error('not yet');
        return fakeDeps.read!<T>(nodeId, profile, resource);
      } });
    const first = await set({ emberpath_client_key: KEY });
    await expect(set({ emberpath_client_key: ROTATED })).rejects.toMatchObject({ status: 409, code: 'OPERATION_RUNNING' });
    deploy.setArdentDeployDeps(fakeDeps);
    release();
    await deploy.settleArdentAgentOperation(first);
  });
});

const { checkEmberpathClientKey } = await import('./ardent-emberpath-key.js');
describe('the Emberpath client key check', () => {
  const KEY = 'fixture-emberpath-client-key-0003';
  const answer = (status: number, body: unknown) => vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));

  it('asks the model list with the key as a bearer token and finds the alias there', async () => {
    const fetcher = answer(200, { object: 'list', data: [{ id: 'general' }, { id: 'coder' }] });
    expect(await checkEmberpathClientKey('https://models.example.com/v1', KEY, 'general', fetcher as typeof fetch)).toEqual({ checked: true });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://models.example.com/v1/models');
    expect(new Headers(init!.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    expect(init!.redirect).toBe('error');
    await expect(checkEmberpathClientKey('https://models.example.com/v1/', KEY, 'missing', fetcher as typeof fetch))
      .rejects.toMatchObject({ status: 422, code: 'EMBERPATH_ALIAS_UNAVAILABLE' });
  });

  it('turns a refusal into an actionable error that never repeats the key', async () => {
    for (const [status, code] of [[401, 'EMBERPATH_KEY_INVALID'], [403, 'EMBERPATH_KEY_FORBIDDEN']] as const) {
      const refused = checkEmberpathClientKey('https://models.example.com/v1', KEY, 'general', answer(status, { error: 'Invalid API key' }) as typeof fetch);
      await expect(refused).rejects.toMatchObject({ status: 422, code });
      await refused.catch((error: Error) => expect(error.message).not.toContain(KEY));
    }
  });

  it('reports a key it could not check without refusing it', async () => {
    const offline = vi.fn(async () => { throw new TypeError('fetch failed'); });
    expect(await checkEmberpathClientKey('https://models.example.com/v1', KEY, 'general', offline as typeof fetch))
      .toEqual({ checked: false, reason: expect.stringContaining('could not be reached') });
    expect(await checkEmberpathClientKey('https://models.example.com/v1', KEY, 'general', answer(502, 'bad gateway') as typeof fetch))
      .toEqual({ checked: false, reason: expect.stringContaining('HTTP 502') });
    expect(await checkEmberpathClientKey('https://models.example.com/v1', KEY, 'general', answer(200, 'not json') as typeof fetch))
      .toEqual({ checked: false, reason: expect.stringContaining('model list') });
  });
});
