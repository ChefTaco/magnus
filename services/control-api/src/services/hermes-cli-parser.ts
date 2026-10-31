import type {
  HermesInstallationStatus,
  HermesServiceStatus,
} from '../types/index.js';

export interface ParsedHermesProfile {
  name: string;
  description: string;
  profileHome: string;
  isDefault: boolean;
  gatewayStatus: HermesServiceStatus;
  apiServerEnabled: boolean;
  apiServerHost: string;
  apiServerPort: number | null;
  providerSummary: string | null;
  modelSummary: string | null;
  distribution: string | null;
  metadata: Record<string, unknown>;
}

export interface ParsedHermesSkill {
  slug: string;
  category: string | null;
  source: string;
  enabled: boolean;
  metadata: Record<string, unknown>;
}

export interface ParsedHermesToolset {
  toolset: string;
  enabled: boolean;
  metadata: Record<string, unknown>;
}

export interface ParsedHermesProvider {
  profileName: string | null;
  provider: string;
  model: string | null;
  configured: boolean;
  metadata: Record<string, unknown>;
}

export interface ParsedHermesPlugin {
  slug: string;
  pluginType: string;
  version: string | null;
  status: string;
  healthState: string;
  metadata: Record<string, unknown>;
}

export interface ParsedHermesMessagingBinding {
  platform: string;
  channelIds: string[];
  voiceEnabled: boolean;
  voiceModel: string | null;
  ttsProvider: string | null;
  secretRef: string | null;
  status: string;
  metadata: Record<string, unknown>;
}

export interface ParsedHermesDetection {
  installed: boolean;
  status: HermesInstallationStatus;
  version: string | null;
  hermesBin: string;
  hermesHome: string;
  gatewayStatus: HermesServiceStatus;
  dashboardStatus: HermesServiceStatus;
  dashboardHost?: string;
  dashboardPort?: number;
  apiServerEnabled: boolean;
  apiServerHost: string;
  apiServerPort: number | null;
  profiles: ParsedHermesProfile[];
  skills: ParsedHermesSkill[];
  toolsets: ParsedHermesToolset[];
  providers: ParsedHermesProvider[];
  plugins: ParsedHermesPlugin[];
  messagingBindings: ParsedHermesMessagingBinding[];
  raw: Record<string, unknown>;
}

const START = '__MAGNUS_HERMES_JSON_START__';
const END = '__MAGNUS_HERMES_JSON_END__';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((record) => Object.keys(record).length > 0)
    : [];
}

export function normalizeServiceStatus(value: unknown): HermesServiceStatus {
  const text = String(value ?? '').toLowerCase();
  if (['active', 'running', 'ok', 'healthy'].includes(text)) return 'running';
  if (['inactive', 'dead'].includes(text)) return 'inactive';
  if (['stopped', 'stop'].includes(text)) return 'stopped';
  if (['failed', 'failure'].includes(text)) return 'failed';
  if (['error', 'errored'].includes(text)) return 'error';
  if (['not_installed', 'missing', 'not-found'].includes(text)) return 'not_installed';
  return 'unknown';
}

export function normalizeInstallationStatus(value: unknown, installed: boolean): HermesInstallationStatus {
  const text = String(value ?? '').toLowerCase();
  if (!installed) return 'not_installed';
  if (['running', 'detected', 'needs_setup', 'degraded', 'error', 'unknown'].includes(text)) {
    return text as HermesInstallationStatus;
  }
  return installed ? 'detected' : 'not_installed';
}

export function extractHermesJson(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf(START);
  const end = stdout.indexOf(END);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Hermes command did not return a parseable Magnus JSON envelope');
  }

  const jsonText = stdout.slice(start + START.length, end).trim();
  return JSON.parse(jsonText) as Record<string, unknown>;
}

export function parseProfileListText(text: string, hermesHome: string): ParsedHermesProfile[] {
  const profiles: ParsedHermesProfile[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || /^(name|profiles?|[-=]+)/i.test(line)) continue;

    const isDefault = line.startsWith('*') || line.startsWith('◆') || /\bdefault\b/i.test(line);
    const cleaned = line.replace(/^[*◆◇•]\s*/, '').replace(/\s+\(default\)$/i, '').trim();
    const name = cleaned.split(/\s+/)[0];
    if (!name || /[:]/.test(name)) continue;

    profiles.push({
      name,
      description: '',
      profileHome: `${hermesHome.replace(/\/+$/, '')}/profiles/${name}`,
      isDefault,
      gatewayStatus: 'unknown',
      apiServerEnabled: false,
      apiServerHost: '127.0.0.1',
      apiServerPort: null,
      providerSummary: null,
      modelSummary: null,
      distribution: null,
      metadata: { source: 'profile-list-text' },
    });
  }
  return profiles;
}

export function parseHermesDetectionOutput(stdout: string): ParsedHermesDetection {
  const envelope = extractHermesJson(stdout);
  const installed = asBoolean(envelope['installed']);
  const hermesHome = asString(envelope['hermesHome'], '~/.hermes');
  const rawProfiles = Array.isArray(envelope['profiles']) ? envelope['profiles'] as unknown[] : [];
  const fallbackProfiles = rawProfiles.length === 0 && typeof envelope['profileListText'] === 'string'
    ? parseProfileListText(envelope['profileListText'], hermesHome)
    : [];

  const profiles = rawProfiles.length > 0
    ? rawProfiles.map((item) => {
        const record = asRecord(item);
        const name = asString(record['name']);
        return {
          name,
          description: asString(record['description']),
          profileHome: asString(record['profileHome'], asString(record['profile_home'], `${hermesHome.replace(/\/+$/, '')}/profiles/${name}`)),
          isDefault: asBoolean(record['isDefault'], asBoolean(record['is_default'], name === 'default')),
          gatewayStatus: normalizeServiceStatus(record['gatewayStatus'] ?? record['gateway_status']),
          apiServerEnabled: asBoolean(record['apiServerEnabled'], asBoolean(record['api_server_enabled'])),
          apiServerHost: asString(record['apiServerHost'], asString(record['api_server_host'], '127.0.0.1')),
          apiServerPort: asNullableNumber(record['apiServerPort']) ?? asNullableNumber(record['api_server_port']),
          providerSummary: asNullableString(record['providerSummary']) ?? asNullableString(record['provider_summary']),
          modelSummary: asNullableString(record['modelSummary']) ?? asNullableString(record['model_summary']) ?? asNullableString(record['model']),
          distribution: asNullableString(record['distribution']),
          metadata: asRecord(record['metadata']),
        } satisfies ParsedHermesProfile;
      }).filter((profile) => profile.name.length > 0)
    : fallbackProfiles;

  const skills = asRecordArray(envelope['skills']).map((record) => ({
    slug: asString(record['slug']),
    category: asNullableString(record['category']),
    source: asString(record['source'], 'detected'),
    enabled: asBoolean(record['enabled'], false),
    metadata: asRecord(record['metadata']),
  })).filter((skill) => skill.slug.length > 0);

  const toolsets = asRecordArray(envelope['toolsets']).map((record) => ({
    toolset: asString(record['toolset']),
    enabled: asBoolean(record['enabled'], true),
    metadata: asRecord(record['metadata']),
  })).filter((toolset) => toolset.toolset.length > 0);

  const providers = asRecordArray(envelope['providers']).map((record) => ({
    profileName: asNullableString(record['profileName']),
    provider: asString(record['provider']),
    model: asNullableString(record['model']),
    configured: asBoolean(record['configured'], true),
    metadata: asRecord(record['metadata']),
  })).filter((provider) => provider.provider.length > 0);

  const plugins = asRecordArray(envelope['plugins']).map((record) => ({
    slug: asString(record['slug']),
    pluginType: asString(record['pluginType'], 'general'),
    version: asNullableString(record['version']),
    status: asString(record['status'], 'detected'),
    healthState: asString(record['healthState'], 'unknown'),
    metadata: asRecord(record['metadata']),
  })).filter((plugin) => plugin.slug.length > 0);

  const messagingBindings = asRecordArray(envelope['messagingBindings']).map((record) => ({
    platform: asString(record['platform']),
    channelIds: Array.isArray(record['channelIds']) ? record['channelIds'].filter((item): item is string => typeof item === 'string') : [],
    voiceEnabled: asBoolean(record['voiceEnabled']),
    voiceModel: asNullableString(record['voiceModel']),
    ttsProvider: asNullableString(record['ttsProvider']),
    secretRef: asNullableString(record['secretRef']),
    status: asString(record['status'], 'detected'),
    metadata: asRecord(record['metadata']),
  })).filter((binding) => binding.platform.length > 0);

  return {
    installed,
    status: normalizeInstallationStatus(envelope['status'], installed),
    version: asNullableString(envelope['version']),
    hermesBin: asString(envelope['hermesBin'], 'hermes'),
    hermesHome,
    gatewayStatus: normalizeServiceStatus(envelope['gatewayStatus']),
    dashboardStatus: normalizeServiceStatus(envelope['dashboardStatus']),
    apiServerEnabled: asBoolean(envelope['apiServerEnabled']),
    apiServerHost: asString(envelope['apiServerHost'], '127.0.0.1'),
    apiServerPort: asNullableNumber(envelope['apiServerPort']),
    profiles,
    skills,
    toolsets,
    providers,
    plugins,
    messagingBindings,
    raw: envelope,
  };
}

export function buildHermesDetectionScript(options: {
  hermesHome: string;
  hermesBin: string;
  dashboardPort?: number;
}): string {
  const payload = Buffer.from(JSON.stringify(options), 'utf-8').toString('base64');
  return String.raw`
set +e
MAGNUS_HERMES_PAYLOAD='${payload}' python3 - <<'PY'
import base64, json, os, pathlib, re, shutil, subprocess

START = '${START}'
END = '${END}'
opts = json.loads(base64.b64decode(os.environ['MAGNUS_HERMES_PAYLOAD']).decode('utf-8'))
hermes_home = os.path.expanduser(opts.get('hermesHome') or '~/.hermes')
requested_bin = opts.get('hermesBin') or 'hermes'
dashboard_port = int(opts.get('dashboardPort') or 9119)


def looks_like_hermes_home(path):
    home = pathlib.Path(path)
    return (home / 'config.yaml').exists() or (home / '.env').exists() or (home / 'profiles').exists()


candidate_homes = []
for item in [
    hermes_home,
    os.environ.get('HERMES_HOME'),
    os.path.expanduser('~/.hermes'),
    os.path.expanduser('~/.config/hermes'),
    os.path.expanduser('~/.config/hermes-agent'),
    '/opt/hermes-agent',
    '/opt/hermes',
]:
    if item and item not in candidate_homes:
        candidate_homes.append(item)
if not looks_like_hermes_home(hermes_home):
    for candidate_home in candidate_homes:
        if looks_like_hermes_home(candidate_home):
            hermes_home = candidate_home
            break


def run(cmd, output_limit=20000):
    try:
        proc = subprocess.run(cmd, text=True, capture_output=True, timeout=15, env={**os.environ, 'HERMES_HOME': hermes_home, 'COLUMNS': '240'})
        return {'code': proc.returncode, 'stdout': (proc.stdout or '')[:output_limit], 'stderr': (proc.stderr or '')[:output_limit]}
    except Exception as exc:
        return {'code': 127, 'stdout': '', 'stderr': str(exc)}

candidate_bins = []
if requested_bin:
    candidate_bins.append(requested_bin)
candidate_bins.extend([
    'hermes',
    os.path.expanduser('~/.local/bin/hermes'),
    os.path.join(hermes_home, 'bin', 'hermes'),
    os.path.join(hermes_home, 'hermes'),
    os.path.join(hermes_home, 'hermes-agent', 'hermes'),
])
resolved_bin = ''
for candidate in candidate_bins:
    expanded = os.path.expanduser(candidate)
    found = shutil.which(expanded) if os.path.sep not in expanded else (expanded if os.path.exists(expanded) and os.access(expanded, os.X_OK) else '')
    if found:
        resolved_bin = found
        break
installed = bool(resolved_bin) or pathlib.Path(hermes_home).exists()
version = None
profile_list_text = ''
profiles = []
skills = []
toolsets = []
providers = []
plugins = []
messaging_bindings = []

def first_nonempty(text):
    for line in text.splitlines():
        line = line.strip()
        if line:
            return line
    return None


def clean_cell(text):
    return re.sub(r'\s+', ' ', text.replace('…', '')).strip()


def is_decoration_text(text):
    return bool(text) and not re.search(r'[A-Za-z0-9]', text)


def rich_rows(text):
    rows = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line.startswith('│'):
            continue
        cells = [clean_cell(part) for part in line.strip('│').split('│')]
        if not cells:
            continue
        nonempty = [cell for cell in cells if cell]
        if nonempty and all(is_decoration_text(cell) for cell in nonempty):
            continue
        if is_decoration_text(cells[0]) or re.match(r'^(name|profile|tool|status)$', cells[0], re.I):
            continue
        rows.append(cells)
    return rows

if resolved_bin:
    version_result = run([resolved_bin, '--version'])
    version = first_nonempty(version_result['stdout']) or first_nonempty(version_result['stderr'])
    profile_result = run([resolved_bin, 'profile', 'list'])
    profile_list_text = (profile_result['stdout'] or profile_result['stderr'] or '')[:20000]

    profile_rows = rich_rows(profile_list_text)
    if profile_rows:
        for cells in profile_rows:
            name_cell = cells[0] if cells else ''
            is_default = name_cell.startswith('*') or name_cell.startswith('◆') or 'default' in name_cell.lower()
            name = re.sub(r'^[*◆◇•]\s*', '', name_cell).split()[0] if name_cell.split() else ''
            if not name or ':' in name or is_decoration_text(name):
                continue
            model = cells[1] if len(cells) > 1 and cells[1] not in ('—', '-') else None
            gateway = cells[2] if len(cells) > 2 else 'unknown'
            alias = cells[3] if len(cells) > 3 and cells[3] not in ('—', '-') else None
            distribution = cells[4] if len(cells) > 4 and cells[4] not in ('—', '-') else None
            profiles.append({
                'name': name,
                'description': '',
                'profileHome': os.path.join(hermes_home, 'profiles', name),
                'isDefault': is_default,
                'gatewayStatus': gateway,
                'apiServerEnabled': False,
                'apiServerHost': '127.0.0.1',
                'apiServerPort': None,
                'providerSummary': None,
                'modelSummary': model,
                'distribution': distribution,
                'metadata': {'source': 'hermes profile list', 'alias': alias},
            })
    else:
        for raw in profile_list_text.splitlines():
            line = raw.strip()
            if not line or re.match(r'^(name|profiles?|[-=]+)', line, re.I):
                continue
            is_default = line.startswith('*') or line.startswith('◆') or 'default' in line.lower()
            cleaned = re.sub(r'^[*◆◇•]\s*', '', line)
            cleaned = re.sub(r'\s+\(default\)$', '', cleaned, flags=re.I).strip()
            if is_decoration_text(cleaned):
                continue
            parts = re.split(r'\s{2,}', cleaned)
            name = parts[0].split()[0] if parts and parts[0].split() else ''
            if not name or ':' in name or is_decoration_text(name):
                continue
            model = parts[1] if len(parts) > 1 and parts[1] not in ('—', '-') else None
            gateway = parts[2] if len(parts) > 2 else 'unknown'
            alias = parts[3] if len(parts) > 3 and parts[3] not in ('—', '-') else None
            distribution = parts[4] if len(parts) > 4 and parts[4] not in ('—', '-') else None
            profiles.append({
                'name': name,
                'description': '',
                'profileHome': os.path.join(hermes_home, 'profiles', name),
                'isDefault': is_default,
                'gatewayStatus': gateway,
                'apiServerEnabled': False,
                'apiServerHost': '127.0.0.1',
                'apiServerPort': None,
                'providerSummary': None,
                'modelSummary': model,
                'distribution': distribution,
                'metadata': {'source': 'hermes profile list', 'alias': alias},
            })

    skills_result = run([resolved_bin, 'skills', 'list'], output_limit=1048576)
    for cells in rich_rows(skills_result.get('stdout') or skills_result.get('stderr') or ''):
        if len(cells) >= 5:
            status_value = cells[4].lower()
            skills.append({'slug': cells[0], 'category': cells[1] or None, 'source': cells[2] or 'detected', 'enabled': status_value == 'enabled', 'metadata': {'trust': cells[3], 'status': status_value or 'unknown', 'source': 'hermes skills list'}})

    tools_result = run([resolved_bin, 'tools', 'list'])
    for raw in (tools_result.get('stdout') or tools_result.get('stderr') or '').splitlines():
        line = raw.strip()
        match = re.match(r'^(✓|✗)\s+(enabled|disabled)\s+([a-zA-Z0-9_.-]+)\s+(.*)$', line)
        if match:
            toolsets.append({'toolset': match.group(3), 'enabled': match.group(2) == 'enabled', 'metadata': {'label': clean_cell(match.group(4)), 'source': 'hermes tools list'}})

    plugins_result = run([resolved_bin, 'plugins', 'list'])
    for cells in rich_rows(plugins_result.get('stdout') or plugins_result.get('stderr') or ''):
        if len(cells) >= 5 and cells[0]:
            status_value = cells[1].lower().replace(' ', '_') or 'detected'
            plugins.append({'slug': cells[0], 'pluginType': cells[0].split('/')[0] if '/' in cells[0] else 'general', 'version': cells[2] or None, 'status': status_value, 'healthState': 'unknown', 'metadata': {'source': cells[4] or 'hermes plugins list'}})

    gateway_result = run([resolved_bin, 'gateway', 'status'])
    gateway_text = (gateway_result['stdout'] + gateway_result['stderr']).lower()
else:
    gateway_result = {'code': 127, 'stdout': '', 'stderr': 'hermes binary not found'}
    gateway_text = ''

# Profile discovery fallback: Hermes can be installed with a valid home even when
# the binary is not visible to a non-login SSH shell. Scan profile directories,
# then use the implicit default profile convention for existing Hermes homes.
if not profiles:
    profiles_dir = pathlib.Path(hermes_home) / 'profiles'
    if profiles_dir.exists():
        for profile_dir in sorted(profiles_dir.iterdir(), key=lambda p: p.name):
            if not profile_dir.is_dir():
                continue
            name = profile_dir.name.strip()
            if not name or not re.match(r'^[A-Za-z0-9_.-]+$', name):
                continue
            profiles.append({
                'name': name,
                'description': '',
                'profileHome': str(profile_dir),
                'isDefault': name == 'default',
                'gatewayStatus': 'unknown',
                'apiServerEnabled': False,
                'apiServerHost': '127.0.0.1',
                'apiServerPort': None,
                'providerSummary': None,
                'modelSummary': None,
                'distribution': None,
                'metadata': {'source': 'filesystem profiles'},
            })
if installed and not profiles and pathlib.Path(hermes_home).exists():
    profiles.append({
        'name': 'default',
        'description': '',
        'profileHome': str(pathlib.Path(hermes_home) / 'profiles' / 'default'),
        'isDefault': True,
        'gatewayStatus': 'unknown',
        'apiServerEnabled': False,
        'apiServerHost': '127.0.0.1',
        'apiServerPort': None,
        'providerSummary': None,
        'modelSummary': None,
        'distribution': None,
        'metadata': {'source': 'implicit-default-profile'},
    })

# Check systemd and port hints for local dashboard status.
dash_user = run(['systemctl', '--user', 'is-active', 'hermes-dashboard.service'])
dash_system = run(['systemctl', 'is-active', 'hermes-dashboard.service'])
dash_text = (dash_user['stdout'] + dash_user['stderr'] + dash_system['stdout'] + dash_system['stderr']).lower()

# Read base .env for API server hints and configured provider key names. Do not return secret values.
env_path = pathlib.Path(hermes_home) / '.env'
api_enabled = False
api_host = '127.0.0.1'
api_port = None
env_values = {}
env_keys = []
configured_provider_keys = []
if env_path.exists():
    try:
        for line in env_path.read_text(errors='ignore').splitlines():
            if line.startswith('API_SERVER_ENABLED='):
                api_enabled = line.split('=', 1)[1].strip().lower() == 'true'
            elif line.startswith('API_SERVER_HOST='):
                api_host = line.split('=', 1)[1].strip() or api_host
            elif line.startswith('API_SERVER_PORT='):
                try:
                    api_port = int(line.split('=', 1)[1].strip())
                except Exception:
                    api_port = None
            key = line.split('=', 1)[0].strip() if '=' in line else ''
            value = line.split('=', 1)[1].strip() if '=' in line else ''
            if key:
                env_values[key] = value
                env_keys.append(key)
            if key.endswith('_API_KEY') or key.endswith('_TOKEN'):
                configured_provider_keys.append(key)
    except Exception:
        pass

config_path = pathlib.Path(hermes_home) / 'config.yaml'
config_data = {}
if config_path.exists():
    try:
        import yaml
        loaded = yaml.safe_load(config_path.read_text(errors='ignore'))
        if isinstance(loaded, dict):
            config_data = loaded
    except Exception:
        config_data = {}

model_provider = None
model_name = None
configured_provider_names = []
seen_providers = set()


def normalize_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    if isinstance(value, dict):
        return list(value.keys())
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        if ',' in text:
            return [part.strip() for part in text.split(',')]
        return [text]
    return []


def provider_from_env_key(key):
    known_prefixes = {
        'ANTHROPIC': 'anthropic',
        'OPENAI': 'openai',
        'OPENROUTER': 'openrouter',
        'GOOGLE': 'google',
        'GEMINI': 'google',
        'GROQ': 'groq',
        'MISTRAL': 'mistral',
        'TOGETHER': 'together',
        'XAI': 'xai',
        'DEEPSEEK': 'deepseek',
        'PERPLEXITY': 'perplexity',
        'COHERE': 'cohere',
        'MINIMAX': 'minimax',
        'AZURE_OPENAI': 'azure-openai',
        'AWS': 'bedrock',
        'BEDROCK': 'bedrock',
    }
    for prefix, provider in known_prefixes.items():
        if key == prefix + '_API_KEY' or key.startswith(prefix + '_'):
            return provider
    return None


def clean_provider_name(value):
    if not isinstance(value, str):
        return None
    name = value.strip().strip('"\'')
    if not name or '://' in name or '/' in name or len(name) > 80:
        return None
    if not re.match(r'^[A-Za-z0-9_.-]+$', name):
        return None
    return name


def add_provider(provider, model=None, source='config', metadata=None):
    name = clean_provider_name(provider)
    if not name:
        return
    key = (name, model or '')
    if key in seen_providers:
        return
    seen_providers.add(key)
    configured_provider_names.append(name)
    providers.append({'profileName': None, 'provider': name, 'model': model if isinstance(model, str) and model else None, 'configured': True, 'metadata': {'source': source, **(metadata or {})}})


if config_data:
    model_section = config_data.get('model') if isinstance(config_data.get('model'), dict) else {}
    model_provider = clean_provider_name(model_section.get('provider')) if isinstance(model_section, dict) else None
    model_name = model_section.get('default') if isinstance(model_section.get('default'), str) else None
    if model_provider or model_name:
        add_provider(model_provider or 'configured-model', model_name, 'config.model')

    for name in normalize_list(config_data.get('providers')):
        add_provider(str(name), None, 'config.providers')
    for name in normalize_list(config_data.get('fallback_providers')):
        add_provider(str(name), None, 'config.fallback_providers')

    fallback_model = config_data.get('fallback_model')
    if isinstance(fallback_model, dict):
        add_provider(fallback_model.get('provider'), fallback_model.get('model') if isinstance(fallback_model.get('model'), str) else None, 'config.fallback_model')

    skip_sections = {'telegram', 'discord', 'slack', 'qqbot', 'google_chat', 'messaging', 'integrations', 'model_catalog'}
    def walk_provider_configs(obj, path=()):
        if isinstance(obj, dict):
            top = path[0] if path else ''
            if top not in skip_sections and isinstance(obj.get('provider'), str):
                model_value = obj.get('model') or obj.get('default') or obj.get('model_id')
                add_provider(obj.get('provider'), model_value if isinstance(model_value, str) else None, 'config.' + '.'.join(path) if path else 'config')
            for key, value in obj.items():
                walk_provider_configs(value, path + (str(key),))
        elif isinstance(obj, list):
            for index, value in enumerate(obj):
                walk_provider_configs(value, path + (str(index),))
    walk_provider_configs(config_data)

for key in configured_provider_keys:
    env_provider = provider_from_env_key(key)
    if env_provider:
        add_provider(env_provider, None, 'env-key', {'configuredKey': key})

for profile in profiles:
    if profile.get('modelSummary'):
        providers.append({'profileName': profile.get('name'), 'provider': model_provider or (configured_provider_names[0] if configured_provider_names else 'default'), 'model': profile.get('modelSummary'), 'configured': True, 'metadata': {'source': 'hermes profile list'}})


def env_present(key):
    return bool(env_values.get(key))


def add_messaging_binding(platform, section, token_keys, channel_env_keys=()):
    section = section if isinstance(section, dict) else {}
    channel_ids = []
    for key in ('allowed_chats', 'allowed_channels', 'free_response_channels'):
        channel_ids.extend(str(item) for item in normalize_list(section.get(key)) if str(item).strip())
    prompts = section.get('channel_prompts')
    if isinstance(prompts, dict):
        channel_ids.extend(str(key) for key in prompts.keys() if str(key).strip())
    for key in channel_env_keys:
        if env_values.get(key):
            channel_ids.append(env_values[key])
    channel_ids = sorted(set(channel_ids))
    secret_key = next((key for key in token_keys if env_present(key)), None)
    configured = bool(secret_key or channel_ids or section)
    if configured:
        messaging_bindings.append({
            'platform': platform,
            'channelIds': channel_ids,
            'voiceEnabled': bool(section.get('voice_enabled') or section.get('voice')),
            'voiceModel': section.get('voice_model') if isinstance(section.get('voice_model'), str) else None,
            'ttsProvider': section.get('tts_provider') if isinstance(section.get('tts_provider'), str) else None,
            'secretRef': ('env:' + secret_key) if secret_key else None,
            'status': 'detected',
            'metadata': {'source': 'sanitized-config', 'configuredKeys': [key for key in token_keys if key in env_values]},
        })

if config_data or env_values:
    add_messaging_binding('telegram', config_data.get('telegram') if isinstance(config_data, dict) else {}, ['TELEGRAM_BOT_TOKEN'], ['TELEGRAM_HOME_CHANNEL'])
    add_messaging_binding('discord', config_data.get('discord') if isinstance(config_data, dict) else {}, ['DISCORD_BOT_TOKEN'])
    add_messaging_binding('slack', config_data.get('slack') if isinstance(config_data, dict) else {}, ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'])

plugins_dir = pathlib.Path(hermes_home) / 'plugins'
if plugins_dir.exists():
    for plugin_yaml in plugins_dir.glob('*/*/plugin.yaml'):
        slug = '/'.join(plugin_yaml.relative_to(plugins_dir).parts[:-1])
        if slug and not any(p.get('slug') == slug for p in plugins):
            plugins.append({'slug': slug, 'pluginType': slug.split('/')[0], 'version': None, 'status': 'detected', 'healthState': 'unknown', 'metadata': {'source': 'filesystem'}})

status = 'not_installed'
if installed:
    status = 'detected'
    if 'running' in gateway_text or 'active' in gateway_text:
        status = 'running'
    elif resolved_bin and not pathlib.Path(hermes_home).exists():
        status = 'needs_setup'

out = {
    'installed': installed,
    'status': status,
    'version': version,
    'hermesBin': resolved_bin or requested_bin,
    'hermesHome': hermes_home,
    'gatewayStatus': 'running' if ('running' in gateway_text or 'active' in gateway_text) else ('error' if gateway_result.get('code') not in (0, None) and resolved_bin else 'unknown'),
    'dashboardStatus': 'running' if 'active' in dash_text else ('inactive' if 'inactive' in dash_text else 'unknown'),
    'dashboardPort': dashboard_port,
    'apiServerEnabled': api_enabled,
    'apiServerHost': api_host,
    'apiServerPort': api_port,
    'profiles': profiles,
    'skills': skills,
    'toolsets': toolsets,
    'providers': providers,
    'plugins': plugins,
    'messagingBindings': messaging_bindings,
    'profileListText': profile_list_text,
    'configuration': {
        'configPresent': config_path.exists(),
        'configPath': str(config_path) if config_path.exists() else None,
        'envPath': str(env_path) if env_path.exists() else None,
        'envKeys': sorted(set(env_keys)),
        'modelProvider': model_provider,
        'modelName': model_name,
        'modelBaseUrl': config_data.get('model', {}).get('base_url') if isinstance(config_data.get('model'), dict) else None,
        'openaiRuntime': config_data.get('model', {}).get('openai_runtime') if isinstance(config_data.get('model'), dict) else None,
        'magnusRouterConfigured': model_provider == 'custom',
        'memoryProvider': config_data.get('memory', {}).get('provider') if isinstance(config_data.get('memory'), dict) else None,
        'hiveMemConfigured': config_data.get('memory', {}).get('provider') == 'hivemem' if isinstance(config_data.get('memory'), dict) else False,
        'hiveMemPluginInstalled': pathlib.Path(hermes_home, 'plugins', 'memory', 'hivemem', '__init__.py').exists(),
        'hiveMemApiUrl': env_values.get('HERMES_HIVEMEM_API_URL') or env_values.get('HIVEMEM_URL'),
        'magnusSkills': {
            'status': 'available' if os.environ.get('MAGNUS_SKILLS_DIR') else 'not_configured',
            'message': 'Hermes Agent skills are published from magnus-skills and reconciled through magnus-agent.' if os.environ.get('MAGNUS_SKILLS_DIR') else 'Set MAGNUS_SKILLS_DIR on this node to expose the magnus-skills catalogue to Hermes Agent profiles.',
        },
    },
    'rawChecks': {
        'version': version,
        'gatewayCode': gateway_result.get('code'),
        'dashboardUserCode': dash_user.get('code'),
        'dashboardSystemCode': dash_system.get('code'),
        'hermesHomeExists': pathlib.Path(hermes_home).exists(),
    },
}
print(START)
print(json.dumps(out))
print(END)
PY
`;
}
