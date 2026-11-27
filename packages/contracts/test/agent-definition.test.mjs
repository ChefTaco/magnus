// Runs on Node's built-in test runner against the TypeScript source (types are stripped).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  agentDefinitionSha256, agentDefinitionSchema, agentPersonaSha256, canonicalJson, credentialLikePaths, sealAgentDefinition, verifyAgentDefinition,
} from '../src/agent-definition.ts';

const body = {
  schema: 'hive-agent-definition/1',
  name: 'Researcher',
  created_at: '2026-11-24T00:00:00.000Z',
  source_template: { template_id: 'tpl-research', version: 3 },
  persona: { soul_md: '# Soul\n', identity_md: '# Identity\n', sha256: '' },
  runtime: { package: '@hivemagnus/ardent', version: '3.2.0', required_capabilities: ['ardent.recovery.v1'] },
  extensions: [{ name: '@example/ardent-media', version: '0.2.0', integrity: `sha512-${createHash('sha512').update('archive').digest('base64')}`, package_tree_sha256: 'a'.repeat(64) }],
  skills: [{ slug: 'web-research', version: '1.2.0', sha256: 'b'.repeat(64) }],
  config: { execution: { backend: 'llamacpp', deadline_seconds: 900 }, model: { emberpath_alias: 'research-large' }, artifacts: {}, channels: 'excluded' },
  requirements: { bindings: [{ key: 'hivemem', kind: 'hivemem', required: true }], secrets: [{ env_name: 'LLAMACPP_API_KEY', purpose: 'model key' }] },
  excludes: ['history', 'memory', 'sessions', 'artifacts'],
};

test('canonical JSON sorts keys, drops undefined members and has no whitespace', () => {
  assert.equal(canonicalJson({ b: [1, { d: 'x', c: undefined }], a: null }), '{"a":null,"b":[1,{"d":"x"}]}');
  assert.throws(() => canonicalJson({ a: Number.NaN }));
});

test('a sealed definition verifies, and both digests are over canonical JSON', async () => {
  const definition = await sealAgentDefinition(body);
  assert.equal(definition.persona.sha256, createHash('sha256').update('{"identity_md":"# Identity\\n","soul_md":"# Soul\\n"}').digest('hex'));
  assert.equal(definition.persona.sha256, await agentPersonaSha256(definition.persona));
  const { sha256, ...rest } = definition;
  assert.equal(sha256, createHash('sha256').update(canonicalJson(rest)).digest('hex'));
  assert.equal(await agentDefinitionSha256(definition), sha256);
  // Key order does not matter.
  const reordered = Object.fromEntries(Object.entries(definition).reverse());
  assert.deepEqual(await verifyAgentDefinition(reordered), { ok: true, definition: agentDefinitionSchema.parse(definition) });
});

test('a changed definition or persona fails its digest', async () => {
  const definition = await sealAgentDefinition(body);
  const renamed = await verifyAgentDefinition({ ...definition, name: 'Other' });
  assert.equal(renamed.ok, false);
  assert.equal(renamed.code, 'DEFINITION_INVALID');
  const persona = { ...definition, persona: { ...definition.persona, soul_md: '# Other\n' } };
  const result = await verifyAgentDefinition({ ...persona, sha256: await agentDefinitionSha256(persona) });
  assert.match(result.detail, /persona\.sha256/u);
});

test('the shape is fixed: exclusions, channels and unknown members', async () => {
  const definition = await sealAgentDefinition(body);
  assert.equal(agentDefinitionSchema.safeParse({ ...definition, excludes: ['history'] }).success, false);
  assert.equal(agentDefinitionSchema.safeParse({ ...definition, config: { ...definition.config, channels: { telegram: {} } } }).success, false);
  assert.equal(agentDefinitionSchema.safeParse({ ...definition, history: [] }).success, false);
  assert.equal(agentDefinitionSchema.safeParse({ ...definition, skills: [definition.skills[0], definition.skills[0]] }).success, false);
});

test('credential-like strings are found anywhere, even in a malformed definition', async () => {
  const github = ['gh', 'p_', 'x'.repeat(36)].join('');
  const jwt = ['eyJ', 'a'.repeat(12), '.eyJ', 'b'.repeat(12), '.', 'c'.repeat(12)].join('');
  assert.deepEqual(credentialLikePaths({ a: [`token ${github}`], b: { c: jwt }, d: 'https://user:pass@example.com/', e: 'plain text' }),
    ['$.a[0]', '$.b.c', '$.d']);
  const leaked = await verifyAgentDefinition({ ...body, persona: { ...body.persona, soul_md: `Bearer ${'z'.repeat(30)}` } });
  assert.equal(leaked.code, 'DEFINITION_CONTAINS_CREDENTIAL');
  assert.deepEqual(leaked.paths, ['$.persona.soul_md']);
  assert.equal((await verifyAgentDefinition({ nonsense: true })).code, 'DEFINITION_INVALID');
});

test('install and validate requests take an Emberpath client key of the same shape New Agent takes', async () => {
  const { AGENT_DEFINITION_EMBERPATH_KEY_PATTERN, agentDefinitionInstallRequestSchema, agentDefinitionValidateRequestSchema } = await import('../src/agent-definition.ts');
  const { ARDENT_EMBERPATH_CLIENT_KEY_PATTERN, ardentAgentDeployRequestSchema, ardentAgentOperationResumeRequestSchema } = await import('../src/browser.ts');
  // Both modules import only zod, so each keeps the pattern; they must not drift.
  assert.equal(AGENT_DEFINITION_EMBERPATH_KEY_PATTERN.source, ARDENT_EMBERPATH_CLIENT_KEY_PATTERN.source);
  assert.equal(AGENT_DEFINITION_EMBERPATH_KEY_PATTERN.flags, ARDENT_EMBERPATH_CLIENT_KEY_PATTERN.flags);
  const install = { definition: {}, nodeId: 'node-1', name: 'researcher', bindings: {} };
  const deploy = { nodeId: 'node-1', profile: 'lead', soul_md: '# Soul\n', identity_md: '# Identity\n', model: { emberpath_alias: 'general' }, hivemem: true };
  for (const key of ['fixture-emberpath-key-0001', 'A'.repeat(512)]) {
    assert.ok(agentDefinitionInstallRequestSchema.safeParse({ ...install, emberpath_client_key: key }).success, key.slice(0, 10));
    assert.ok(agentDefinitionValidateRequestSchema.safeParse({ definition: {}, nodeId: 'node-1', emberpath_client_key: key }).success);
    assert.ok(ardentAgentDeployRequestSchema.safeParse({ ...deploy, emberpath_client_key: key }).success);
    assert.ok(ardentAgentOperationResumeRequestSchema.safeParse({ emberpath_client_key: key }).success);
  }
  for (const key of ['short', 'fixture key with spaces', 'fixture-key\nINJECTED=1', 'fixture"quoted"key-0001', 'A'.repeat(513)]) {
    assert.equal(agentDefinitionInstallRequestSchema.safeParse({ ...install, emberpath_client_key: key }).success, false, JSON.stringify(key.slice(0, 20)));
    assert.equal(ardentAgentDeployRequestSchema.safeParse({ ...deploy, emberpath_client_key: key }).success, false);
  }
  assert.ok(ardentAgentOperationResumeRequestSchema.safeParse({}).success);
  assert.equal(ardentAgentOperationResumeRequestSchema.safeParse({ other: true }).success, false);
});
