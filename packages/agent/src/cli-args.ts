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

/**
 * The enrollment token of `magnus-agent enroll`: `--token <token>`, or `--token-file <path>` where `-`
 * means standard input, so callers can keep the token off the process table. Side-effect free apart
 * from `read`, which tests replace.
 */
export function enrollmentTokenFrom(rest: readonly string[], read: (path: string | 0) => string): { token: string } | { error: string } {
  const value = (name: string): string | undefined => {
    const index = rest.indexOf(name);
    if (index >= 0) return rest[index + 1];
    return rest.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  };
  const usage = 'usage: magnus-agent enroll --token <token> | --token-file <path|->';
  const direct = value('--token');
  const file = value('--token-file');
  const options = rest.filter(arg => arg.startsWith('--')).length;
  if ((direct === undefined) === (file === undefined) || options !== 1 || rest.length > 2) return { error: usage };
  let raw: string;
  if (file !== undefined) {
    if (!file) return { error: usage };
    try { raw = read(file === '-' ? 0 : file); }
    catch (error) { return { error: `cannot read the enrollment token from ${file === '-' ? 'standard input' : file}: ${(error as NodeJS.ErrnoException).code ?? 'unreadable'}` }; }
  } else raw = direct ?? '';
  const token = raw.trim();
  if (!token || token.length > 512 || /\s/.test(token)) return { error: 'the enrollment token must be one line without spaces' };
  return { token };
}
