/** Argument parsing for the `magnus-agent` CLI, kept free of side effects. */
export interface ParsedCli { command: string; rest: string[]; envFile?: string; help: boolean; version: boolean }

export class UsageError extends Error {}

export function parseCli(argv: string[]): ParsedCli {
  const parsed: ParsedCli = { command: 'start', rest: [], help: false, version: false };
  let commandSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--env-file' || arg.startsWith('--env-file=')) {
      const value = arg === '--env-file' ? argv[++index] : arg.slice('--env-file='.length);
      if (!value) throw new UsageError('--env-file needs a path');
      parsed.envFile = value;
      continue;
    }
    if (!commandSeen) {
      if (arg === '--help' || arg === '-h') { parsed.help = true; continue; }
      if (arg === '--version' || arg === '-v' || arg === '-V') { parsed.version = true; continue; }
      if (arg.startsWith('-')) throw new UsageError(`unknown option: ${arg}`);
      parsed.command = arg;
      commandSeen = true;
      continue;
    }
    parsed.rest.push(arg);
  }
  return parsed;
}
