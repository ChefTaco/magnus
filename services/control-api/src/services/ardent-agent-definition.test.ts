import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { agentDefinitionSha256, sealAgentDefinition, type AgentDefinition, type ArdentFleetInstallation, type ArdentRetainedExtension } from '@hivemagnus/magnus-contracts';

type Row = { id: string; kind: string; nodeId: string; profile: string; status: string; requestJson: string; stepsJson: string;
  error: string | null; createdBy: string; actingJson: string | null; attempts: number; createdAt: Date; updatedAt: Date; completedAt: Date | null };
const store = vi.hoisted(() => ({ rows: new Map<string, Row>(), audit: [] as Array<{ action: string; details?: Record<string, unknown> }> }));
vi.mock('../db/index.js', () => ({ getDb: () => ({ ardentAgentOperation: {
  create: async ({ data }: { data: Partial<Row> & { id: string; nodeId: string; profile: string } }) => {
    const row: Row = { status: 'running', stepsJson: '[]', error: null, actingJson: null, attempts: 1, createdAt: new Date(), updatedAt: new Date(), completedAt: null,
      kind: '', requestJson: '', createdBy: '', ...data };
    store.rows.set(row.id, row);
    return { ...row };
  },
  findUnique: async ({ where }: { where: { id: string } }) => { const row = store.rows.get(where.id); return row ? { ...row } : null; },
  update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => { const row = store.rows.get(where.id)!; Object.assign(row, data); row.updatedAt = new Date(); return { ...row }; },
} }) }));
vi.mock('./audit-service.js', () => ({ logAuditEvent: async (event: { action: string; details?: Record<string, unknown> }) => { store.audit.push(event); } }));

const deploy = await import('./ardent-agent-deploy.js');
const definitions = await import('./ardent-agent-definition.js');
const { HttpError } = await import('../middleware/error-handler.js');
const { AgentResponseError } = await import('../sdk/node-api-client.js');

const GATEWAY = 'https://models.example.com/v1';
const sri = (value: string) => `sha512-${createHash('sha512').update(value).digest('base64')}`;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const EXTENSIONS: ArdentRetainedExtension[] = [
  { name: '@example/ardent-media', version: '0.2.0', integrity: sri('media archive'), packageTreeSha256: sha('media tree') },
  { name: '@example/ardent-tools', version: '1.4.1', integrity: sri('tools archive'), packageTreeSha256: sha('tools tree') },
];
/** HiveSkills: web-research is promoted; citations and summaries are kept, immutable releases that are not. */
const RELEASES: Record<string, { version: string; sha256: string; promoted: boolean }> = {
  'web-research': { version: '1.2.0', sha256: sha('web-research 1.2.0'), promoted: true },
  citations: { version: '2.0.0', sha256: sha('citations 2.0.0'), promoted: false },
  summaries: { version: '0.3.1', sha256: sha('summaries 0.3.1'), promoted: false },
};
const SOUL = '# Soul\n\nYou are a careful researcher. You cite every claim.\n';
const IDENTITY = '# Identity\n\nName: Lead Researcher\n';
const SOURCE_CONFIG = `schema_version: 1
profile: lead
name: Lead Researcher
execution:
  backend: llamacpp
  deadline_seconds: 900
  max_parallel_tasks: 2
providers:
  llamacpp:
    base_url: ${GATEWAY}
    model: research-large
    api_key_env: LLAMACPP_API_KEY
memory:
  provider: hivemem
  base_url: https://memory.example.com/
  token_env: ARDENT_HIVEMEM_TOKEN
  agent_id: ardent-lead-0a1b2c3d
  workspace_id: agents
skills:
  directories: [skills]
  enabled: [web-research, citations, summaries, local-notes]
plugins: ['@example/ardent-media', '@example/ardent-tools/search']
channels:
  telegram:
    enabled: true
    token_env: TELEGRAM_BOT_TOKEN
artifacts:
  max_bytes: 33554432
api:
  host: 127.0.0.1
  port: 9910
  token_env: ARDENT_API_TOKEN
`;
const template = (profile: string) => `schema_version: 1\nprofile: ${profile}\nname: ${profile}\nexecution:\n  backend: llamacpp\nproviders:\n  llamacpp:\n    base_url: \${ARDENT_LLAMA_BASE_URL}\n    model: \${ARDENT_LLAMA_MODEL}\n    api_key_env: LLAMACPP_API_KEY\nmemory:\n  provider: none\nskills:\n  directories: [skills]\n  enabled: []\n`;

interface Profile { config: string; soul: string; identity: string; receipts: Map<string, { version: string; sha256: string }>; running: boolean; apiPort: number }
interface Node { version: string; extensions: ArdentRetainedExtension[] | undefined; capabilities: Record<string, number>; profiles: Map<string, Profile>; actions: string[] }
let nodes: Record<string, Node>;
let targetConfigured: boolean;

function installation(nodeId: string): ArdentFleetInstallation {
  const node = nodes[nodeId];
  if (!node) throw new Error('Managed node not found');
  return { nodeId, nodeName: nodeId, hostname: `${nodeId}.example.com`, reachable: true, installed: true, version: node.version, owner: 'operator',
    packageName: '@hivemagnus/ardent', checkedAt: new Date().toISOString(), error: null, capabilities: node.capabilities,
    ...(node.extensions !== undefined ? { extensions: node.extensions } : {}),
    profiles: [...node.profiles.entries()].map(([id, profile]) => ({ id, name: id, backend: 'llamacpp' as const, apiPort: profile.apiPort, running: profile.running,
      a2aEnabled: false, channels: {}, error: null })) };
}
function profileOf(nodeId: string, name: string): Profile {
  const profile = nodes[nodeId]?.profiles.get(name);
  if (!profile) throw new AgentResponseError(404, null);
  return profile;
}
async function read<T>(nodeId: string, name: string, resource: string): Promise<T> {
  const profile = profileOf(nodeId, name);
  if (resource === 'config') return { revision: sha(profile.config), text: profile.config } as T;
  if (resource === 'identity/soul') return { kind: 'soul', text: profile.soul, revision: sha(profile.soul) } as T;
  if (resource === 'identity/identity') return { kind: 'identity', text: profile.identity, revision: sha(profile.identity) } as T;
  if (resource === 'status') return { version: nodes[nodeId]!.version, backend: 'llamacpp' } as T;
  if (resource === 'memory/status') return { status: 'ready', agent_id: 'fixture-agent' } as T;
  throw new Error(`unexpected read ${resource}`);
}
async function skillReceipts(nodeId: string, name: string) {
  return { schema_version: 1 as const, skills: [...profileOf(nodeId, name).receipts.entries()].map(([skill, receipt]) => ({ name: skill, ...receipt })) };
}
/** What Magnus can get from HiveSkills: the promoted release anonymously, others only as its enrolled target. */
function release(name: string, version: string, pinned: boolean | undefined) {
  const known = RELEASES[name];
  if (!known || known.version !== version) throw new HttpError(409, 'SKILL_VERSION_UNAVAILABLE', `HiveSkills has no release ${name} ${version}`);
  if (!known.promoted && !pinned) throw new HttpError(409, 'SKILL_VERSION_UNAVAILABLE', `${name} ${version} is not promoted`);
  if (!known.promoted && !targetConfigured) throw new HttpError(409, 'SKILL_VERSION_UNAVAILABLE', `${name} ${version} is not promoted; set MAGNUS_ARDENT_HIVESKILLS_TARGET`);
  return known;
}
async function action(nodeId: string, name: string, kind: string, target?: string, body?: unknown): Promise<unknown> {
  const node = nodes[nodeId]!;
  node.actions.push(target ? `${kind}:${target}` : kind);
  const value = body as Record<string, any>;
  if (kind === 'profile-create') {
    node.profiles.set(name, { config: template(name), soul: 'template soul', identity: 'template identity', receipts: new Map(), running: false, apiPort: value['api_port'] });
    return { created: true };
  }
  const profile = profileOf(nodeId, name);
  if (kind === 'service-start' || kind === 'service-restart') { profile.running = true; return { running: true }; }
  if (kind === 'identity-save') { profile[target as 'soul' | 'identity'] = value['text']; return { revision: sha(value['text']) }; }
  if (kind === 'config-save') { profile.config = value['text']; return { revision: sha(profile.config) }; }
  if (kind === 'hivemem-credential-set') return { configured: true };
  if (kind === 'skill-install') {
    expect(value).not.toHaveProperty('pinned');
    expect(value['revision']).toBe(sha(profile.config));
    profile.receipts.set(value['name'], { version: value['version'], sha256: value['sha256'] });
    const config = YAML.parse(profile.config) as { skills: { enabled: string[] } };
    config.skills.enabled.push(value['name']);
    profile.config = YAML.stringify(config);
    return { source: 'hiveskills', name: value['name'], version: value['version'], sha256: value['sha256'], files: 1, changed: true, enabled: true,
      revision: sha(profile.config), enable_error: null, activation_required: true };
  }
  throw new Error(`unexpected action ${kind}`);
}

const HIVEMEM = { apiUrl: 'https://memory.example.com/', agentUrl: 'https://memory.example.com/', auth: { kind: 'token' as const, token: 'fixture-enrollment-token' }, workspaceId: 'agents', hours: 720 };
const actor = { actorId: 'alice', details: {} };
const BINDINGS = { hivemem: 'default', model: 'research-large', hiveskills: 'default', 'secret:LLAMACPP_API_KEY': 'provided' };

beforeEach(() => {
  store.rows.clear();
  store.audit.length = 0;
  targetConfigured = true;
  const source: Profile = { config: SOURCE_CONFIG, soul: SOUL, identity: IDENTITY, running: true, apiPort: 9910, receipts: new Map([
    ['web-research', { version: '1.2.0', sha256: RELEASES['web-research']!.sha256 }],
    ['citations', { version: '2.0.0', sha256: RELEASES['citations']!.sha256 }],
    ['summaries', { version: '0.3.1', sha256: RELEASES['summaries']!.sha256 }],
    ['unused', { version: '1.0.0', sha256: sha('unused') }],
  ]) };
  nodes = {
    'node-a': { version: '3.2.0', extensions: EXTENSIONS, capabilities: { studio: 3 }, profiles: new Map([['lead', source]]), actions: [] },
    'node-b': { version: '3.2.1', extensions: EXTENSIONS, capabilities: { studio: 3 }, profiles: new Map(), actions: [] },
  };
  deploy.setArdentDeployDeps({
    installation: async nodeId => installation(nodeId), read, action, studio: async () => undefined, discover: async () => undefined,
    skillRelease: async (request, expected) => {
      const known = release(request.name, request.version, request.pinned);
      expect(known.sha256).toBe(expected);
      return { sha256: known.sha256, archiveBase64: 'H4sIAAAA', files: 1 };
    },
    skillReceipts, hivemem: () => HIVEMEM, prepare: async () => undefined,
    credential: async (_settings, plan) => ({ token: 'fixture-agent-token', agentId: plan.agentId, expiresAt: '2026-12-01T00:00:00.000Z', operationId: 'f'.repeat(64) }),
    supportsRenewal: async () => false, record: async () => undefined, delay: async () => undefined, owners: async () => [], explain: async () => undefined,
  });
  vi.stubEnv('MAGNUS_ARDENT_EMBERPATH_URL', GATEWAY);
  definitions.setArdentDefinitionDeps({
    installation: async nodeId => installation(nodeId), read, skillReceipts, dependencies: async () => [],
    skillRelease: async request => { const known = release(request.name, request.version, request.pinned); return { sha256: known.sha256, promoted: known.promoted }; },
    hivemem: () => HIVEMEM, emberpath: () => GATEWAY, hiveskills: () => 'https://skills.example.com/', now: () => new Date('2026-11-24T00:00:00.000Z'),
  });
});
afterEach(() => { deploy.setArdentDeployDeps({}); definitions.setArdentDefinitionDeps({}); vi.unstubAllEnvs(); });

async function install(definition: unknown, nodeId = 'node-b', bindings: Record<string, string> = BINDINGS) {
  const id = await definitions.installArdentAgentDefinition({ definition, nodeId, name: 'researcher', bindings }, actor);
  await deploy.settleArdentAgentOperation(id);
  return deploy.getArdentAgentOperation(id);
}
const reseal = async (definition: AgentDefinition, change: (body: AgentDefinition) => void) => {
  const copy = structuredClone(definition);
  change(copy);
  const { sha256: _sha, ...body } = copy;
  return sealAgentDefinition(body);
};

describe('portable agent definitions', () => {
  it('exports a profile with its persona, reviewed extensions and pinned skills, and only names its secrets', async () => {
    const { definition, omitted } = await definitions.exportArdentAgentDefinition('node-a', 'lead');
    expect(definition).toMatchObject({ schema: 'hive-agent-definition/1', name: 'Lead Researcher', runtime: { package: '@hivemagnus/ardent', version: '3.2.0', required_capabilities: [] },
      config: { execution: { backend: 'llamacpp', deadline_seconds: 900, max_parallel_tasks: 2 }, model: { emberpath_alias: 'research-large' },
        artifacts: { max_bytes: 33_554_432 }, channels: 'excluded' }, excludes: ['history', 'memory', 'sessions', 'artifacts'] });
    expect(definition.persona).toMatchObject({ soul_md: SOUL, identity_md: IDENTITY });
    expect(definition.skills.map(skill => `${skill.slug}@${skill.version}`)).toEqual(['web-research@1.2.0', 'citations@2.0.0', 'summaries@0.3.1']);
    expect(definition.extensions).toEqual([
      { name: '@example/ardent-media', version: '0.2.0', integrity: EXTENSIONS[0]!.integrity, package_tree_sha256: EXTENSIONS[0]!.packageTreeSha256 },
      { name: '@example/ardent-tools', version: '1.4.1', integrity: EXTENSIONS[1]!.integrity, package_tree_sha256: EXTENSIONS[1]!.packageTreeSha256, plugins: ['@example/ardent-tools/search'] },
    ]);
    expect(definition.requirements).toEqual({
      bindings: [{ key: 'hivemem', kind: 'hivemem', required: true }, { key: 'model', kind: 'emberpath_alias', required: true },
        { key: 'hiveskills', kind: 'hiveskills', required: true }, { key: 'channel:telegram', kind: 'channel', required: false }],
      secrets: [{ env_name: 'LLAMACPP_API_KEY', purpose: expect.stringContaining('providers.llamacpp.api_key_env') }],
    });
    expect(omitted).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'skill', name: 'local-notes' }), expect.objectContaining({ kind: 'channel', name: 'telegram' })]));
    // Memory, the HiveMem agent and the channel's token name are never carried.
    expect(JSON.stringify(definition)).not.toMatch(/ardent-lead-0a1b2c3d|TELEGRAM_BOT_TOKEN|ARDENT_HIVEMEM_TOKEN|ARDENT_API_TOKEN|memory\.example\.com/u);
  });

  it('validates and installs the export on a second node with the same persona, skills and extensions', async () => {
    const { definition } = await definitions.exportArdentAgentDefinition('node-a', 'lead');
    expect(await definitions.validateArdentAgentDefinition({ definition, nodeId: 'node-b', bindings: BINDINGS })).toEqual({ ok: true, problems: [] });
    const operation = await install(definition);
    expect(operation).toMatchObject({ kind: 'definition', status: 'succeeded', request: { definition: { name: 'Lead Researcher', sha256: definition.sha256 } } });
    expect(operation.steps.map(step => step.name)).toEqual(['profile-create', 'service-start', 'identity-soul', 'identity-identity', 'hivemem-enroll',
      'extensions-install', 'config-save', 'skill-install', 'service-restart', 'ready-probe']);
    expect(operation.steps.at(-1)!.receipt).toMatchObject({ definition: { sha256: definition.sha256, personaSha256: definition.persona.sha256 } });
    const config = YAML.parse(nodes['node-b']!.profiles.get('researcher')!.config) as Record<string, any>;
    expect(config['plugins']).toEqual(['@example/ardent-media', '@example/ardent-tools/search']);
    expect(config['execution']).toMatchObject({ backend: 'llamacpp', deadline_seconds: 900, max_parallel_tasks: 2 });
    expect(config['providers']['llamacpp']).toMatchObject({ base_url: GATEWAY, model: 'research-large' });
    expect(config['artifacts']).toEqual({ max_bytes: 33_554_432 });
    // The copy exports to the same persona digest, skill releases and extension integrities.
    const copy = (await definitions.exportArdentAgentDefinition('node-b', 'researcher')).definition;
    expect(copy.persona.sha256).toBe(definition.persona.sha256);
    expect(copy.skills).toEqual(definition.skills);
    expect(copy.extensions).toEqual(definition.extensions);
    expect(store.audit.map(event => event.action)).toContain('ardent.agent.definition-install');
    expect(JSON.stringify([...store.rows.values(), store.audit])).not.toContain('fixture-agent-token');
  });

  it('blocks a missing HiveMem binding before any profile is created', async () => {
    const { definition } = await definitions.exportArdentAgentDefinition('node-a', 'lead');
    const { hivemem: _hivemem, ...bindings } = BINDINGS;
    const report = await definitions.validateArdentAgentDefinition({ definition, nodeId: 'node-b', bindings });
    expect(report).toEqual({ ok: false, problems: [{ code: 'MISSING_BINDING', detail: 'Bind hivemem (hivemem)' }] });
    const refused = definitions.installArdentAgentDefinition({ definition, nodeId: 'node-b', name: 'researcher', bindings }, actor);
    await expect(refused).rejects.toMatchObject({ status: 409, code: 'PREFLIGHT_FAILED', details: { problems: report.problems } });
    expect(nodes['node-b']!.actions).toEqual([]);
    expect(nodes['node-b']!.profiles.size).toBe(0);
    expect(store.rows.size).toBe(0);
    // Without bindings, every required one and the secret are reported.
    const bare = await definitions.validateArdentAgentDefinition({ definition, nodeId: 'node-b' });
    expect(bare.problems.map(item => item.code)).toEqual(['MISSING_BINDING', 'MISSING_BINDING', 'MISSING_BINDING', 'SECRET_UNBOUND']);
  });

  it('rejects a definition carrying a token-like string, and refuses to export one', async () => {
    const { definition } = await definitions.exportArdentAgentDefinition('node-a', 'lead');
    const token = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
    const leaked = await reseal(definition, body => { body.persona.soul_md = `${SOUL}\nUse ${token} for GitHub.\n`; });
    await expect(definitions.validateArdentAgentDefinition({ definition: leaked, nodeId: 'node-b', bindings: BINDINGS }))
      .rejects.toMatchObject({ status: 422, code: 'DEFINITION_CONTAINS_CREDENTIAL', details: { paths: ['$.definition.persona.soul_md'] } });
    await expect(definitions.installArdentAgentDefinition({ definition: leaked, nodeId: 'node-b', name: 'researcher', bindings: BINDINGS }, actor))
      .rejects.toMatchObject({ status: 422, code: 'DEFINITION_CONTAINS_CREDENTIAL' });
    // A raw secret as a binding value is refused the same way: bindings name targets, never values.
    await expect(definitions.validateArdentAgentDefinition({ definition, nodeId: 'node-b', bindings: { ...BINDINGS, 'secret:LLAMACPP_API_KEY': token } }))
      .rejects.toMatchObject({ status: 422, code: 'DEFINITION_CONTAINS_CREDENTIAL' });
    nodes['node-a']!.profiles.get('lead')!.soul = `${SOUL}\nBearer ${'x'.repeat(32)}\n`;
    await expect(definitions.exportArdentAgentDefinition('node-a', 'lead')).rejects.toMatchObject({ status: 422, code: 'DEFINITION_CONTAINS_CREDENTIAL' });
    expect(nodes['node-b']!.actions).toEqual([]);
  });

  it('installs pinned skills that are not promoted with target credentials and reports them unavailable without', async () => {
    const { definition } = await definitions.exportArdentAgentDefinition('node-a', 'lead');
    targetConfigured = false;
    const report = await definitions.validateArdentAgentDefinition({ definition, nodeId: 'node-b', bindings: BINDINGS });
    expect(report.problems).toEqual([
      { code: 'SKILL_VERSION_UNAVAILABLE', detail: expect.stringContaining('citations 2.0.0') },
      { code: 'SKILL_VERSION_UNAVAILABLE', detail: expect.stringContaining('summaries 0.3.1') },
    ]);
    expect(report.problems[0]!.detail).toContain('MAGNUS_ARDENT_HIVESKILLS_TARGET');
    await expect(install(definition)).rejects.toMatchObject({ code: 'PREFLIGHT_FAILED' });
    targetConfigured = true;
    const operation = await install(definition);
    expect(operation.steps.find(step => step.name === 'skill-install')!.receipt).toMatchObject({ installed: [
      { name: 'web-research', version: '1.2.0' }, { name: 'citations', version: '2.0.0' }, { name: 'summaries', version: '0.3.1' }] });
    // A digest that differs from what HiveSkills states is unavailable too.
    const other = await reseal(definition, body => { body.skills[1]!.sha256 = 'e'.repeat(64); });
    expect((await definitions.validateArdentAgentDefinition({ definition: other, nodeId: 'node-b', bindings: BINDINGS })).problems)
      .toEqual([{ code: 'SKILL_VERSION_UNAVAILABLE', detail: expect.stringContaining('another digest') }]);
  });

  it('reports unreviewed extensions, an incompatible runtime, missing capabilities and unbound secrets', async () => {
    const { definition } = await definitions.exportArdentAgentDefinition('node-a', 'lead');
    nodes['node-b']!.extensions = [EXTENSIONS[0]!, { ...EXTENSIONS[1]!, integrity: sri('another tools archive') }];
    nodes['node-b']!.version = '3.1.4';
    const needs = await reseal(definition, body => { body.runtime.required_capabilities = ['ardent.recovery.v1', 'emberpath.execution-trace.v1']; });
    const { 'secret:LLAMACPP_API_KEY': _secret, ...bindings } = BINDINGS;
    const report = await definitions.validateArdentAgentDefinition({ definition: needs, nodeId: 'node-b', bindings });
    expect(report.ok).toBe(false);
    expect(report.problems.map(item => item.code)).toEqual(['RUNTIME_INCOMPATIBLE', 'CAPABILITY_MISSING', 'CAPABILITY_MISSING', 'EXTENSION_NOT_REVIEWED', 'SECRET_UNBOUND']);
    expect(report.problems[3]!.detail).toContain('@example/ardent-tools@1.4.1');
    // The node's reported capabilities and a dependency's satisfy them.
    nodes['node-b'] = { ...nodes['node-b']!, version: '3.2.0', extensions: EXTENSIONS, capabilities: { studio: 4, recovery: 1 } };
    definitions.setArdentDefinitionDeps({
      installation: async nodeId => installation(nodeId), read, skillReceipts, hivemem: () => HIVEMEM, emberpath: () => GATEWAY, hiveskills: () => 'https://skills.example.com/',
      skillRelease: async request => { const known = release(request.name, request.version, request.pinned); return { sha256: known.sha256, promoted: known.promoted }; },
      dependencies: async () => [{ name: 'emberpath', status: 'usable', source: 'registry', endpoint: GATEWAY, capabilities: ['emberpath.execution-trace.v1'] }],
    });
    expect(await definitions.validateArdentAgentDefinition({ definition: needs, nodeId: 'node-b', bindings: BINDINGS })).toEqual({ ok: true, problems: [] });
    // An agent that does not report extensions cannot vouch for them.
    nodes['node-b']!.extensions = undefined;
    expect((await definitions.validateArdentAgentDefinition({ definition, nodeId: 'node-b', bindings: BINDINGS })).problems.map(item => item.code))
      .toEqual(['EXTENSION_NOT_REVIEWED', 'EXTENSION_NOT_REVIEWED']);
  });

  it('uses a provided model key only with an explicitly configured Emberpath', async () => {
    const { definition } = await definitions.exportArdentAgentDefinition('node-a', 'lead');
    definitions.setArdentDefinitionDeps({
      installation: async nodeId => installation(nodeId), read, skillReceipts, dependencies: async () => [], hivemem: () => HIVEMEM,
      emberpath: () => GATEWAY, emberpathExplicit: () => false, hiveskills: () => 'https://skills.example.com/',
      skillRelease: async request => { const known = release(request.name, request.version, request.pinned); return { sha256: known.sha256, promoted: known.promoted }; },
    });
    expect((await definitions.validateArdentAgentDefinition({ definition, nodeId: 'node-b', bindings: BINDINGS })).problems)
      .toEqual([{ code: 'SECRET_UNBOUND', detail: expect.stringContaining('set MAGNUS_ARDENT_EMBERPATH_URL') }]);
    expect(await definitions.validateArdentAgentDefinition({ definition, nodeId: 'node-b', bindings: { ...BINDINGS, 'secret:LLAMACPP_API_KEY': 'none' } }))
      .toEqual({ ok: true, problems: [] });
  });

  it('refuses a definition whose digest or persona digest does not match, and bindings it does not require', async () => {
    const { definition } = await definitions.exportArdentAgentDefinition('node-a', 'lead');
    await expect(definitions.validateArdentAgentDefinition({ definition: { ...definition, name: 'Renamed' }, nodeId: 'node-b' }))
      .rejects.toMatchObject({ status: 422, code: 'DEFINITION_INVALID', message: expect.stringContaining('canonical definition') });
    const changed = { ...definition, persona: { ...definition.persona, identity_md: '# Someone else\n' } };
    const persona = { ...changed, sha256: await agentDefinitionSha256(changed) };
    await expect(definitions.validateArdentAgentDefinition({ definition: persona, nodeId: 'node-b' }))
      .rejects.toMatchObject({ status: 422, code: 'DEFINITION_INVALID', message: expect.stringContaining('persona.sha256') });
    await expect(definitions.validateArdentAgentDefinition({ definition, nodeId: 'node-b', bindings: { ...BINDINGS, telegram: 'default' } }))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
  });

  it('needs a node agent that reports skill receipts and extensions to export', async () => {
    nodes['node-a']!.extensions = undefined;
    await expect(definitions.exportArdentAgentDefinition('node-a', 'lead')).rejects.toMatchObject({ status: 409, code: 'AGENT_UPGRADE_REQUIRED' });
    nodes['node-a']!.extensions = EXTENSIONS;
    definitions.setArdentDefinitionDeps({ installation: async nodeId => installation(nodeId), read, emberpath: () => GATEWAY,
      skillReceipts: async () => { throw new AgentResponseError(404, null); } });
    await expect(definitions.exportArdentAgentDefinition('node-a', 'lead')).rejects.toMatchObject({ status: 409, code: 'AGENT_UPGRADE_REQUIRED' });
    await expect(definitions.exportArdentAgentDefinition('node-a', 'missing')).rejects.toMatchObject({ status: 404 });
  });
});
