/**
 * Portable agent definitions (`hive-agent-definition/1`, packages/contracts/src/agent-definition.ts):
 * export a managed Ardent profile as one definition, check a definition against a target node (the
 * preflight), and install it there as a New Agent operation with its reviewed extensions, pinned
 * HiveSkills releases and explicit bindings.
 *
 * A definition never carries a credential. The export keeps secret-bearing settings out and turns the
 * environment variables they name into `requirements.secrets`; the install sets no secret value and
 * asks only that each one is bound (`secret:<NAME>` = `provided` or `none`). History, memory, sessions
 * and artifacts are never part of a definition. Nothing is created on the target until the preflight
 * passes, and the operation succeeds only once the ready probe finds the definition's persona and
 * skills on the running agent.
 */
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { HTTPError } from 'ky';
import {
  AGENT_DEFINITION_EXCLUDES, AGENT_DEFINITION_SCHEMA, agentDefinitionConfigSchema, agentDefinitionInstallRequestSchema,
  agentDefinitionSecretBindingKey, agentDefinitionValidateRequestSchema, ardentProfileCapabilities, credentialLikePaths, sealAgentDefinition, verifyAgentDefinition,
  type AgentDefinition, type AgentDefinitionBindings, type AgentDefinitionBody, type AgentDefinitionPreflight, type AgentDefinitionProblem,
  type ArdentFleetInstallation, type ArdentSkillInstall, type ArdentSkillReceipts,
} from '@hivemagnus/magnus-contracts';
import type { ArdentDependency } from '@hivemagnus/magnus-contracts/browser';
import { HttpError } from '../middleware/error-handler.js';
import { AgentResponseError } from '../sdk/node-api-client.js';
import { emberpathUrl, startArdentDefinitionDeploy, type ArdentOperationActor, type ArdentStoredDefinition } from './ardent-agent-deploy.js';
import { ardentHiveSkillsUrl, checkArdentSkillRelease } from './ardent-hiveskills.js';
import { requireArdentHiveMemSettings, type ArdentHiveMemSettings } from './ardent-hivemem.js';
import { getArdentInstallation, getArdentProfileResource, getArdentSkillReceipts } from './ardent-service.js';
import { dependencyReport } from './discovery.js';

export interface ArdentDefinitionDeps {
  installation(nodeId: string): Promise<ArdentFleetInstallation>;
  read<T>(nodeId: string, profile: string, resource: string): Promise<T>;
  skillReceipts(nodeId: string, profile: string): Promise<ArdentSkillReceipts>;
  dependencies(): Promise<ArdentDependency[]>;
  /** The digest HiveSkills states for a release Magnus can fetch (pinned), or a 404/409/503 HttpError. */
  skillRelease(request: ArdentSkillInstall): Promise<{ sha256: string; promoted: boolean }>;
  hivemem(): ArdentHiveMemSettings;
  /** The Emberpath base URL New Agent writes for an alias; throws when there is none. */
  emberpath(): string;
  /** Whether that URL is the explicit MAGNUS_ARDENT_EMBERPATH_URL rather than one the Hive Registry resolved. */
  emberpathExplicit(): boolean;
  /** The HiveSkills registry, or null. Throws on an unusable setting. */
  hiveskills(): string | null;
  start(input: unknown, definition: ArdentStoredDefinition, actor: ArdentOperationActor): Promise<string>;
  now(): Date;
}

const defaultDeps: ArdentDefinitionDeps = {
  installation: getArdentInstallation,
  read: (nodeId, profile, resource) => getArdentProfileResource(nodeId, profile, resource) as never,
  skillReceipts: getArdentSkillReceipts,
  dependencies: () => dependencyReport(),
  skillRelease: request => checkArdentSkillRelease(request),
  hivemem: requireArdentHiveMemSettings,
  emberpath: emberpathUrl,
  emberpathExplicit: () => Boolean(process.env['MAGNUS_ARDENT_EMBERPATH_URL']),
  hiveskills: () => ardentHiveSkillsUrl(),
  start: startArdentDefinitionDeploy,
  now: () => new Date(),
};
let deps = defaultDeps;
/** Replace node, registry and operation access in tests. Returns a restore function. */
export function setArdentDefinitionDeps(overrides: Partial<ArdentDefinitionDeps>): () => void {
  deps = { ...defaultDeps, ...overrides };
  return () => { deps = defaultDeps; };
}

/**
 * Ardent runtime capabilities in the shared vocabulary, and the node agent's installation capability (with
 * the level) that reports each. The others belong to a dependency, which the discovery report states.
 */
export const ARDENT_RUNTIME_CAPABILITY_LEVELS: Readonly<Record<string, readonly [string, number]>> = {
  'ardent.recovery.v1': ['recovery', 1],
  'ardent.lineage.v1': ['lineage', 1],
  'artifact-transfer.v2': ['artifact_transfer', 2],
};
const DEFAULT_RUNTIME_PACKAGE = '@hivemagnus/ardent';

type Omitted = { kind: 'skill' | 'plugin' | 'model' | 'channel' | 'peer'; name: string; reason: string };
type Config = Record<string, unknown>;
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 400);

function refusedStatus(error: unknown): number | undefined {
  if (error instanceof AgentResponseError) return error.agentStatus;
  if (error instanceof HTTPError) return error.response.status;
  return undefined;
}

async function reachableInstallation(nodeId: string): Promise<ArdentFleetInstallation> {
  let installation: ArdentFleetInstallation;
  try { installation = await deps.installation(nodeId); }
  catch (error: unknown) {
    if (error instanceof Error && error.message === 'Managed node not found') throw new HttpError(404, 'NOT_FOUND', 'Managed node not found');
    throw error;
  }
  if (!installation.reachable) throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', installation.error ?? 'Ardent node unavailable');
  return installation;
}

/** Whether two base URLs name the same endpoint, ignoring a trailing slash. */
const sameUrl = (left: unknown, right: string | null) => typeof left === 'string' && right !== null && left.replace(/\/+$/u, '') === right.replace(/\/+$/u, '');

/**
 * Export a profile as a sealed definition, with what could not be carried. Answers 404 for an unknown
 * profile, 409 AGENT_UPGRADE_REQUIRED when the node agent cannot report reviewed extensions or skill
 * receipts, and 422 DEFINITION_CONTAINS_CREDENTIAL when a carried text looks like a credential.
 */
// Names the export echoes in `omitted`. They come from the profile's configuration, so only a value
// that is plainly an identifier is shown; anything else (a path, a URL, free text) is replaced by a
// generic label with a short digest, so a shared export never carries configuration text.
const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SAFE_PLUGIN_SPECIFIER = /^(?:@[a-z0-9][a-z0-9._~-]{0,63}\/)?[a-z0-9][a-z0-9._~-]{0,127}(?:\/[A-Za-z0-9._-]{1,64}){0,4}$/u;
function omittedName(kind: 'skill' | 'plugin', value: string, index: number): string {
  const safe = kind === 'skill' ? SAFE_SKILL_NAME : SAFE_PLUGIN_SPECIFIER;
  if (safe.test(value) && !credentialLikePaths(value).length) return value;
  return `${kind} #${index + 1} (sha256:${createHash('sha256').update(value).digest('hex').slice(0, 12)})`;
}

export async function exportArdentAgentDefinition(nodeId: string, profile: string): Promise<{ definition: AgentDefinition; omitted: Omitted[] }> {
  const installation = await reachableInstallation(nodeId);
  if (!installation.installed || !installation.version) throw new HttpError(409, 'ARDENT_NOT_INSTALLED', 'Ardent is not installed on this node');
  if (!installation.profiles.some(item => item.id === profile)) throw new HttpError(404, 'NOT_FOUND', 'Ardent profile not found');
  if (installation.extensions === undefined)
    throw new HttpError(409, 'AGENT_UPGRADE_REQUIRED', `Upgrade the Magnus agent on ${installation.nodeName} to export agent definitions (it does not report reviewed extensions)`);
  if (installation.extensions === null)
    throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', `The node's reviewed extensions cannot be read: ${installation.extensionsError ?? 'unknown reason'}`);
  const read = async <T,>(resource: string): Promise<T> => {
    try { return await deps.read<T>(nodeId, profile, resource); }
    catch (error: unknown) {
      if (refusedStatus(error) === 404) throw new HttpError(404, 'NOT_FOUND', 'Ardent profile resource not found');
      throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', `The profile could not be read: ${message(error)}`.slice(0, 300));
    }
  };
  const [soul, identity, configFile] = await Promise.all([
    read<{ text: string }>('identity/soul'), read<{ text: string }>('identity/identity'), read<{ text: string }>('config')]);
  let receipts: ArdentSkillReceipts;
  try { receipts = await deps.skillReceipts(nodeId, profile); }
  catch (error: unknown) {
    if (refusedStatus(error) === 404) throw new HttpError(409, 'AGENT_UPGRADE_REQUIRED', `Upgrade the Magnus agent on ${installation.nodeName} to export agent definitions (it does not report skill receipts)`);
    throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', `The profile's skill receipts could not be read: ${message(error)}`.slice(0, 300));
  }
  let config: Config;
  try { config = record(YAML.parse(configFile.text)); }
  catch { throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', 'The profile configuration is not valid YAML'); }
  const omitted: Omitted[] = [];

  // Skills: the enabled HiveSkills releases, by their receipts. A local skill has no portable source.
  const enabled = strings(record(config['skills'])['enabled']);
  const skills = receipts.skills.filter(item => enabled.includes(item.name)).map(item => ({ slug: item.name, version: item.version, sha256: item.sha256 }));
  enabled.forEach((name, index) => {
    if (!skills.some(item => item.slug === name)) omitted.push({ kind: 'skill', name: omittedName('skill', name, index), reason: 'Not installed from HiveSkills by Magnus; a definition carries only HiveSkills releases' });
  });

  // Extensions: the reviewed packages the profile's plugins load, by integrity.
  const plugins = strings(config['plugins']);
  const extensions: AgentDefinitionBody['extensions'] = [];
  for (const item of installation.extensions) {
    const used = plugins.filter(specifier => specifier === item.name || specifier.startsWith(`${item.name}/`));
    if (!used.length) continue;
    extensions.push({ name: item.name, version: item.version, integrity: item.integrity, package_tree_sha256: item.packageTreeSha256,
      ...(used.length === 1 && used[0] === item.name ? {} : { plugins: used }) });
  }
  plugins.forEach((specifier, index) => {
    if (!extensions.some(item => specifier === item.name || specifier.startsWith(`${item.name}/`)))
      omitted.push({ kind: 'plugin', name: omittedName('plugin', specifier, index), reason: 'Not part of a reviewed extension retained on this node' });
  });

  // Configuration: the portable runtime settings. Provider URLs, channels, peers and memory stay behind.
  const execution = record(config['execution']);
  const backend = execution['backend'] === 'codex' ? 'codex' : 'llamacpp';
  const limits = agentDefinitionConfigSchema.shape.execution.safeParse({ backend,
    ...Object.fromEntries((['deadline_seconds', 'max_parallel_tasks', 'max_parallel_tool_calls'] as const)
      .filter(key => typeof execution[key] === 'number').map(key => [key, execution[key]])) });
  const llamacpp = record(record(config['providers'])['llamacpp']);
  let alias: string | undefined;
  if (backend === 'llamacpp') {
    let gateway: string | null = null;
    try { gateway = deps.emberpath(); } catch { gateway = null; } // no-reason-needed: without Emberpath no model is an alias, which `omitted` says
    const model = llamacpp['model'];
    if (sameUrl(llamacpp['base_url'], gateway) && typeof model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(model)) alias = model;
    else omitted.push({ kind: 'model', name: 'providers.llamacpp', reason: 'The model is not an Emberpath alias Magnus serves; the target binds model to an alias' });
  }
  const maxBytes = record(config['artifacts'])['max_bytes'];
  const bindings: AgentDefinitionBody['requirements']['bindings'] = [
    { key: 'hivemem', kind: 'hivemem', required: true },
    { key: 'model', kind: 'emberpath_alias', required: backend === 'llamacpp' },
    { key: 'hiveskills', kind: 'hiveskills', required: skills.length > 0 },
  ];
  for (const [name, channel] of Object.entries(record(config['channels']))) {
    if (record(channel)['enabled'] !== true || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(name)) continue;
    bindings.push({ key: `channel:${name}`, kind: 'channel', required: false });
    omitted.push({ kind: 'channel', name, reason: 'Channels are installation-specific; configure it on the target' });
  }
  if (record(config['a2a'])['enabled'] === true || (Array.isArray(config['peers']) && config['peers'].length > 0)) {
    bindings.push({ key: 'peers', kind: 'peer', required: false });
    omitted.push({ kind: 'peer', name: 'peers', reason: 'Peers and A2A are installation-specific; configure them on the target' });
  }
  // The carried model provider's key is named, never read: the target supplies it or runs without it.
  const secrets: AgentDefinitionBody['requirements']['secrets'] = [];
  const keyEnv = llamacpp['api_key_env'];
  if (backend === 'llamacpp' && typeof keyEnv === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/u.test(keyEnv))
    secrets.push({ env_name: keyEnv, purpose: 'providers.llamacpp.api_key_env: the model endpoint key, if it needs one' });

  const body: AgentDefinitionBody = {
    schema: AGENT_DEFINITION_SCHEMA,
    name: (typeof config['name'] === 'string' && config['name'].trim() ? config['name'] : profile).slice(0, 128),
    created_at: deps.now().toISOString(),
    persona: { soul_md: soul.text, identity_md: identity.text, sha256: '' },
    runtime: { package: installation.packageName ?? DEFAULT_RUNTIME_PACKAGE, version: installation.version.replace(/^v/u, ''), required_capabilities: [] },
    extensions,
    skills,
    config: {
      execution: limits.success ? limits.data : { backend },
      model: alias ? { emberpath_alias: alias } : {},
      artifacts: typeof maxBytes === 'number' && Number.isInteger(maxBytes) && maxBytes >= 1024 && maxBytes <= 67_108_864 ? { max_bytes: maxBytes } : {},
      channels: 'excluded',
    },
    requirements: { bindings, secrets },
    excludes: [...AGENT_DEFINITION_EXCLUDES],
  };
  const credentials = credentialLikePaths(body);
  if (credentials.length) throw new HttpError(422, 'DEFINITION_CONTAINS_CREDENTIAL',
    `The profile carries credential-like text at ${credentials.slice(0, 10).join(', ')}; remove it before exporting`, { paths: credentials.slice(0, 50) });
  const definition = await sealAgentDefinition(body);
  const checked = await verifyAgentDefinition(definition);
  if (!checked.ok) throw new HttpError(422, checked.code, `The profile cannot be exported: ${checked.detail}`.slice(0, 500));
  // The whole response is what gets shared, not only the definition.
  const leaked = credentialLikePaths({ definition: checked.definition, omitted });
  if (leaked.length) throw new HttpError(422, 'DEFINITION_CONTAINS_CREDENTIAL',
    `The export would carry credential-like text at ${leaked.slice(0, 10).join(', ')}; remove it before exporting`, { paths: leaked.slice(0, 50) });
  return { definition: checked.definition, omitted };
}

/** A definition from a request body, checked: 422 for one that is malformed, fails a digest or carries a credential. */
async function checkedDefinition(raw: unknown): Promise<AgentDefinition> {
  const checked = await verifyAgentDefinition(raw);
  if (!checked.ok) throw new HttpError(422, checked.code, checked.detail, checked.paths ? { paths: checked.paths.slice(0, 50) } : undefined);
  return checked.definition;
}

/** Bindings a definition may receive: its requirements and `secret:<NAME>` for each named secret. */
function checkBindingKeys(definition: AgentDefinition, bindings: AgentDefinitionBindings): void {
  const known = new Set([...definition.requirements.bindings.map(item => item.key), 'model', 'hivemem', 'hiveskills',
    ...definition.requirements.secrets.map(item => agentDefinitionSecretBindingKey(item.env_name))]);
  const unknown = Object.keys(bindings).filter(key => !known.has(key));
  if (unknown.length) throw new HttpError(400, 'VALIDATION_ERROR', `Bindings the definition does not require: ${unknown.slice(0, 10).join(', ')}`);
}

const semverParts = (value: string | null | undefined) => /^v?(\d+)\.(\d+)\.(\d+)/u.exec(value ?? '')?.slice(1).map(Number);

/** The preflight: every problem that would stop the definition from installing on the node as defined. */
async function preflight(definition: AgentDefinition, bindings: AgentDefinitionBindings | undefined,
  installation: ArdentFleetInstallation): Promise<AgentDefinitionPreflight> {
  const problems: AgentDefinitionProblem[] = [];
  const problem = (code: AgentDefinitionProblem['code'], detail: string) => problems.push({ code, detail: detail.slice(0, 500) });
  const given = bindings ?? {};

  // Runtime: the same package, the same major version, at least the defined version.
  const wanted = definition.runtime;
  const installedPackage = installation.packageName ?? DEFAULT_RUNTIME_PACKAGE;
  if (!installation.installed || !installation.version) problem('RUNTIME_INCOMPATIBLE', `Ardent is not installed on ${installation.nodeName}`);
  else {
    const have = semverParts(installation.version), want = semverParts(wanted.version);
    if (installedPackage !== wanted.package) problem('RUNTIME_INCOMPATIBLE', `${installation.nodeName} runs ${installedPackage}, not ${wanted.package}`);
    else if (!have || !want || have[0] !== want[0] || have[1]! < want[1]! || (have[1] === want[1] && have[2]! < want[2]!))
      problem('RUNTIME_INCOMPATIBLE', `${installation.nodeName} runs Ardent ${installation.version}; the definition needs ${wanted.version} or a later ${want?.[0] ?? '?'}.x`);
  }
  if (definition.config.execution.backend !== 'llamacpp')
    problem('RUNTIME_INCOMPATIBLE', `New Agent provisions llamacpp-backend agents; this definition uses ${definition.config.execution.backend}`);

  // Capabilities: Ardent's from the node's installation report, the others from the dependency that offers them.
  let report: ArdentDependency[] | null = null;
  const dependencies = async () => (report ??= await deps.dependencies().catch(() => []));
  // A fresh report first, so the binding checks below see the endpoints the Registry resolved.
  await dependencies();
  for (const capability of wanted.required_capabilities) {
    const runtime = ARDENT_RUNTIME_CAPABILITY_LEVELS[capability];
    if (runtime) {
      // The node agent must relay it and the installed Ardent must serve it: a new profile runs that package.
      const relayed = (installation.capabilities as Record<string, number | undefined> | undefined)?.[runtime[0]] ?? 0;
      const served = (ardentProfileCapabilities(undefined, installation.version).capabilities as Record<string, number>)[runtime[0]] ?? 0;
      const level = Math.min(relayed, served);
      if (level < runtime[1]) problem('CAPABILITY_MISSING', `${installation.nodeName} does not report ${capability} (Ardent ${installation.version ?? 'unknown'})`);
      continue;
    }
    const offered = (await dependencies()).filter(item => item.status !== 'missing' && item.capabilities.includes(capability));
    if (!offered.length) problem('CAPABILITY_MISSING', `No dependency Magnus resolved offers ${capability}`);
  }

  // Extensions: exactly the reviewed archives retained beside the target's runtime.
  if (definition.extensions.length) {
    const retained = installation.extensions;
    for (const item of definition.extensions) {
      if (retained === undefined) problem('EXTENSION_NOT_REVIEWED', `${item.name}@${item.version}: the node agent on ${installation.nodeName} does not report reviewed extensions; upgrade it`);
      else if (retained === null) problem('EXTENSION_NOT_REVIEWED', `${item.name}@${item.version}: the node's reviewed extensions cannot be read (${installation.extensionsError ?? 'unknown reason'})`);
      else if (!retained.some(have => have.name === item.name && have.version === item.version && have.integrity === item.integrity && have.packageTreeSha256 === item.package_tree_sha256))
        problem('EXTENSION_NOT_REVIEWED', `${item.name}@${item.version} with this integrity is not a reviewed extension on ${installation.nodeName}; add it to the node's extension bundle through the package review first`);
    }
  }

  // Bindings: each required one explicitly, and a usable target for it.
  const required = new Map(definition.requirements.bindings.filter(item => item.required).map(item => [item.key, item.kind]));
  for (const [key, kind] of required) if (given[key] === undefined) problem('MISSING_BINDING', `Bind ${key} (${kind})`);
  // New Agent always enrolls the agent in HiveMem.
  let hivemem: ArdentHiveMemSettings | null = null;
  try { hivemem = deps.hivemem(); }
  catch (error: unknown) { problem('MISSING_BINDING', `hivemem: ${message(error)}`); }
  if (hivemem && given['hivemem'] !== undefined && !['default', hivemem.workspaceId].includes(given['hivemem']))
    problem('MISSING_BINDING', `hivemem: Magnus enrolls agents into the HiveMem workspace ${hivemem.workspaceId}; bind default or ${hivemem.workspaceId}`);
  const model = given['model'] ?? (required.has('model') ? undefined : definition.config.model.emberpath_alias);
  if (definition.config.execution.backend === 'llamacpp') {
    if (model === undefined && !required.has('model')) problem('MISSING_BINDING', 'Bind model (emberpath_alias): the definition names no Emberpath alias');
    else if (model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(model)) problem('MISSING_BINDING', 'model: an Emberpath alias is letters, digits and ._:/-');
    else if (model !== undefined) {
      try { deps.emberpath(); }
      catch (error: unknown) { problem('MISSING_BINDING', `model: ${message(error)}`); }
      const emberpath = (await dependencies()).find(item => item.name === 'emberpath');
      if (emberpath?.status === 'missing' && emberpath.source !== 'none') problem('MISSING_BINDING', `model: ${emberpath.reason ?? 'Emberpath does not answer'}`);
    }
  }
  if (definition.skills.length) {
    let registry: string | null = null;
    try { registry = deps.hiveskills(); } catch (error: unknown) { problem('MISSING_BINDING', `hiveskills: ${message(error)}`); }
    if (given['hiveskills'] !== undefined && given['hiveskills'] !== 'default') problem('MISSING_BINDING', 'hiveskills: bind default, the HiveSkills Magnus uses');
    if (registry === null) for (const skill of definition.skills) problem('SKILL_VERSION_UNAVAILABLE', `${skill.slug} ${skill.version}: Magnus has no HiveSkills registry`);
    else {
      for (const skill of definition.skills) {
        try {
          const release = await deps.skillRelease({ source: 'hiveskills', name: skill.slug, version: skill.version, pinned: true });
          if (release.sha256 !== skill.sha256) problem('SKILL_VERSION_UNAVAILABLE', `${skill.slug} ${skill.version}: HiveSkills states another digest than the definition`);
        } catch (error: unknown) {
          problem('SKILL_VERSION_UNAVAILABLE', `${skill.slug} ${skill.version}: ${error instanceof HttpError ? error.message : `HiveSkills could not be asked (${message(error)})`}`);
        }
      }
    }
  }

  // Secrets: named only; each must be bound to provided or none, never to a value.
  for (const secret of definition.requirements.secrets) {
    const value = given[agentDefinitionSecretBindingKey(secret.env_name)];
    if (value !== 'provided' && value !== 'none')
      problem('SECRET_UNBOUND', `${secret.env_name} (${secret.purpose}): bind ${agentDefinitionSecretBindingKey(secret.env_name)} to provided, once the target profile's environment supplies it, or none`);
    // The carried configuration's only endpoint is the model gateway: a supplied key would reach it, so it must be
    // the Emberpath this server was configured with, never one the Hive Registry suggested.
    else if (value === 'provided' && definition.config.execution.backend === 'llamacpp' && !deps.emberpathExplicit())
      problem('SECRET_UNBOUND', `${secret.env_name}: a provided secret is used only with an explicitly configured Emberpath; set MAGNUS_ARDENT_EMBERPATH_URL, or bind ${agentDefinitionSecretBindingKey(secret.env_name)} to none`);
  }
  return { ok: problems.length === 0, problems };
}

/** POST /ardent/agent-definitions/validate */
export async function validateArdentAgentDefinition(raw: unknown): Promise<AgentDefinitionPreflight> {
  const credentials = credentialLikePaths(raw);
  if (credentials.length) throw new HttpError(422, 'DEFINITION_CONTAINS_CREDENTIAL', `Credential-like values at ${credentials.slice(0, 10).join(', ')}`, { paths: credentials.slice(0, 50) });
  const parsed = agentDefinitionValidateRequestSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'VALIDATION_ERROR', parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 500));
  const definition = await checkedDefinition(parsed.data.definition);
  if (parsed.data.bindings) checkBindingKeys(definition, parsed.data.bindings);
  return preflight(definition, parsed.data.bindings, await reachableInstallation(parsed.data.nodeId));
}

/**
 * POST /ardent/agent-definitions/install: the preflight, then a New Agent operation for the definition. A
 * failed preflight answers 409 PREFLIGHT_FAILED with the report in error.details and creates nothing.
 */
export async function installArdentAgentDefinition(raw: unknown, actor: ArdentOperationActor): Promise<string> {
  const credentials = credentialLikePaths(raw);
  if (credentials.length) throw new HttpError(422, 'DEFINITION_CONTAINS_CREDENTIAL', `Credential-like values at ${credentials.slice(0, 10).join(', ')}`, { paths: credentials.slice(0, 50) });
  const parsed = agentDefinitionInstallRequestSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'VALIDATION_ERROR', parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 500));
  const { nodeId, name, bindings, apiPort } = parsed.data;
  const definition = await checkedDefinition(parsed.data.definition);
  checkBindingKeys(definition, bindings);
  const report = await preflight(definition, bindings, await reachableInstallation(nodeId));
  if (!report.ok) throw new HttpError(409, 'PREFLIGHT_FAILED', `The definition cannot be installed on this node: ${report.problems.map(item => item.code).join(', ')}`,
    { problems: report.problems });
  const alias = bindings['model'] ?? definition.config.model.emberpath_alias!;
  const stored: ArdentStoredDefinition = {
    name: definition.name, sha256: definition.sha256, personaSha256: definition.persona.sha256,
    execution: Object.fromEntries(Object.entries(definition.config.execution).filter(([key]) => key !== 'backend')),
    extensions: definition.extensions.map(({ name: extension, version, integrity, package_tree_sha256 }) => ({ name: extension, version, integrity, package_tree_sha256 })),
    plugins: definition.extensions.flatMap(item => item.plugins ?? [item.name]),
    skills: definition.skills,
  };
  return deps.start({
    nodeId, profile: name, ...(apiPort !== undefined ? { apiPort } : {}),
    soul_md: definition.persona.soul_md, identity_md: definition.persona.identity_md,
    model: { emberpath_alias: alias }, skills: [], hivemem: true,
    ...(definition.config.artifacts.max_bytes !== undefined ? { artifacts_max_bytes: definition.config.artifacts.max_bytes } : {}),
  }, stored, actor);
}
