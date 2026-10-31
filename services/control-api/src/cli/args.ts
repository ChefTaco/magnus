/** Argument parsing for the `magnus-server` CLI (no dependencies, strict). */
export type CliCommand = 'start' | 'check' | 'migrate' | 'env-schema' | 'help' | 'version';

export interface CliOptions {
  command: CliCommand;
  envFiles: string[];
  /** `start`: apply pending migrations before listening. */
  migrate: boolean;
  /** `env-schema`: output format. */
  format: 'json' | 'table';
}

export class UsageError extends Error {}

export const USAGE = `Usage: magnus-server [command] [options]

Commands:
  start         Start the API server (default)
  check         Validate configuration and reach PostgreSQL and Redis; list enabled integrations
  migrate       Apply pending migrations (prisma migrate deploy) and base data
  env-schema    Print the documented environment variables
  help          Show this help
  version       Print the version

Options:
  --env-file <path>   Load variables from an env file (repeatable; existing variables win)
  --migrate           start: apply pending migrations before listening
  --format <fmt>      env-schema: json (default) or table
  -h, --help          Show this help
  -v, --version       Print the version
`;

const COMMANDS = new Set<CliCommand>(['start', 'check', 'migrate', 'env-schema', 'help', 'version']);

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { command: 'start', envFiles: [], migrate: false, format: 'json' };
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
    if (arg === '-h' || arg === '--help') options.command = 'help';
    else if (arg === '-v' || arg === '--version') options.command = 'version';
    else if (arg === '--env-file' || arg.startsWith('--env-file=')) options.envFiles.push(value('--env-file'));
    else if (arg === '--migrate') options.migrate = true;
    else if (arg === '--format' || arg.startsWith('--format=')) {
      const format = value('--format');
      if (format !== 'json' && format !== 'table') throw new UsageError(`unknown format "${format}" (use json or table)`);
      options.format = format;
    } else if (arg.startsWith('-')) throw new UsageError(`unknown option ${arg}`);
    else if (!commandSeen && COMMANDS.has(arg as CliCommand)) {
      if (options.command !== 'help' && options.command !== 'version') options.command = arg as CliCommand;
      commandSeen = true;
    } else throw new UsageError(`unknown command "${arg}"`);
  }
  return options;
}
