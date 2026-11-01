/**
 * Commands of `magnus`: install, upgrade and roll back a Magnus server and console.
 *
 *   npx @hivemagnus/magnus init                  create and start a project in ~/.magnus
 *   magnus upgrade [--to X.Y.Z] [--dry-run]      upgrade it (never across a major by itself)
 *   magnus rollback [--restore-db]               switch back to the previous version
 *   magnus status                                versions, health and available updates
 *   magnus adopt --server-env-file FILE          take over an existing npm install
 */
import { adopt } from './adopt.js';
import { init, defaultProjectDir } from './init.js';
import type { Io } from './io.js';
import { findProjectDir, type Supervisor } from './project.js';
import { ownPackage } from './release.js';
import { rollback } from './rollback.js';
import { status } from './status.js';
import { upgrade } from './upgrade.js';

export const USAGE = `Usage: magnus <command> [options]

Commands:
  init        Create a managed project, install the pinned release and start it
  upgrade     Upgrade the project (same major version unless --allow-major)
  rollback    Switch back to the version that served before the last upgrade
  status      Show installed and serving versions, history and available updates
  adopt       Turn an existing npm install into a managed project
  version     Print this tool's version

Common options:
  --dir DIR             Project directory (default ~/.magnus, or /opt/magnus with --system)
  --registry URL        npm registry (default MAGNUS_UPDATE_REGISTRY or https://registry.npmjs.org)
  --source DIR          Install from packed tarballs in DIR instead of the registry
  --health-timeout SEC  How long to wait for the new version to become healthy (default 180)
  --yes                 Confirm slow or one-way migrations and restores without asking

init:
  --version X.Y.Z       Release to install (default: newest of this major)
  --system              System units (root) instead of user units; needs --service-user
  --service-user NAME   Account the system services run as
  --supervisor KIND     systemd (default) or none (you start the processes yourself)
  --database-url URL    Existing PostgreSQL (with --redis-url); otherwise PostgreSQL and
  --redis-url URL       Redis run on loopback through docker compose
  --postgres-port N     Loopback port for the bundled PostgreSQL (default 5432)
  --redis-port N        Loopback port for the bundled Redis (default 6379)
  --server-port N       Server port (default 4000)
  --ui-port N           Console port (default 3000)
  --public-host NAME    Host name for URLs and the certificate (default: this host's name)
  --admin-user NAME     Console administrator (default admin)
  --admin-password PW   Console password (default: generated and printed once)
  --tls-cert FILE       Certificate and key (default: a self-signed certificate)
  --tls-key FILE
  --no-ui               Install only the server
  --no-start            Install and configure, but do not start
  --no-auto-migrate     Write MAGNUS_AUTO_MIGRATE=false (default true for init projects)

upgrade:
  --to X.Y.Z            Target release (default: newest of the current major)
  --dry-run             Show what would happen and check prerequisites; change nothing
  --allow-major         Permit crossing a major version
  --generate-secrets    Generate values for new required secret settings

rollback:
  --restore-db          Also restore the pre-upgrade database dump (data written since is lost)

status:
  --json                Machine-readable output
  --offline             Skip the registry check

adopt:
  --server-env-file F   The env file your magnus-server runs with (required)
  --ui-env-file F       The env file your magnus-ui runs with
  --version X.Y.Z       Installed version (default: magnus-server --version)
  --install-units       Install and enable the new units (otherwise only print the steps)
`;

export class ArgsError extends Error {}

interface Parsed {
  command: string;
  values: Map<string, string>;
  flags: Set<string>;
}

const VALUE_OPTIONS = new Set(['--dir', '--registry', '--source', '--health-timeout', '--version', '--service-user', '--supervisor',
  '--database-url', '--redis-url', '--postgres-port', '--redis-port', '--server-port', '--ui-port', '--public-host', '--admin-user',
  '--admin-password', '--tls-cert', '--tls-key', '--to', '--server-env-file', '--ui-env-file']);
const FLAG_OPTIONS = new Set(['--yes', '--system', '--no-ui', '--no-start', '--no-auto-migrate', '--dry-run', '--allow-major',
  '--generate-secrets', '--resume', '--restore-db', '--json', '--offline', '--install-units', '--help', '-h']);
const COMMANDS = new Set(['init', 'upgrade', 'rollback', 'status', 'adopt', 'version', 'help']);

export function parseArgs(argv: readonly string[]): Parsed {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  let command: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const [name, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (name === '-v' || (name === '--version' && !command)) { command ??= 'version'; continue; }
    if (VALUE_OPTIONS.has(name)) {
      const value = inline ?? argv[++index];
      if (value === undefined || value === '' || (inline === undefined && value.startsWith('--'))) throw new ArgsError(`${name} needs a value`);
      values.set(name, value);
    } else if (FLAG_OPTIONS.has(name)) {
      flags.add(name === '-h' ? '--help' : name);
    } else if (name.startsWith('-')) {
      throw new ArgsError(`unknown option ${name}`);
    } else if (!command && COMMANDS.has(name)) {
      command = name;
    } else {
      throw new ArgsError(`unexpected argument ${name}`);
    }
  }
  if (flags.has('--help')) command = 'help';
  return { command: command ?? 'help', values, flags };
}

function port(values: Map<string, string>, name: string, fallback: number): number {
  const raw = values.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new ArgsError(`${name} must be a port number`);
  return value;
}

function supervisor(values: Map<string, string>): Supervisor {
  const value = values.get('--supervisor') ?? 'systemd';
  if (value === 'compose') throw new ArgsError('container installs upgrade with `docker compose pull && docker compose up -d` (docker/compose.yml; see UPGRADING.md), not with magnus');
  if (value !== 'systemd' && value !== 'none') throw new ArgsError('--supervisor must be systemd or none');
  return value;
}

/** --dir, else MAGNUS_PROJECT_DIR, else a project above the working directory, else the default location. */
function projectDir(io: Io, values: Map<string, string>, system: boolean): string {
  return values.get('--dir') ?? io.env['MAGNUS_PROJECT_DIR'] ?? findProjectDir(process.cwd()) ?? defaultProjectDir(io, system);
}

export async function run(io: Io, argv: readonly string[]): Promise<number> {
  const { command, values, flags } = parseArgs(argv);
  const registry = values.get('--registry') ?? io.env['MAGNUS_UPDATE_REGISTRY'] ?? 'https://registry.npmjs.org';
  const healthTimeoutMs = Number(values.get('--health-timeout') ?? '180') * 1000;
  if (!Number.isFinite(healthTimeoutMs) || healthTimeoutMs <= 0) throw new ArgsError('--health-timeout must be a number of seconds');
  const source = values.get('--source');
  const yes = flags.has('--yes');
  switch (command) {
    case 'help':
      io.log(USAGE);
      return 0;
    case 'version':
      io.log(ownPackage().version);
      return 0;
    case 'init':
      return init(io, {
        dir: values.get('--dir'), system: flags.has('--system'), serviceUser: values.get('--service-user'), supervisor: supervisor(values),
        version: values.get('--version'), source, registry, databaseUrl: values.get('--database-url'), redisUrl: values.get('--redis-url'),
        serverPort: port(values, '--server-port', 4000), uiPort: port(values, '--ui-port', 3000),
        postgresPort: port(values, '--postgres-port', 5432), redisPort: port(values, '--redis-port', 6379),
        publicHost: values.get('--public-host'), adminUser: values.get('--admin-user') ?? 'admin', adminPassword: values.get('--admin-password'),
        tlsCert: values.get('--tls-cert'), tlsKey: values.get('--tls-key'), ui: !flags.has('--no-ui'), start: !flags.has('--no-start'),
        autoMigrate: !flags.has('--no-auto-migrate'), healthTimeoutMs,
      });
    case 'upgrade':
      return upgrade(io, {
        dir: projectDir(io, values, false), to: values.get('--to'), dryRun: flags.has('--dry-run'), allowMajor: flags.has('--allow-major'),
        yes, generateSecrets: flags.has('--generate-secrets'), source, registry, healthTimeoutMs, resume: flags.has('--resume'),
      });
    case 'rollback':
      return rollback(io, { dir: projectDir(io, values, false), restoreDb: flags.has('--restore-db'), yes, healthTimeoutMs });
    case 'status':
      return status(io, { dir: projectDir(io, values, false), json: flags.has('--json'), offline: flags.has('--offline'), registry });
    case 'adopt': {
      const serverEnvFile = values.get('--server-env-file');
      if (!serverEnvFile) throw new ArgsError('adopt needs --server-env-file');
      return adopt(io, {
        dir: values.get('--dir'), serverEnvFile, uiEnvFile: values.get('--ui-env-file'), version: values.get('--version'),
        system: flags.has('--system'), serviceUser: values.get('--service-user'), supervisor: supervisor(values),
        installUnits: flags.has('--install-units'), source, registry,
      });
    }
    default:
      throw new ArgsError(`unknown command ${command}`);
  }
}
