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
const { HiveMemEnrollmentError } = await import('./ardent-hivemem.js');

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJmaXh0dXJlIjp0cnVlfQ.fixture-signature-value';
const TEMPLATE = 'schema_version: 1\nprofile: lead\nname: lead\nexecution:\n  backend: llamacpp\nproviders:\n  llamacpp:\n    base_url: ${ARDENT_LLAMA_BASE_URL}\n    model: ${ARDENT_LLAMA_MODEL}\nmemory:\n  provider: none\nskills:\n  directories: [skills]\n  enabled: [grounded-answers]\n';
const actor = { actorId: 'alice', details: {} };
const input = { nodeId: 'node-1', profile: 'lead', soul_md: '# Soul\n', identity_md: '# Identity\n',
  model: { base_url: 'http://192.0.2.10:8080/v1', model: 'fixture-model' }, skills: ['grounded-answers', 'research'], hivemem: true };

interface Node { profiles: Array<{ id: string; name: string; backend: 'llamacpp'; apiPort: number; running: boolean; a2aEnabled: boolean; channels: Record<string, boolean>; error: null }>;
  config: string; identity: Record<string, string>; env: string[]; actions: string[]; failOnce: Set<string> }
let node: Node;
let ardentVersion = '2.1.2';
const credential = vi.fn();

beforeEach(() => {
  store.rows.clear();
  store.audit.length = 0;
  credential.mockReset();
  ardentVersion = '2.1.2';
  credential.mockImplementation(async (_settings: unknown, plan: { agentId: string; action: string }) => ({ token: TOKEN, agentId: plan.agentId, expiresAt: '2026-12-01T00:00:00.000Z', operationId: 'f'.repeat(64) }));
  node = { profiles: [{ id: 'existing', name: 'existing', backend: 'llamacpp', apiPort: 9910, running: true, a2aEnabled: false, channels: {}, error: null }],
    config: TEMPLATE, identity: { soul: 'template soul', identity: 'template identity' }, env: [], actions: [], failOnce: new Set() };
  deploy.setArdentDeployDeps({
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
      if (node.failOnce.delete(action)) throw new Error(`${action} failed on the node`);
      const value = body as Record<string, unknown> | undefined;
      if (action === 'profile-create') node.profiles.push({ id: profile, name: profile, backend: 'llamacpp', apiPort: value!['api_port'] as number, running: false, a2aEnabled: false, channels: {}, error: null });
      if (action === 'service-start' || action === 'service-restart') node.profiles.find(item => item.id === profile)!.running = true;
      if (action === 'identity-save') { node.identity[target!] = value!['text'] as string; return { revision: 'saved' }; }
      if (action === 'config-save') { node.config = value!['text'] as string; return { revision: 'saved', activation_required: true }; }
      if (action === 'skill-set') { const doc = YAML.parse(node.config) as { skills: { enabled: string[] } }; doc.skills.enabled.push(target!); node.config = YAML.stringify(doc); return { revision: 'saved' }; }
      if (action === 'hivemem-credential-set') node.env.push(value!['token'] as string);
      return { running: true };
    },
    studio: async () => undefined,
    hivemem: () => ({ apiUrl: 'https://memory.example.com/', agentUrl: 'https://memory.example.com/', token: 'fixture-enrollment-token', workspaceId: 'agents', hours: 720 }),
    credential,
    delay: async () => undefined,
  });
});
afterEach(() => { deploy.setArdentDeployDeps({}); });

async function run(start: () => Promise<string>) {
  const id = await start();
  await deploy.settleArdentAgentOperation(id);
  return deploy.getArdentAgentOperation(id);
}

describe('New Agent operation', () => {
  it('creates, configures and starts an agent with HiveMem, step by step', async () => {
    const operation = await run(() => deploy.startArdentAgentDeploy(input, actor));
    expect(operation.status).toBe('succeeded');
    expect(operation.steps.map(step => [step.name, step.status])).toEqual([
      ['profile-create', 'succeeded'], ['service-start', 'succeeded'], ['identity-soul', 'succeeded'], ['identity-identity', 'succeeded'],
      ['hivemem-enroll', 'succeeded'], ['config-save', 'succeeded'], ['skill-set', 'succeeded'], ['service-restart', 'succeeded'], ['ready-probe', 'succeeded'],
    ]);
    // 9910 is taken by the existing profile, so the first free port is chosen.
    expect(operation.request.apiPort).toBe(9911);
    expect(node.actions).toEqual(['profile-create', 'service-start', 'identity-save:soul', 'identity-save:identity', 'hivemem-credential-set',
      'config-save', 'skill-set:research', 'service-restart']);
    const config = YAML.parse(node.config) as Record<string, any>;
    expect(config['providers']['llamacpp']).toMatchObject({ base_url: 'http://192.0.2.10:8080/v1', model: 'fixture-model' });
    expect(config['memory']).toEqual({ provider: 'hivemem', base_url: 'https://memory.example.com/', token_env: 'ARDENT_HIVEMEM_TOKEN',
      agent_id: operation.steps[4]!.receipt!['agentId'], workspace_id: 'agents', default_scope: 'private' });
    expect(node.identity).toEqual({ soul: '# Soul\n', identity: '# Identity\n' });
    expect(node.env).toEqual([TOKEN]);
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

  it('refuses an existing profile, a used port and a missing HiveMem setup before creating anything', async () => {
    await expect(deploy.startArdentAgentDeploy({ ...input, profile: 'existing' }, actor)).rejects.toMatchObject({ code: 'PROFILE_EXISTS' });
    await expect(deploy.startArdentAgentDeploy({ ...input, apiPort: 9910 }, actor)).rejects.toMatchObject({ code: 'PORT_IN_USE' });
    await expect(deploy.startArdentAgentDeploy({ ...input, hivemem: false }, actor)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(deploy.startArdentAgentDeploy({ ...input, model: { base_url: 'https://user:pw@models.example.com/v1', model: 'm' } }, actor)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    deploy.setArdentDeployDeps({ hivemem: () => { throw Object.assign(new Error('HiveMem enrollment is not configured'), { code: 'HIVEMEM_ENROLLMENT_UNAVAILABLE' }); } });
    await expect(deploy.startArdentAgentDeploy(input, actor)).rejects.toMatchObject({ code: 'HIVEMEM_ENROLLMENT_UNAVAILABLE' });
    expect(store.rows.size).toBe(0);
  });

  it('allows one running operation per profile', async () => {
    let release!: () => void;
    deploy.setArdentDeployDeps({ studio: async () => undefined, installation: async nodeId => ({ nodeId, nodeName: 'node-1', hostname: 'node-1.example.com', reachable: true,
      installed: true, version: '2.1.2', owner: 'operator', profiles: [{ id: 'existing', name: 'existing', backend: 'llamacpp', apiPort: 9910, running: true, a2aEnabled: false, channels: {}, error: null }],
      checkedAt: new Date().toISOString(), error: null }),
    hivemem: () => ({ apiUrl: 'https://memory.example.com/', agentUrl: 'https://memory.example.com/', token: 't', workspaceId: 'agents', hours: 720 }),
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
