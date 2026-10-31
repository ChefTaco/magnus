import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { observeHermesDashboard } from './hermes-dashboard-discovery.js';
import { inspectHiveMemToken, type HiveMemTokenPosture } from './hivemem-token.js';
import { childEnvironment } from '../utils/child-env.js';
import { armChildTimeout } from '../utils/child-timeout.js';

const OFFICIAL_INSTALL_SCRIPT =
  'https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh';
const DEFAULT_HERMES_HOME = process.env['HERMES_HOME'] ?? '~/.hermes';
const MAX_PLUGIN_BYTES = 768 * 1024;
const MAGNUS_STATE_FILE = '.magnus-managed.json';

type HermesServiceStatus =
  | 'unknown'
  | 'not_installed'
  | 'inactive'
  | 'running'
  | 'stopped'
  | 'failed'
  | 'error';

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface HermesSkillState {
  slug: string;
  category: string | null;
  source: string;
  enabled: boolean;
  metadata: Record<string, unknown>;
}

interface HermesToolsetState {
  toolset: string;
  enabled: boolean;
  metadata: Record<string, unknown>;
}

interface HermesProviderState {
  profileName: string | null;
  provider: string;
  model: string | null;
  configured: boolean;
  metadata: Record<string, unknown>;
}

interface HermesPluginState {
  slug: string;
  pluginType: string;
  version: string | null;
  status: string;
  healthState: string;
  metadata: Record<string, unknown>;
}

export interface HermesNodeState {
  installed: boolean;
  status: 'not_installed' | 'detected' | 'needs_setup' | 'running' | 'degraded' | 'error';
  installMode: 'official-script' | 'existing';
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
  profiles: Array<Record<string, unknown>>;
  skills: HermesSkillState[];
  toolsets: HermesToolsetState[];
  providers: HermesProviderState[];
  plugins: HermesPluginState[];
  configuration: {
    configPresent: boolean;
    configPath: string | null;
    envPath: string | null;
    envKeys: string[];
    modelProvider: string | null;
    modelName: string | null;
    modelBaseUrl: string | null;
    openaiRuntime: 'auto' | 'codex_app_server' | null;
    magnusRouterConfigured: boolean;
    memoryProvider: string | null;
    hiveMemConfigured: boolean;
    hiveMemPluginInstalled: boolean;
    hiveMemApiUrl: string | null;
    hiveMemToken: HiveMemTokenPosture | null;
    magnusSkills: {
      status: 'available' | 'not_configured';
      message: string;
    };
  };
  rawChecks: Record<string, unknown>;
}

const safeValue = z.string().min(1).refine((value) => !/[\r\n]/.test(value), {
  message: 'Value may not contain a newline',
});
const safeUrl = z.string().url().refine((value) => !/[\r\n]/.test(value), {
  message: 'URL may not contain a newline',
});
const fileSchema = z.object({
  path: z.string().min(1).max(200).regex(/^[a-zA-Z0-9_.\-/]+$/),
  content: z.string(),
});

const configurationSchema = z.object({
  openaiRuntime: z.enum(['auto', 'codex_app_server']).optional(),
  router: z.object({
    baseUrl: safeUrl,
    model: safeValue,
    apiKey: safeValue.optional(),
  }).optional(),
  hiveMem: z.object({
    apiUrl: safeUrl,
    token: safeValue.optional(),
    workspaceId: safeValue.default('default'),
    defaultScope: z.enum(['private', 'shared']).default('private'),
    recallMode: z.enum(['hybrid', 'context', 'tools', 'off']).default('hybrid'),
    pluginFiles: z.array(fileSchema).optional(),
  }).optional(),
});

const targetSchema = z.object({
  hermesHome: z.string().trim().min(1).default(DEFAULT_HERMES_HOME),
  hermesBin: z.string().trim().min(1).default('hermes'),
});
const installSchema = targetSchema.extend({
  skipBrowser: z.boolean().default(false),
  configuration: configurationSchema.optional(),
});
const updateSchema = targetSchema.extend({
  checkOnly: z.boolean().default(false),
  backup: z.boolean().default(true),
  configuration: configurationSchema.optional(),
});
const uninstallSchema = targetSchema.extend({
  confirm: z.literal(true),
  keepConfiguration: z.boolean().default(true),
});

export const hermesRoutes = new Hono();

function expandHome(value: string): string {
  return value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
}

function target(options: { hermesHome: string; hermesBin: string }): { home: string; bin: string } {
  if (!/^[a-zA-Z0-9_./~-]+$/.test(options.hermesBin)) throw new Error('Invalid Hermes executable path');
  return { home: resolve(expandHome(options.hermesHome)), bin: expandHome(options.hermesBin) };
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())).map((value) => value.trim()))];
}

async function userHomeCandidates(): Promise<string[]> {
  const configuredUsers = unique([
    process.env['HERMES_USER'],
    process.env['HERMES_OWNER'],
    process.env['SUDO_USER'],
    process.env['USER'] && process.env['USER'] !== 'root' ? process.env['USER'] : null,
  ]);
  const configuredHomes = configuredUsers.map((user) => `/home/${user}`);

  let scannedHomes: string[] = [];
  try {
    const entries = await readdir('/home', { withFileTypes: true });
    scannedHomes = entries
      .filter((entry) => entry.isDirectory() && /^[a-z_][a-z0-9_-]*[$]?$/i.test(entry.name))
      .map((entry) => `/home/${entry.name}`);
  } catch {
    // /home may not be readable or present in minimal containers.
  }

  return unique([...configuredHomes, ...scannedHomes]);
}

async function homeCandidates(requestedHome: string): Promise<string[]> {
  const userHomes = await userHomeCandidates();
  return unique([
    resolve(expandHome(requestedHome)),
    process.env['HERMES_HOME'] ? resolve(expandHome(process.env['HERMES_HOME'])) : null,
    join(homedir(), '.hermes'),
    join(homedir(), '.config', 'hermes'),
    join(homedir(), '.config', 'hermes-agent'),
    ...userHomes.map((home) => join(home, '.hermes')),
    ...userHomes.map((home) => join(home, '.config', 'hermes')),
    ...userHomes.map((home) => join(home, '.config', 'hermes-agent')),
    '/opt/hermes-agent',
    '/opt/hermes',
  ]);
}

function binCandidates(requestedBin: string, home: string): string[] {
  const ownerHome = dirname(home);
  return unique([
    process.env['HERMES_BIN'],
    expandHome(requestedBin),
    'hermes',
    join(homedir(), '.local', 'bin', 'hermes'),
    join(ownerHome, '.local', 'bin', 'hermes'),
    join(home, 'bin', 'hermes'),
    join(home, 'hermes'),
    join(home, 'hermes-agent', 'hermes'),
    '/usr/local/bin/hermes',
    '/usr/bin/hermes',
  ]);
}

function firstLine(text: string): string | null {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? null;
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function cleanTableCell(text: string): string {
  return stripAnsi(text).replace(/\s+/g, ' ').trim();
}

function richTableRows(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => stripAnsi(line))
    .filter((line) => line.includes('│'))
    .map((line) => line.split('│').slice(1, -1).map(cleanTableCell))
    .filter((cells) => cells.length > 0 && cells.some(Boolean) && !/^name$/i.test(cells[0] ?? ''));
}

function parseJsonArray(value: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      : [];
  } catch {
    return [];
  }
}

function pluginType(slug: string): string {
  if (slug.includes('/')) return slug.split('/').at(0) || 'general';
  if (slug.includes('-')) return slug.split('-').at(0) || 'general';
  return 'general';
}

function isEnabledStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return normalized.includes('enabled') && !normalized.includes('not enabled') && !normalized.includes('disabled');
}

function redact(text: string): string {
  return text
    .replace(/(api[_-]?key|token|authorization)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function looksLikeHermesHome(home: string): Promise<boolean> {
  return await exists(join(home, 'config.yaml'))
    || await exists(join(home, '.env'))
    || await exists(join(home, 'profiles'));
}

function run(command: string, args: string[], options: {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stdin?: string;
} = {}): Promise<CommandResult> {
  return new Promise((complete) => {
    const proc = spawn(command, args, { env: childEnvironment(options.env), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const disarm = armChildTimeout(proc, options.timeoutMs ?? 30_000, () => { timedOut = true; });
    proc.stdout.on('data', (chunk: Buffer) => { stdout = `${stdout}${chunk.toString()}`.slice(-256_000); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-256_000); });
    proc.on('error', (err) => {
      disarm();
      complete({ code: 127, stdout, stderr: `${stderr}\n${err.message}` });
    });
    proc.on('close', (code) => {
      disarm();
      complete({ code: timedOut ? 124 : code ?? 1, stdout, stderr: timedOut ? `${stderr}\nCommand timed out` : stderr });
    });
    if (options.stdin) proc.stdin.write(options.stdin);
    proc.stdin.end();
  });
}

async function runHermes(
  options: { hermesHome: string; hermesBin: string },
  args: string[],
  timeoutMs = 30_000,
  stdin?: string,
): Promise<CommandResult> {
  const resolved = target(options);
  return run(resolved.bin, args, { env: { HERMES_HOME: resolved.home, COLUMNS: '240' }, timeoutMs, stdin });
}

async function collectHermesSkills(options: { hermesHome: string; hermesBin: string }): Promise<HermesSkillState[]> {
  const result = await runHermes(options, ['skills', 'list'], 20_000);
  const rows = richTableRows(`${result.stdout}\n${result.stderr}`);
  return rows
    .filter((cells) => cells.length >= 5 && cells[0] && !/^[-\s]+$/.test(cells[0]))
    .slice(0, 250)
    .map((cells) => {
      const slug = cells[0] ?? 'unknown';
      const status = cells[4] ?? 'unknown';
      return {
        slug,
        category: cells[1] || null,
        source: cells[2] || 'detected',
        enabled: status.toLowerCase() === 'enabled',
        metadata: { trust: cells[3] || null, status, source: 'hermes skills list' },
      };
    });
}

async function collectHermesPlugins(options: { hermesHome: string; hermesBin: string }): Promise<HermesPluginState[]> {
  const jsonResult = await runHermes(options, ['plugins', 'list', '--json'], 20_000);
  const jsonRows = jsonResult.code === 0 ? parseJsonArray(jsonResult.stdout) : [];
  if (jsonRows.length > 0) {
    return jsonRows.slice(0, 250).map((row) => {
      const slug = typeof row['name'] === 'string' ? row['name'] : 'unknown';
      const status = typeof row['status'] === 'string' ? row['status'] : 'unknown';
      return {
        slug,
        pluginType: pluginType(slug),
        version: typeof row['version'] === 'string' ? row['version'] : null,
        status,
        healthState: isEnabledStatus(status) ? 'enabled' : 'inactive',
        metadata: {
          source: typeof row['source'] === 'string' ? row['source'] : 'hermes plugins list --json',
          description: typeof row['description'] === 'string' ? row['description'] : undefined,
        },
      };
    });
  }

  const textResult = await runHermes(options, ['plugins', 'list'], 20_000);
  const rows = richTableRows(`${textResult.stdout}\n${textResult.stderr}`);
  return rows
    .filter((cells) => cells.length >= 5 && cells[0])
    .slice(0, 250)
    .map((cells) => {
      const slug = cells[0] ?? 'unknown';
      const status = cells[1] ?? 'unknown';
      return {
        slug,
        pluginType: pluginType(slug),
        version: cells[2] || null,
        status,
        healthState: isEnabledStatus(status) ? 'enabled' : 'inactive',
        metadata: { source: cells[4] || 'hermes plugins list', description: cells[3] || undefined },
      };
    });
}

function providersFromConfiguration(config: string, configuration: HermesNodeState['configuration']): HermesProviderState[] {
  if (!configuration.modelProvider && !configuration.modelName) return [];
  return [{
    profileName: null,
    provider: configuration.modelProvider ?? 'configured-model',
    model: configuration.modelName,
    configured: Boolean(configuration.modelProvider || configuration.modelName || config),
    metadata: { source: 'config.model', baseUrl: configuration.modelBaseUrl },
  }];
}

async function discoverRuntimeTarget(requested: { hermesHome: string; hermesBin: string }): Promise<{
  requested: { hermesHome: string; hermesBin: string };
  resolved: { home: string; bin: string };
  versionResult: CommandResult;
  fallbackVersion: CommandResult | null;
  homeDetected: boolean;
}> {
  let firstHomeOnly: string | null = null;
  for (const home of await homeCandidates(requested.hermesHome)) {
    const homeDetected = await looksLikeHermesHome(home);
    if (homeDetected && !firstHomeOnly) firstHomeOnly = home;
    for (const bin of binCandidates(requested.hermesBin, home)) {
      const versionResult = await run(bin, ['version'], { env: { HERMES_HOME: home }, timeoutMs: 10_000 });
      const fallbackVersion = versionResult.code === 0 ? null : await run(bin, ['--version'], { env: { HERMES_HOME: home }, timeoutMs: 10_000 });
      if (versionResult.code === 0 || fallbackVersion?.code === 0) {
        return {
          requested: { hermesHome: home, hermesBin: bin },
          resolved: { home, bin },
          versionResult,
          fallbackVersion,
          homeDetected,
        };
      }
    }
  }

  const home = firstHomeOnly ?? resolve(expandHome(requested.hermesHome));
  const bin = expandHome(requested.hermesBin);
  return {
    requested: { hermesHome: home, hermesBin: bin },
    resolved: { home, bin },
    versionResult: { code: 127, stdout: '', stderr: 'Hermes binary not found' },
    fallbackVersion: null,
    homeDetected: Boolean(firstHomeOnly),
  };
}

function yamlBlockValue(contents: string, block: string, key: string): string | null {
  let within = false;
  for (const line of contents.split(/\r?\n/)) {
    if (/^[a-zA-Z_][\w-]*:\s*(?:#.*)?$/.test(line)) {
      within = line.startsWith(`${block}:`);
      continue;
    }
    if (!within) continue;
    const match = line.match(new RegExp(`^\\s{2}${key}:\\s*(.*?)\\s*(?:#.*)?$`));
    if (match?.[1]) return match[1].replace(/^["']|["']$/g, '');
  }
  return null;
}

function updateYamlBlock(contents: string, block: string, values: Record<string, string>): string {
  const output: string[] = [];
  const pending = new Map(Object.entries(values));
  let inBlock = false;
  let foundBlock = false;
  const flush = (): void => {
    if (!inBlock) return;
    for (const [key, value] of pending) output.push(`  ${key}: ${value}`);
    pending.clear();
    inBlock = false;
  };
  for (const line of contents.split(/\r?\n/)) {
    const topLevel = /^[a-zA-Z_][\w-]*:\s*(?:#.*)?$/.test(line);
    if (topLevel && inBlock) flush();
    if (line.startsWith(`${block}:`) && topLevel) {
      foundBlock = true;
      inBlock = true;
      output.push(line);
      continue;
    }
    if (inBlock) {
      const key = line.match(/^\s{2}([a-zA-Z_][\w-]*):/)?.[1];
      if (key && pending.has(key)) {
        output.push(`  ${key}: ${pending.get(key)}`);
        pending.delete(key);
        continue;
      }
    }
    output.push(line);
  }
  flush();
  if (!foundBlock) {
    if (output.some((line) => line.trim())) output.push('');
    output.push(`${block}:`, ...Object.entries(values).map(([key, value]) => `  ${key}: ${value}`));
  }
  return `${output.join('\n').trimEnd()}\n`;
}

async function updateEnvFile(path: string, values: Record<string, string>): Promise<void> {
  let lines = await exists(path) ? (await readFile(path, 'utf8')).split(/\r?\n/) : [];
  const pending = new Map(Object.entries(values));
  lines = lines.map((line) => {
    const key = line.match(/^([A-Z0-9_]+)=/)?.[1];
    if (key && pending.has(key)) {
      const value = pending.get(key)!;
      pending.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });
  for (const [key, value] of pending) lines.push(`${key}=${value}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.join('\n').trimEnd()}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function installHiveMemPlugin(home: string, files: Array<{ path: string; content: string }>): Promise<void> {
  const bytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
  if (bytes > MAX_PLUGIN_BYTES) throw new Error('HiveMem plugin payload exceeds size limit');
  const root = resolve(home, 'plugins', 'memory', 'hivemem');
  for (const file of files) {
    const destination = resolve(root, file.path);
    if (!destination.startsWith(`${root}/`)) throw new Error('Invalid HiveMem plugin path');
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.content, 'utf8');
  }
}
async function readMagnusState(home: string): Promise<{ routerBaseUrl?: string }> {
  const path = join(home, MAGNUS_STATE_FILE);
  if (!await exists(path)) return {};
  try {
    const state = JSON.parse(await readFile(path, 'utf8')) as { routerBaseUrl?: unknown };
    return typeof state.routerBaseUrl === 'string' ? { routerBaseUrl: state.routerBaseUrl } : {};
  } catch {
    return {};
  }
}

function cleanCell(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/…/g, '').trim();
}

function parseProfileListText(text: string, home: string): Array<Record<string, unknown>> {
  const profiles: Array<Record<string, unknown>> = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^(name|profiles?|[-=]+)/i.test(line) || /^[┌└├│\s─┬┴┼]+$/.test(line)) continue;
    const cells = line.startsWith('│')
      ? line.slice(1, -1).split('│').map(cleanCell)
      : cleanCell(line).split(/\s{2,}/);
    const nameCell = cells[0] ?? '';
    const name = nameCell.replace(/^[*◆◇•]\s*/, '').replace(/\s+\(default\)$/i, '').split(/\s+/)[0] ?? '';
    if (!name || name.includes(':') || !/^[A-Za-z0-9_.-]+$/.test(name)) continue;
    profiles.push({
      name,
      profileHome: join(home, 'profiles', name),
      isDefault: nameCell.startsWith('*') || nameCell.startsWith('◆') || /\bdefault\b/i.test(nameCell),
      gatewayStatus: cells[2] && !['-', '—'].includes(cells[2]) ? cells[2] : 'unknown',
      modelSummary: cells[1] && !['-', '—'].includes(cells[1]) ? cells[1] : null,
      distribution: cells[4] && !['-', '—'].includes(cells[4]) ? cells[4] : null,
      metadata: { source: 'hermes profile list' },
    });
  }
  return profiles;
}

function profileString(profile: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = profile[key];
    if (typeof value === 'string' && value.trim() && !['-', '—', 'unknown'].includes(value.trim().toLowerCase())) return value.trim();
  }
  return null;
}

function profileBoolean(profile: Record<string, unknown>, fallback: boolean, ...keys: string[]): boolean {
  for (const key of keys) {
    const value = profile[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (value.toLowerCase() === 'true') return true;
      if (value.toLowerCase() === 'false') return false;
    }
  }
  return fallback;
}

function profileNumber(profile: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = profile[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

/**
 * Hermes exposes gateway, API-server, and model routing at the installation
 * level. Profile-list output varies by Hermes release and often contains only
 * names, so carry the observed installation posture into every profile unless
 * that profile explicitly reported its own value.
 */
function enrichProfiles(
  profiles: Array<Record<string, unknown>>,
  installation: Pick<HermesNodeState, 'gatewayStatus' | 'apiServerEnabled' | 'apiServerHost' | 'apiServerPort' | 'configuration'>,
): Array<Record<string, unknown>> {
  return profiles.map((profile) => ({
    ...profile,
    gatewayStatus: profileString(profile, 'gatewayStatus', 'gateway_status') ?? installation.gatewayStatus,
    providerSummary: profileString(profile, 'providerSummary', 'provider_summary', 'provider') ?? installation.configuration.modelProvider,
    modelSummary: profileString(profile, 'modelSummary', 'model_summary', 'model') ?? installation.configuration.modelName,
    apiServerEnabled: profileBoolean(profile, installation.apiServerEnabled, 'apiServerEnabled', 'api_server_enabled'),
    apiServerHost: profileString(profile, 'apiServerHost', 'api_server_host') ?? installation.apiServerHost,
    apiServerPort: profileNumber(profile, 'apiServerPort', 'api_server_port') ?? installation.apiServerPort,
  }));
}

async function profilesFromHome(home: string): Promise<Array<Record<string, unknown>>> {
  const profilesDir = join(home, 'profiles');
  if (!await exists(profilesDir)) return [];
  try {
    const entries = await readdir(profilesDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^[A-Za-z0-9_.-]+$/.test(entry.name))
      .map((entry) => ({
        name: entry.name,
        profileHome: join(profilesDir, entry.name),
        isDefault: entry.name === 'default',
        gatewayStatus: 'unknown',
        metadata: { source: 'filesystem profiles' },
      }));
  } catch {
    return [];
  }
}

async function envKeys(path: string): Promise<string[]> {
  if (!await exists(path)) return [];
  try {
    return (await readFile(path, 'utf8'))
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z0-9_]+)=/)?.[1])
      .filter((key): key is string => Boolean(key))
      .sort();
  } catch {
    return [];
  }
}

async function apiServerConfiguration(path: string): Promise<{
  enabled: boolean;
  host: string;
  port: number | null;
}> {
  const fallback = { enabled: false, host: '127.0.0.1', port: null };
  if (!await exists(path)) return fallback;
  try {
    const values = new Map<string, string>();
    for (const line of (await readFile(path, 'utf8')).split(/\r?\n/)) {
      const match = line.match(/^(API_SERVER_ENABLED|API_SERVER_HOST|API_SERVER_PORT)=(.*)$/);
      const key = match?.[1];
      const value = match?.[2];
      if (key && value !== undefined) values.set(key, value.trim());
    }
    const configuredPort = values.get('API_SERVER_PORT');
    const port = configuredPort && /^\d+$/.test(configuredPort) ? Number(configuredPort) : null;
    return {
      enabled: values.get('API_SERVER_ENABLED')?.toLowerCase() === 'true',
      host: values.get('API_SERVER_HOST') || fallback.host,
      port: port && port > 0 && port <= 65_535 ? port : null,
    };
  } catch {
    return fallback;
  }
}


export async function configureHermes(
  options: { hermesHome: string; hermesBin: string },
  configuration: z.infer<typeof configurationSchema>,
): Promise<{ warnings: string[]; state: HermesNodeState }> {
  const { home } = target(options);
  await mkdir(home, { recursive: true });
  const configPath = join(home, 'config.yaml');
  const envPath = join(home, '.env');
  let yaml = await exists(configPath) ? await readFile(configPath, 'utf8') : '';
  const warnings: string[] = [];
  const magnusState = await readMagnusState(home);
  if (configuration.openaiRuntime) {
    yaml = updateYamlBlock(yaml, 'model', { openai_runtime: configuration.openaiRuntime });
  }
  if (configuration.router) {
    const modelValues: Record<string, string> = {
      provider: 'custom',
      default: JSON.stringify(configuration.router.model),
      base_url: JSON.stringify(configuration.router.baseUrl),
    };
    if (configuration.router.apiKey) {
      await updateEnvFile(envPath, { MAGNUS_ROUTER_API_KEY: configuration.router.apiKey });
      modelValues['api_key'] = '${MAGNUS_ROUTER_API_KEY}';
    }
    yaml = updateYamlBlock(yaml, 'model', modelValues);
    magnusState.routerBaseUrl = configuration.router.baseUrl;
  }
  if (configuration.hiveMem) {
    if (configuration.hiveMem.pluginFiles?.length) await installHiveMemPlugin(home, configuration.hiveMem.pluginFiles);
    const pluginInstalled = await exists(join(home, 'plugins', 'memory', 'hivemem', '__init__.py'));
    if (!pluginInstalled) {
      warnings.push('HiveMem plugin bundle not available on this node; memory.provider was not changed.');
    } else {
      yaml = updateYamlBlock(yaml, 'memory', { provider: 'hivemem' });
      await writeFile(join(home, 'hivemem.json'), `${JSON.stringify({
        api_url: configuration.hiveMem.apiUrl,
        workspace_id: configuration.hiveMem.workspaceId,
        default_scope: configuration.hiveMem.defaultScope,
        recall_mode: configuration.hiveMem.recallMode,
        capture_turns: true,
        max_recall_results: 5,
        context_tokens: 1200,
        enabled: true,
      }, null, 2)}\n`, 'utf8');
      if (configuration.hiveMem.token) {
        await updateEnvFile(envPath, {
          HERMES_HIVEMEM_API_URL: configuration.hiveMem.apiUrl,
          HERMES_HIVEMEM_TOKEN: configuration.hiveMem.token,
        });
      }
    }
  }
  await writeFile(configPath, yaml, 'utf8');
  await writeFile(join(home, MAGNUS_STATE_FILE), `${JSON.stringify(magnusState, null, 2)}\n`, 'utf8');
  return { warnings, state: await collectHermesState(options, true) };
}

let stateCache: { key: string; at: number; value: HermesNodeState } | null = null;

export async function collectHermesState(
  options: { hermesHome?: string; hermesBin?: string } = {},
  refresh = false,
): Promise<HermesNodeState> {
  const requested = { hermesHome: options.hermesHome ?? DEFAULT_HERMES_HOME, hermesBin: options.hermesBin ?? 'hermes' };
  const runtime = await discoverRuntimeTarget(requested);
  const resolved = runtime.resolved;
  const cacheKey = `${resolved.home}:${resolved.bin}`;
  if (!refresh && stateCache?.key === cacheKey && Date.now() - stateCache.at < 20_000) return stateCache.value;
  const configPath = join(resolved.home, 'config.yaml');
  const hiveConfigPath = join(resolved.home, 'hivemem.json');
  const envPath = join(resolved.home, '.env');
  const configPresent = await exists(configPath);
  const config = configPresent ? await readFile(configPath, 'utf8') : '';
  const versionResult = runtime.versionResult;
  const fallbackVersion = runtime.fallbackVersion;
  const homeProfiles = await profilesFromHome(resolved.home);
  const installed = versionResult.code === 0 || fallbackVersion?.code === 0 || runtime.homeDetected || configPresent || homeProfiles.length > 0;
  const version = installed ? firstLine(versionResult.stdout || fallbackVersion?.stdout || versionResult.stderr) : null;
  const gatewayResult = versionResult.code === 0 || fallbackVersion?.code === 0 ? await runHermes(runtime.requested, ['gateway', 'status']) : null;
  const profileListResult = versionResult.code === 0 || fallbackVersion?.code === 0 ? await runHermes(runtime.requested, ['profile', 'list', '--json'], 15_000) : null;
  let profiles: Array<Record<string, unknown>> = [];
  if (profileListResult?.code === 0 && profileListResult.stdout.trim()) {
    try {
      const parsed = JSON.parse(profileListResult.stdout);
      if (Array.isArray(parsed)) profiles = parsed.slice(0, 50).filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null);
    } catch { /* fall through with empty profiles */ }
  }
  if (profiles.length === 0 && (versionResult.code === 0 || fallbackVersion?.code === 0)) {
    const textResult = await runHermes(runtime.requested, ['profile', 'list'], 15_000);
    profiles = parseProfileListText(`${textResult.stdout}\n${textResult.stderr}`, resolved.home).slice(0, 50);
  }
  if (profiles.length === 0) profiles = homeProfiles.slice(0, 50);
  if (installed && profiles.length === 0) {
    profiles = [{
      name: 'default',
      profileHome: join(resolved.home, 'profiles', 'default'),
      isDefault: true,
      gatewayStatus: 'unknown',
      metadata: { source: 'implicit default profile' },
    }];
  }
  const gatewayText = `${gatewayResult?.stdout ?? ''}\n${gatewayResult?.stderr ?? ''}`.toLowerCase();
  const gatewayStatus: HermesServiceStatus = !installed
    ? 'not_installed'
    : /running|active|healthy/.test(gatewayText) ? 'running'
      : /failed|error/.test(gatewayText) ? 'failed'
        : /inactive|stopped|not running/.test(gatewayText) ? 'inactive' : 'unknown';
  const modelProvider = yamlBlockValue(config, 'model', 'provider');
  const modelName = yamlBlockValue(config, 'model', 'default');
  const modelBaseUrl = yamlBlockValue(config, 'model', 'base_url');
  const configuredOpenaiRuntime = yamlBlockValue(config, 'model', 'openai_runtime');
  const openaiRuntime = configuredOpenaiRuntime === 'auto' || configuredOpenaiRuntime === 'codex_app_server'
    ? configuredOpenaiRuntime
    : null;
  const memoryProvider = yamlBlockValue(config, 'memory', 'provider');
  const apiServer = await apiServerConfiguration(envPath);
  const magnusState = await readMagnusState(resolved.home);
  const hiveMemPluginInstalled = await exists(join(resolved.home, 'plugins', 'memory', 'hivemem', '__init__.py'))
    || await exists(join(resolved.home, 'plugins', 'hivemem', '__init__.py'));
  let hiveMemApiUrl: string | null = null;
  if (await exists(hiveConfigPath)) {
    try {
      const data = JSON.parse(await readFile(hiveConfigPath, 'utf8')) as { api_url?: unknown };
      hiveMemApiUrl = typeof data.api_url === 'string' ? data.api_url : null;
    } catch {}
  }
  if (!hiveMemApiUrl && await exists(envPath)) {
    const hiveEnv = await readFile(envPath, 'utf8');
    hiveMemApiUrl = hiveEnv.split(/\r?\n/).find((line) => line.startsWith('HERMES_HIVEMEM_API_URL='))
      ?.slice('HERMES_HIVEMEM_API_URL='.length).trim() ?? null;
  }
  const configuration: HermesNodeState['configuration'] = {
    configPresent,
    configPath: configPresent ? configPath : null,
    envPath: await exists(envPath) ? envPath : null,
    envKeys: await envKeys(envPath),
    modelProvider,
    modelName,
    modelBaseUrl,
    openaiRuntime,
    magnusRouterConfigured: modelProvider === 'custom' && Boolean(modelBaseUrl) && modelBaseUrl === magnusState.routerBaseUrl,
    memoryProvider,
    hiveMemConfigured: memoryProvider === 'hivemem' && hiveMemPluginInstalled,
    hiveMemPluginInstalled,
    hiveMemApiUrl,
    hiveMemToken: memoryProvider === 'hivemem' ? await inspectHiveMemToken(envPath, hiveMemApiUrl) : null,
    magnusSkills: {
      status: process.env['MAGNUS_SKILLS_DIR'] ? 'available' : 'not_configured',
      message: process.env['MAGNUS_SKILLS_DIR']
        ? 'Hermes Agent skills are published from magnus-skills and reconciled through magnus-agent.'
        : 'Set MAGNUS_SKILLS_DIR on this node to expose the magnus-skills catalogue to Hermes Agent profiles.',
    },
  };
  const canRunHermes = versionResult.code === 0 || fallbackVersion?.code === 0;
  const [skills, plugins] = canRunHermes
    ? await Promise.all([
        collectHermesSkills(runtime.requested).catch(() => []),
        collectHermesPlugins(runtime.requested).catch(() => []),
      ])
    : [[], []];
  const providers = providersFromConfiguration(config, configuration);
  profiles = enrichProfiles(profiles, {
    gatewayStatus,
    apiServerEnabled: apiServer.enabled,
    apiServerHost: apiServer.host,
    apiServerPort: apiServer.port,
    configuration,
  });
  const dashboard = await observeHermesDashboard(resolved.home);
  const state: HermesNodeState = {
    installed,
    status: !installed ? 'not_installed' : gatewayStatus === 'running' ? 'running' : configPresent ? 'detected' : 'needs_setup',
    installMode: installed ? 'official-script' : 'existing',
    version,
    hermesBin: requested.hermesBin,
    hermesHome: resolved.home,
    gatewayStatus,
    dashboardStatus: dashboard.status,
    ...(dashboard.status === 'running' && dashboard.host && dashboard.port
      ? { dashboardHost: dashboard.host, dashboardPort: dashboard.port } : {}),
    apiServerEnabled: apiServer.enabled,
    apiServerHost: apiServer.host,
    apiServerPort: apiServer.port,
    profiles,
    skills,
    toolsets: [],
    providers,
    plugins,
    configuration,
    rawChecks: {
      configPresent,
      dashboardObservation: { source: dashboard.source, reason: dashboard.reason },
      gatewayExitCode: gatewayResult?.code ?? null,
      hiveMemPluginInstalled,
      magnusRouterManaged: Boolean(magnusState.routerBaseUrl),
      detectedHome: resolved.home,
      detectedBin: resolved.bin,
      binaryDetected: versionResult.code === 0 || fallbackVersion?.code === 0,
    },
  };
  stateCache = { key: cacheKey, at: Date.now(), value: state };
  return state;
}

function errorResponse(c: Context, err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ success: false, error: { code: 'HERMES_OPERATION_FAILED', message: redact(message) } }, 500);
}

hermesRoutes.get('/state', async (c) => {
  const parsed = targetSchema.safeParse({ hermesHome: c.req.query('hermesHome') ?? DEFAULT_HERMES_HOME, hermesBin: c.req.query('hermesBin') ?? 'hermes' });
  if (!parsed.success) return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  try {
    return c.json({ success: true, data: await collectHermesState(parsed.data, true) });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/configure', async (c) => {
  const parsed = targetSchema.extend({ configuration: configurationSchema }).safeParse(await c.req.json());
  if (!parsed.success) return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  try {
    return c.json({ success: true, data: await configureHermes(parsed.data, parsed.data.configuration) });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/install', async (c) => {
  const parsed = installSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  try {
    const { home } = target(parsed.data);
    const args = parsed.data.skipBrowser ? ['--skip-browser'] : [];
    const result = await run('/bin/bash', ['-c', `curl -fsSL ${OFFICIAL_INSTALL_SCRIPT} | bash -s -- "$@"`, 'hermes-agent-install', ...args], { env: { HERMES_HOME: home }, timeoutMs: 20 * 60_000 });
    if (result.code !== 0) throw new Error(redact(result.stderr || result.stdout || 'Official Hermes installer failed'));
    const configured = parsed.data.configuration
      ? await configureHermes(parsed.data, parsed.data.configuration)
      : { warnings: [], state: await collectHermesState(parsed.data, true) };
    return c.json({ success: true, data: { state: configured.state, warnings: configured.warnings, output: redact(result.stdout.slice(-4000)) } });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/update', async (c) => {
  const parsed = updateSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  try {
    const args = ['update'];
    if (parsed.data.checkOnly) args.push('--check');
    else if (parsed.data.backup) args.push('--backup');
    const result = await runHermes(parsed.data, args, 20 * 60_000);
    if (result.code !== 0) throw new Error(redact(result.stderr || result.stdout || 'Hermes update failed'));
    const configured = !parsed.data.checkOnly && parsed.data.configuration
      ? await configureHermes(parsed.data, parsed.data.configuration)
      : { warnings: [], state: await collectHermesState(parsed.data, true) };
    return c.json({ success: true, data: { state: configured.state, warnings: configured.warnings, output: redact(result.stdout.slice(-4000)) } });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/uninstall', async (c) => {
  const parsed = uninstallSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
  try {
    await runHermes(parsed.data, ['gateway', 'stop'], 30_000);
    const args = parsed.data.keepConfiguration ? ['uninstall', '--yes'] : ['uninstall', '--full', '--yes'];
    const result = await runHermes(parsed.data, args, 5 * 60_000);
    if (result.code !== 0) throw new Error(redact(result.stderr || result.stdout || 'Hermes uninstall failed'));
    return c.json({ success: true, data: { state: await collectHermesState(parsed.data, true), output: redact(result.stdout.slice(-4000)) } });
  } catch (err) { return errorResponse(c, err); }
});

// ── Reconciler endpoints (Magnus → Hermes CLI) ────────────────────────────
// Each endpoint accepts a desired-state payload and invokes the local `hermes`
// CLI as a thin reconciler. Output is redacted before returning.

const profileScope = z.object({ profile: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_.\-]+$/).optional() });
const skillsSyncSchema = targetSchema.merge(profileScope).extend({
  skills: z.array(z.object({
    slug: z.string().min(1).max(120).regex(/^[a-zA-Z0-9_.\-/@]+$/),
    pinnedVersion: z.string().min(1).max(40).regex(/^[a-zA-Z0-9_.\-]+$/).nullable().optional(),
    enabled: z.boolean().default(true),
  })).max(200),
});
const toolsetApplySchema = targetSchema.merge(profileScope).extend({
  toolset: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_.\-]+$/),
  enabled: z.boolean().default(true),
  approvalMode: z.enum(['auto', 'confirm', 'block']).default('auto'),
  allowList: z.array(safeValue).max(200).default([]),
  denyList: z.array(safeValue).max(200).default([]),
});
const providerApplySchema = targetSchema.merge(profileScope).extend({
  chain: z.array(safeValue).max(40).default([]),
  sortStrategy: z.enum(['priority', 'latency', 'cost', 'manual']).default('priority'),
  whitelist: z.array(safeValue).max(80).default([]),
  blacklist: z.array(safeValue).max(80).default([]),
  visionOverride: z.string().min(1).max(120).nullable().optional(),
  compressionOverride: z.string().min(1).max(120).nullable().optional(),
});
const providerTestSchema = targetSchema.merge(profileScope).extend({
  provider: safeValue,
  prompt: z.string().min(1).max(2000).default('ping'),
});
const credentialPoolApplySchema = targetSchema.merge(profileScope).extend({
  poolName: safeValue,
  provider: safeValue,
  keys: z.array(safeValue).min(1).max(50),
  detach: z.boolean().default(false),
});
const mcpApplySchema = targetSchema.merge(profileScope).extend({
  name: safeValue,
  transport: z.enum(['stdio', 'http', 'sse']).default('stdio'),
  command: z.string().min(1).max(500).optional(),
  url: safeUrl.optional(),
  detach: z.boolean().default(false),
});
const messagingApplySchema = targetSchema.merge(profileScope).extend({
  platform: z.enum(['slack', 'discord', 'matrix', 'webhook']),
  channel: z.string().min(1).max(200),
  detach: z.boolean().default(false),
});
const cronApplySchema = targetSchema.merge(profileScope).extend({
  name: z.string().min(1).max(120).regex(/^[a-zA-Z0-9_.\-]+$/),
  cronExpr: z.string().min(1).max(120),
  prompt: z.string().min(1).max(4000),
  enabled: z.boolean().default(true),
  remove: z.boolean().default(false),
});
const pluginInstallSchema = targetSchema.extend({
  pluginSlug: z.string().min(1).max(120).regex(/^[a-zA-Z0-9_.\-/@]+$/),
  pinnedVersion: z.string().min(1).max(40).regex(/^[a-zA-Z0-9_.\-]+$/).nullable().optional(),
});
const pluginUninstallSchema = targetSchema.extend({
  pluginSlug: z.string().min(1).max(120).regex(/^[a-zA-Z0-9_.\-/@]+$/),
});
const roleApplySchema = targetSchema.merge(profileScope).extend({
  roleName: z.string().min(1).max(120).regex(/^[a-zA-Z0-9_.\-]+$/),
});

function profileArgs(profile: string | undefined): string[] {
  return profile ? ['--profile', profile] : [];
}

async function runReconcile(
  parsed: { hermesHome: string; hermesBin: string },
  args: string[],
  timeoutMs = 5 * 60_000,
): Promise<{ output: string }> {
  const result = await runHermes(parsed, args, timeoutMs);
  if (result.code !== 0) {
    throw new Error(redact(result.stderr || result.stdout || `hermes ${args[0] ?? ''} failed`));
  }
  return { output: redact(result.stdout.slice(-4000)) };
}

function validationError(c: Context, err: z.ZodError): Response {
  return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } }, 400);
}

hermesRoutes.post('/skills/sync', async (c) => {
  const parsed = skillsSyncSchema.safeParse(await c.req.json());
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const outputs: string[] = [];
    for (const skill of parsed.data.skills) {
      const sub = skill.enabled ? 'install' : 'remove';
      const ref = skill.pinnedVersion ? `${skill.slug}@${skill.pinnedVersion}` : skill.slug;
      const result = await runReconcile(parsed.data, ['skill', sub, ...profileArgs(parsed.data.profile), ref]);
      outputs.push(`${sub} ${ref}: ${result.output}`);
    }
    return c.json({ success: true, data: { output: outputs.join('\n---\n').slice(-4000) } });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/toolsets/apply', async (c) => {
  const parsed = toolsetApplySchema.safeParse(await c.req.json());
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const args = ['tools', parsed.data.enabled ? 'enable' : 'disable', ...profileArgs(parsed.data.profile), parsed.data.toolset];
    const out = await runReconcile(parsed.data, args);
    return c.json({ success: true, data: out });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/providers/apply', async (c) => {
  const parsed = providerApplySchema.safeParse(await c.req.json());
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const payload = JSON.stringify({
      chain: parsed.data.chain,
      sort: parsed.data.sortStrategy,
      whitelist: parsed.data.whitelist,
      blacklist: parsed.data.blacklist,
      visionOverride: parsed.data.visionOverride ?? null,
      compressionOverride: parsed.data.compressionOverride ?? null,
    });
    const args = ['providers', 'configure', ...profileArgs(parsed.data.profile), '--from-stdin'];
    const result = await runHermes(parsed.data, args, 60_000, payload);
    if (result.code !== 0) throw new Error(redact(result.stderr || result.stdout || 'providers configure failed'));
    return c.json({ success: true, data: { output: redact(result.stdout.slice(-4000)) } });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/providers/test', async (c) => {
  const parsed = providerTestSchema.safeParse(await c.req.json());
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const args = ['providers', 'test', ...profileArgs(parsed.data.profile), parsed.data.provider, '--prompt', parsed.data.prompt];
    const out = await runReconcile(parsed.data, args, 120_000);
    return c.json({ success: true, data: out });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/credential-pools/apply', async (c) => {
  const parsed = credentialPoolApplySchema.safeParse(await c.req.json());
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const action = parsed.data.detach ? 'detach' : 'attach';
    const payload = JSON.stringify({ provider: parsed.data.provider, keys: parsed.data.keys });
    const args = ['credentials', action, ...profileArgs(parsed.data.profile), parsed.data.poolName, '--from-stdin'];
    const result = await runHermes(parsed.data, args, 60_000, payload);
    if (result.code !== 0) throw new Error(redact(result.stderr || result.stdout || 'credentials apply failed'));
    return c.json({ success: true, data: { output: redact(result.stdout.slice(-4000)) } });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/mcp/apply', async (c) => {
  const parsed = mcpApplySchema.safeParse(await c.req.json());
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    if (parsed.data.detach) {
      const out = await runReconcile(parsed.data, ['mcp', 'remove', ...profileArgs(parsed.data.profile), parsed.data.name]);
      return c.json({ success: true, data: out });
    }
    const args = ['mcp', 'add', ...profileArgs(parsed.data.profile), parsed.data.name, '--transport', parsed.data.transport];
    if (parsed.data.command) args.push('--command', parsed.data.command);
    if (parsed.data.url) args.push('--url', parsed.data.url);
    const out = await runReconcile(parsed.data, args);
    return c.json({ success: true, data: out });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/messaging/apply', async (c) => {
  const parsed = messagingApplySchema.safeParse(await c.req.json());
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const action = parsed.data.detach ? 'remove' : 'add';
    const out = await runReconcile(parsed.data, ['messaging', action, ...profileArgs(parsed.data.profile), parsed.data.platform, '--channel', parsed.data.channel]);
    return c.json({ success: true, data: out });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/cron/apply', async (c) => {
  const parsed = cronApplySchema.safeParse(await c.req.json());
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    if (parsed.data.remove) {
      const out = await runReconcile(parsed.data, ['cron', 'remove', ...profileArgs(parsed.data.profile), parsed.data.name]);
      return c.json({ success: true, data: out });
    }
    const args = [
      'cron', 'add', ...profileArgs(parsed.data.profile),
      parsed.data.name, '--schedule', parsed.data.cronExpr,
    ];
    if (!parsed.data.enabled) args.push('--paused');
    const result = await runHermes(parsed.data, args, 60_000, parsed.data.prompt);
    if (result.code !== 0) throw new Error(redact(result.stderr || result.stdout || 'cron apply failed'));
    return c.json({ success: true, data: { output: redact(result.stdout.slice(-4000)) } });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/plugins/install', async (c) => {
  const parsed = pluginInstallSchema.safeParse(await c.req.json());
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const ref = parsed.data.pinnedVersion ? `${parsed.data.pluginSlug}@${parsed.data.pinnedVersion}` : parsed.data.pluginSlug;
    const out = await runReconcile(parsed.data, ['plugins', 'install', ref]);
    return c.json({ success: true, data: out });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/plugins/uninstall', async (c) => {
  const parsed = pluginUninstallSchema.safeParse(await c.req.json());
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const out = await runReconcile(parsed.data, ['plugins', 'uninstall', parsed.data.pluginSlug]);
    return c.json({ success: true, data: out });
  } catch (err) { return errorResponse(c, err); }
});

hermesRoutes.post('/role/apply', async (c) => {
  const parsed = roleApplySchema.safeParse(await c.req.json());
  if (!parsed.success) return validationError(c, parsed.error);
  try {
    const out = await runReconcile(parsed.data, ['role', 'apply', ...profileArgs(parsed.data.profile), parsed.data.roleName]);
    return c.json({ success: true, data: out });
  } catch (err) { return errorResponse(c, err); }
});
