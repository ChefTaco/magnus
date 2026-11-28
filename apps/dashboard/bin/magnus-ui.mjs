#!/usr/bin/env node
/**
 * magnus-ui — run the prebuilt Magnus UI (Next.js standalone server).
 *
 *   magnus-ui [start] [--env-file FILE] [--port N] [--host ADDR] [--data-dir DIR]
 *   magnus-ui check [--env-file FILE] [--data-dir DIR]
 *   magnus-ui credentials [--reencrypt] [--env-file FILE] [--data-dir DIR]
 *   magnus-ui env-schema [--json]
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));

const USAGE = `Usage: magnus-ui [command] [options]

Commands:
  start         Start the Magnus UI server (default)
  check         Validate the configuration and list enabled integrations
  credentials   Count stored control-node credentials by key in
                DIR/.magnus/control-nodes.json: exit 0 when all are under
                CONTROL_NODE_CREDENTIAL_KEY, 1 while any are unencrypted or under
                the legacy JWT_SECRET-derived key, which this release no longer
                reads (or on an error), 3 when there is no state file there. With
                --reencrypt, encrypt unencrypted ones. Run it as the account the
                console runs as.
  env-schema    Print every supported environment variable (--json for JSON)

Options:
  --env-file FILE   Load environment variables from FILE (existing variables win)
  --port N          Listen port (PORT, default 3000)
  --host ADDR       Listen address (HOST, default 0.0.0.0)
  --data-dir DIR    Runtime state directory (MAGNUS_UI_DATA_DIR, default: current directory)
  --reencrypt       credentials: encrypt unencrypted values (backs up the file first)
  -h, --help        Show this help
  -v, --version     Print the version`;

/** Parse argv into a command, options and flags. */
export function parseArgs(argv) {
  const options = {};
  const flags = new Set();
  let command;
  const takesValue = new Set(['--env-file', '--port', '--host', '--data-dir']);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const [name, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (takesValue.has(name)) {
      const value = inline ?? argv[++index];
      if (value === undefined || value === '') throw new Error(`${name} requires a value`);
      options[name.slice(2)] = value;
    } else if (name.startsWith('-')) {
      flags.add(name);
    } else if (!command) {
      command = name;
    } else {
      throw new Error(`Unexpected argument: ${name}`);
    }
  }
  return { command: command ?? 'start', options, flags };
}

/**
 * Build the runtime environment: process env wins over the env file.
 * @param {Record<string, string>} options
 * @param {Record<string, string | undefined>} [baseEnv]
 * @returns {Record<string, string>}
 */
export function buildEnvironment(options, baseEnv = process.env) {
  const env = {};
  if (options['env-file']) {
    const path = resolve(options['env-file']);
    if (!existsSync(path)) throw new Error(`Env file not found: ${path}`);
    Object.assign(env, parseEnv(readFileSync(path, 'utf8')));
  }
  for (const [key, value] of Object.entries(baseEnv)) if (value !== undefined) env[key] = value;
  if (options.port) env.PORT = options.port;
  if (options.host) env.HOST = options.host;
  if (options['data-dir']) env.MAGNUS_UI_DATA_DIR = options['data-dir'];
  return env;
}

/** Directory holding the standalone server and the runtime-*.mjs helpers. */
function serverDir() {
  for (const candidate of [join(packageRoot, 'dist/app/apps/dashboard'), join(packageRoot, 'dist/app')]) {
    if (existsSync(join(candidate, 'server-tls.mjs')) && existsSync(join(candidate, 'server.js'))) return candidate;
  }
  return null;
}

/** Runtime helper modules: the staged copy when installed, the source tree otherwise. */
async function runtimeModule(name) {
  const dir = serverDir() ?? packageRoot;
  return import(pathToFileURL(join(dir, name)).href);
}

function present(env, name) {
  return typeof env[name] === 'string' && env[name].trim() !== '';
}

/**
 * Validate configuration.
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<{ errors: string[]; warnings: string[] }>}
 */
export async function checkEnvironment(env) {
  const errors = [];
  const warnings = [];
  const { validateDashboardEnvironment } = await runtimeModule('runtime-environment.mjs');
  const { resolveSessionSecret } = await runtimeModule('runtime-session-secret.mjs');
  const { resolveDashboardLoginCredentials } = await runtimeModule('runtime-dashboard-credentials.mjs');
  for (const name of ['CONTROL_API_URL', 'API_SECRET', 'REDIS_URL']) {
    if (!present(env, name)) errors.push(`${name} is required`);
  }
  const attempt = (fn) => { try { fn(); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); } };
  attempt(() => validateDashboardEnvironment(env));
  attempt(() => resolveSessionSecret(env));
  attempt(() => resolveDashboardLoginCredentials(env));
  if (!present(env, 'DASHBOARD_SSH_USERNAME') || !(present(env, 'DASHBOARD_SSH_PRIVATE_KEY_PATH') || present(env, 'DASHBOARD_SSH_PASSWORD'))) {
    warnings.push('DASHBOARD_SSH_USERNAME with DASHBOARD_SSH_PRIVATE_KEY_PATH (or DASHBOARD_SSH_PASSWORD) is not set; the node terminal and Hermes proxy are unavailable');
  }
  // Named users' API calls carry their own token, which only the server's Oathweave mode verifies.
  if (present(env, 'HIVE_OAUTH_API_AUDIENCE') && env.HIVE_OAUTH_API_AUDIENCE.trim() !== 'magnus') {
    warnings.push(`HIVE_OAUTH_API_AUDIENCE is "${env.HIVE_OAUTH_API_AUDIENCE.trim()}": named users' API calls carry their own access token, `
      + 'which the Control API verifies only in Oathweave mode, for the audience "magnus" (the external IAM mode was removed in 4.0.0)');
  }
  const cert = env.TLS_CERT_PATH?.trim();
  const key = env.TLS_KEY_PATH?.trim();
  if (cert || key) {
    if (!cert || !key) errors.push('TLS_CERT_PATH and TLS_KEY_PATH must be configured together');
    for (const [name, path] of [['TLS_CERT_PATH', cert], ['TLS_KEY_PATH', key]]) {
      if (path && !existsSync(path)) errors.push(`${name} does not exist: ${path}`);
    }
  } else if (String(env.MAGNUS_UI_ALLOW_HTTP ?? '').trim().toLowerCase() === 'true') {
    warnings.push('No TLS certificate configured; serving plain HTTP (MAGNUS_UI_ALLOW_HTTP=true)');
  } else {
    errors.push('TLS_CERT_PATH and TLS_KEY_PATH are required (or set MAGNUS_UI_ALLOW_HTTP=true for plain HTTP)');
  }
  return { errors: [...new Set(errors)], warnings };
}

async function printIntegrations(env) {
  const { describeIntegrations } = await runtimeModule('runtime-integrations.mjs');
  console.log('Integrations:');
  for (const row of describeIntegrations(env)) {
    console.log(`  ${row.enabled ? '[on] ' : '[off]'} ${row.name.padEnd(24)} ${row.enabled ? '' : `(set ${row.via})`}`);
  }
}

function dataDirectory(env) {
  return resolve(env.MAGNUS_UI_DATA_DIR?.trim() || process.cwd());
}

/**
 * Problems with the stored control-node credentials in the data directory. Values under the legacy
 * JWT_SECRET-derived key are errors: the console refuses to start while any remain.
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<{ errors: string[]; warnings: string[] }>}
 */
export async function credentialStorageProblems(env) {
  const { controlNodeStateFile, credentialsNeedReencryption, describeCredentialCounts, inspectControlNodeCredentials } = await runtimeModule('runtime-control-node-credentials.mjs');
  try {
    const file = controlNodeStateFile(dataDirectory(env));
    const counts = inspectControlNodeCredentials(file);
    if (!credentialsNeedReencryption(counts)) return { errors: [], warnings: [] };
    if (counts.legacy) {
      return { errors: [`${describeCredentialCounts(counts, file)}; this release cannot read legacy values, so the console refuses to start (see UPGRADING.md, 4.0.0)`], warnings: [] };
    }
    return { errors: [], warnings: [`${describeCredentialCounts(counts, file)}; the console encrypts them when it starts, or run \`magnus-ui credentials --reencrypt\``] };
  } catch (error) {
    return { errors: [], warnings: [`control-node credentials could not be inspected: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

/**
 * Run as root, become the account that owns the control-node state before rewriting it, so nothing
 * root writes there can be redirected by that account or end up unreadable by the console.
 * @param {{ uid: number, gid: number } | null} owner
 * @param {Pick<NodeJS.Process, 'geteuid' | 'setgid' | 'setuid' | 'setgroups'>} [proc]
 * @returns {boolean} whether the privileges were dropped
 */
export function dropPrivilegesToOwner(owner, proc = process) {
  if (!owner || typeof proc.geteuid !== 'function' || proc.geteuid() !== 0 || owner.uid === 0) return false;
  proc.setgroups?.([owner.gid]);
  proc.setgid(owner.gid);
  proc.setuid(owner.uid);
  return true;
}

/** Exit code of `magnus-ui credentials` when the data directory holds no control-node state. */
export const CREDENTIALS_NO_STATE_EXIT = 3;

/**
 * `magnus-ui credentials [--reencrypt]`: 0 when every stored value is under
 * CONTROL_NODE_CREDENTIAL_KEY, 1 while one is not or on an error, CREDENTIALS_NO_STATE_EXIT when there is no state file (a
 * wrong --data-dir must not read as all clear).
 * @param {Record<string, string | undefined>} env
 * @param {Set<string>} flags
 */
export async function commandCredentials(env, flags) {
  const credentials = await runtimeModule('runtime-control-node-credentials.mjs');
  const file = credentials.controlNodeStateFile(dataDirectory(env));
  try {
    if (flags.has('--reencrypt')) {
      if (dropPrivilegesToOwner(credentials.controlNodeStateOwner(file))) {
        console.log(`magnus-ui: running as uid ${process.getuid?.()}, the owner of ${file}`);
      }
      const message = credentials.describeReencryption(credentials.reencryptLegacyControlNodeCredentials(file, env));
      console.log(message ?? 'control-node credentials: nothing to encrypt');
    }
    const counts = credentials.inspectControlNodeCredentials(file);
    console.log(credentials.describeCredentialCounts(counts, file));
    if (!counts.present) return CREDENTIALS_NO_STATE_EXIT;
    if (!credentials.credentialsNeedReencryption(counts)) return 0;
    console.error(counts.legacy
      ? 'This release cannot read values under the legacy key: re-encrypt them with the last 3.x console (start it once, or `magnus-ui credentials --reencrypt`), or re-add those control nodes.'
      : 'Run `magnus-ui credentials --reencrypt` (or restart the console) to encrypt them under CONTROL_NODE_CREDENTIAL_KEY.');
    return 1;
  } catch (error) {
    console.error(`magnus-ui: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function commandCheck(env) {
  const { errors, warnings } = await checkEnvironment(env);
  const stored = await credentialStorageProblems(env);
  errors.push(...stored.errors);
  warnings.push(...stored.warnings);
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  await printIntegrations(env);
  if (errors.length) {
    console.error('\nConfiguration errors:');
    for (const error of errors) console.error(`  - ${error}`);
    return 1;
  }
  console.log('\nConfiguration OK.');
  return 0;
}

async function commandEnvSchema(flags) {
  const { dashboardEnvironmentReferenceRows } = await runtimeModule('runtime-environment.mjs');
  const rows = dashboardEnvironmentReferenceRows();
  if (flags.has('--json')) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  for (const row of rows) {
    const requirement = row.requirement ?? (row.required ? 'Required' : row.default !== undefined ? `Default: ${row.default}` : 'Optional');
    console.log(`${row.name}\n  ${row.purpose}\n  ${requirement}${row.sensitive ? ' (sensitive)' : ''}`);
  }
  return 0;
}

async function commandStart(env) {
  const dir = serverDir();
  if (!dir) {
    console.error('magnus-ui: the prebuilt server is missing. From a source checkout run `npm run build && npm run stage`.');
    return 1;
  }
  const { errors, warnings } = await checkEnvironment(env);
  for (const warning of warnings) console.warn(`magnus-ui: warning: ${warning}`);
  if (errors.length) {
    console.error('magnus-ui: configuration errors (run `magnus-ui check` for details):');
    for (const error of errors) console.error(`  - ${error}`);
    return 1;
  }
  const dataDir = dataDirectory(env);
  const childEnv = {
    ...env,
    NODE_ENV: 'production',
    MAGNUS_UI_DATA_DIR: dataDir,
    PORT: env.PORT?.trim() || '3000',
    // Next.js reads HOSTNAME, which shells often export as the machine name.
    HOSTNAME: env.HOST?.trim() || '0.0.0.0',
  };
  const child = spawn(process.execPath, [join(dir, 'server-tls.mjs')], { cwd: dataDir, env: childEnv, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  return new Promise((resolveExit) => {
    child.on('exit', (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
    child.on('error', (error) => { console.error(`magnus-ui: ${error.message}`); resolveExit(1); });
  });
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(`magnus-ui: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  const { command, options, flags } = parsed;
  if (flags.has('-h') || flags.has('--help') || command === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (flags.has('-v') || flags.has('--version')) {
    console.log(pkg.version);
    return 0;
  }
  if (command === 'env-schema') return commandEnvSchema(flags);
  let env;
  try {
    env = buildEnvironment(options);
  } catch (error) {
    console.error(`magnus-ui: ${error.message}`);
    return 2;
  }
  if (command === 'check') return commandCheck(env);
  if (command === 'credentials') return commandCredentials(env, flags);
  if (command === 'start') return commandStart(env);
  console.error(`magnus-ui: unknown command "${command}"\n\n${USAGE}`);
  return 2;
}

// npm links the bin through node_modules/.bin, so compare real paths.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
