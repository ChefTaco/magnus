// A bounded, noninteractive native Responses turn. Only explicitly selected
// external-provider configuration reaches the disposable Codex home.
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verificationRelay } from './verification-relay.mjs';
export function acceptanceSelection(config, env) {
  const model = config?.model, provider = config?.model_provider;
  if (typeof model !== 'string' || !model || model.length > 200 || /[\r\n]/.test(model) || typeof provider !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(provider)) throw Error('Native acceptance requires an explicit model and external provider');
  const selected = config.model_providers?.[provider];
  if (!selected || typeof selected.base_url !== 'string' || selected.wire_api !== 'responses' || typeof selected.env_key !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/.test(selected.env_key) || !env[selected.env_key] || ['auth', 'gateway_oauth', 'http_headers', 'env_http_headers', 'experimental_bearer_token'].some(key => selected[key] !== undefined) || selected.requires_openai_auth === true) throw Error('Native acceptance requires a Responses HTTPS provider and protected env-key credential; interactive authorization remains operator-owned');
  let url; try { url = new URL(selected.base_url); } catch { throw Error('Native acceptance requires a verified HTTPS endpoint'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash || /[%\\\s]/.test(selected.base_url) || /\/\.?\.(?:\/|$)|\/\//.test(selected.base_url.slice(selected.base_url.indexOf('://') + 3))) throw Error('Native acceptance requires a canonical credential-free HTTPS endpoint');
  return { model, baseURL: selected.base_url, envKey: selected.env_key };
}
const disabled = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin', 'plugin_discovery_prefetch', 'hooks', 'multi_agent', 'multi_agent_v2', 'browser_use', 'browser_use_external', 'computer_use', 'view_image', 'image_generation', 'in_app_browser', 'code_mode', 'code_mode_host', 'workspace_dependencies', 'skill_search', 'skill_mcp_dependency_install', 'sleep_tool', 'goals', 'request_permissions_tool', 'daemon_auto_start', 'unbounded_connection_retries'];
export async function runAcceptance({ profile, environment, env, native, parseToml, version, expected = 'READY', relayFactory = verificationRelay }) {
  if (!/^[A-Z]{1,16}$/.test(expected)) throw Error('Select a bounded uppercase acceptance response');
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'SSLKEYLOGFILE', 'NODE_TLS_REJECT_UNAUTHORIZED']) if (env[key]) throw Error('Unsafe runtime or TLS overrides are refused during acceptance');
  const configFile = join(profile, 'config.toml'), originalConfig = await readFile(configFile), originalEnvironment = await readFile(environment);
  let config; try { config = parseToml(originalConfig.toString('utf8')); } catch { throw Error('The protected Codex configuration could not be parsed'); }
  const selected = acceptanceSelection(config, env), scratch = await mkdtemp(join(tmpdir(), 'codex-native-acceptance-'));
  const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex');
  let relay;
  try {
    const home = join(scratch, 'home'), codeHome = join(home, '.codex'), workspace = join(scratch, 'workspace');
    for (const directory of [home, codeHome, workspace]) await mkdir(directory, { mode: 0o700 });
    const childEnv = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TZ', 'CODEX_CA_CERTIFICATE', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'].filter(key => env[key]).map(key => [key, env[key]]));
    relay = await relayFactory({ selected, env, expected });
    Object.assign(childEnv, { HOME: home, CODEX_HOME: codeHome, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'), MAGNUS_CODEX_ACCEPTANCE_KEY: relay.capability });
    const actualVersion = await native(['--version'], childEnv, workspace, 10000);
    if (actualVersion.trim() !== 'codex-cli ' + version) throw Error('The native Codex version differs from the reviewed package');
    const minimal = { model: selected.model, model_provider: 'native_acceptance', approval_policy: 'never', sandbox_mode: 'read-only', web_search: 'disabled', check_for_update_on_startup: false, model_providers: { native_acceptance: { name: 'Explicit external provider', base_url: relay.baseURL, env_key: 'MAGNUS_CODEX_ACCEPTANCE_KEY', wire_api: 'responses', requires_openai_auth: false, supports_websockets: false, request_max_retries: 0, stream_max_retries: 0, stream_idle_timeout_ms: 10000 } }, analytics: { enabled: false }, feedback: { enabled: false }, features: Object.fromEntries(disabled.map(key => [key, false])) };
    // The fresh home has no auth sessions, MCP servers, skills, hooks or apps.
    // Only this generated provider-only config is loaded; original config stays untouched.
    const configuration = Object.entries(minimal).flatMap(([key, value]) => typeof value === 'object' ? [] : [`${key} = ${JSON.stringify(value)}`]).join('\n') + '\n' + Object.entries(minimal.model_providers).map(([key, value]) => `[model_providers.${key}]\n` + Object.entries(value).map(([name, item]) => `${name} = ${JSON.stringify(item)}`).join('\n')).join('\n') + '\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n[features]\n' + disabled.map(key => `${key} = false`).join('\n') + '\n';
    await writeFile(join(codeHome, 'config.toml'), configuration, { mode: 0o600, flag: 'wx' });
    const overrides = Object.entries(minimal).flatMap(([key, value]) => typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => typeof item === 'object' ? Object.entries(item).flatMap(([field, setting]) => ['-c', `${key}.${name}.${field}=${JSON.stringify(setting)}`]) : ['-c', `${key}.${name}=${JSON.stringify(item)}`]) : ['-c', `${key}=${JSON.stringify(value)}`]);
    const result = await native(['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '-c', 'mcp_servers={}', '-c', 'project_doc_max_bytes=0', ...overrides, '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', workspace, `Reply with exactly ${expected}. Do not call tools, inspect files, access integrations or perform any other action.`], childEnv, workspace, 60000);
    let events; try { events = result.trim().split('\n').map(line => JSON.parse(line)); } catch { throw Error('Native acceptance returned invalid event data'); }
    // The pinned CLI emits this nonfatal metadata notice for external gateway aliases.
    // It carries no action and must not hide other native errors.
    const metadataNotice = item => item?.type === 'error' && item.message === `Model metadata for \`${selected.model}\` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.`;
    const items = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message').map(event => event.item);
    if (!relay.verified() || events.some(event => ['error', 'turn.failed'].includes(event.type)) || events.filter(event => event.type === 'turn.completed').length !== 1 || items.length !== 1 || items[0]?.type !== 'agent_message' || items[0]?.text !== expected || events.some(event => event.type?.startsWith('item.') && event.item?.type && !['agent_message', 'reasoning'].includes(event.item.type) && !metadataNotice(event.item))) throw Error(`Native acceptance did not complete one harmless assistant response (turns=${events.filter(event => event.type === 'turn.completed').length}, messages=${items.length}, stream=${relay.verified()}, exact=${items[0]?.text === expected}, itemTypes=${[...new Set(events.filter(event => event.type?.startsWith('item.')).map(event => event.item?.type ?? 'delta'))].slice(0,8).join(',')})`);
    return { ok: true, product: '@openai/codex', version, generation: true, streaming: true, externalInference: true };
  } finally {
    if (relay) await relay.close();
    await rm(scratch, { recursive: true, force: true });
    if (fingerprint(await readFile(configFile)) !== fingerprint(originalConfig) || fingerprint(await readFile(environment)) !== fingerprint(originalEnvironment)) throw Error('Protected profile or credential bytes changed during native acceptance');
  }
}
