/** Argument parsing for the `magnus-server` CLI (no dependencies, strict). */
export type CliCommand = 'start' | 'check' | 'migrate' | 'migrations' | 'backup' | 'upgrade' | 'rollback' | 'agents' | 'env-schema' | 'help' | 'version';

export interface CliOptions {
  command: CliCommand;
  envFiles: string[];
  /** `start`: apply pending migrations before listening. */
  migrate: boolean;
  /** `env-schema`, `check` and `migrations`: output format. */
  format: 'json' | 'table';
  /** Whether --format was given (the default differs per command). */
  formatGiven: boolean;
  /** `backup`: label in the dump file name. */
  label?: string;
  /** `upgrade`, `rollback` and `agents`: arguments passed through unparsed. */
  passthrough: string[];
}

export class UsageError extends Error {}

export const USAGE = `Usage: magnus-server [command] [options]

Commands:
  start         Start the API server (default)
  check         Validate configuration and reach PostgreSQL and Redis; list enabled integrations
  migrate       Apply pending migrations (prisma migrate deploy) and base data
  migrations    Show applied and pending migrations with their impact notes
  backup        Dump PostgreSQL (pg_dump -Fc) into MAGNUS_BACKUP_DIR and print the restore command
  upgrade       Upgrade a \`magnus init\` project (runs \`magnus upgrade\`; see --help there)
  rollback      Switch a \`magnus init\` project back to the previous version
  agents        Agent fleet commands: \`agents upgrade [--to X.Y.Z] [--nodes a,b] [--dry-run]\`
  env-schema    Print the documented environment variables
  help          Show this help
  version       Print the version

Options:
  --env-file <path>   Load variables from an env file (repeatable; existing variables win)
  --migrate           start: apply pending migrations before listening (MAGNUS_AUTO_MIGRATE adds a backup and lock)
  --format <fmt>      env-schema (default json), check and migrations (default table): json or table
  --label <text>      backup: label in the dump file name
  -h, --help          Show this help
  -v, --version       Print the version
`;

const COMMANDS = new Set<CliCommand>(['start', 'check', 'migrate', 'migrations', 'backup', 'upgrade', 'rollback', 'agents', 'env-schema', 'help', 'version']);
/** Commands whose remaining arguments belong to another tool. */
const PASSTHROUGH = new Set<CliCommand>(['upgrade', 'rollback', 'agents']);

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { command: 'start', envFiles: [], migrate: false, format: 'json', formatGiven: false, passthrough: [] };
  let commandSeen = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const value = (flag: string): string => {
      const inline = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : undefined;
      if (inline !== undefined) return inline;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${flag} requires a value`);
      index++;
      return next;
    };
    if (commandSeen && PASSTHROUGH.has(options.command) && arg !== '--env-file' && !arg.startsWith('--env-file=')) {
      options.passthrough.push(arg);
      continue;
    }
    if (arg === '-h' || arg === '--help') options.command = 'help';
    else if (arg === '-v' || arg === '--version') options.command = 'version';
    else if (arg === '--env-file' || arg.startsWith('--env-file=')) options.envFiles.push(value('--env-file'));
    else if (arg === '--migrate') options.migrate = true;
    else if (arg === '--format' || arg.startsWith('--format=')) {
      const format = value('--format');
      if (format !== 'json' && format !== 'table') throw new UsageError(`unknown format "${format}" (use json or table)`);
      options.format = format;
      options.formatGiven = true;
    } else if (arg === '--label' || arg.startsWith('--label=')) options.label = value('--label');
    else if (arg.startsWith('-')) throw new UsageError(`unknown option ${arg}`);
    else if (!commandSeen && COMMANDS.has(arg as CliCommand)) {
      if (options.command !== 'help' && options.command !== 'version') options.command = arg as CliCommand;
      commandSeen = true;
    } else throw new UsageError(`unknown command "${arg}"`);
  }
  return options;
}
