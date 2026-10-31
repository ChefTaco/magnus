/**
 * logger.ts — Simple structured logger for Magnus Agent.
 *
 * Outputs lines in the format:
 *   [ISO timestamp] [LEVEL] message  {"key":"value"}
 *
 * Level filtering: set LOG_LEVEL env var to "debug", "info", "warn", or "error".
 * Defaults to "info" in production, "debug" if NODE_ENV=development.
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

const envLevel = (process.env['LOG_LEVEL'] ?? (process.env['NODE_ENV'] === 'development' ? 'debug' : 'info')) as Level;
const minLevel: number = LEVELS[envLevel] ?? LEVELS.info;

function write(level: Level, message: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < minLevel) return;
  const timestamp = new Date().toISOString();
  const metaStr = meta && Object.keys(meta).length > 0 ? `  ${JSON.stringify(meta)}` : '';
  const line = `[${timestamp}] [${level.toUpperCase().padEnd(5)}] ${message}${metaStr}`;
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export const logger = {
  /** Log a debug message (only visible when LOG_LEVEL=debug). */
  debug: (message: string, meta?: Record<string, unknown>) => write('debug', message, meta),

  /** Log an informational message. */
  info: (message: string, meta?: Record<string, unknown>) => write('info', message, meta),

  /** Log a warning (written to stderr). */
  warn: (message: string, meta?: Record<string, unknown>) => write('warn', message, meta),

  /** Log an error (written to stderr). */
  error: (message: string, meta?: Record<string, unknown>) => write('error', message, meta),
};
