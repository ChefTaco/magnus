/** One or more plain path segments with a leading slash and no trailing slash. */
const CONSOLE_BASE_PATH = /^(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._~-]+)+$/;

export function isConsoleBasePath(value: string): boolean {
  return CONSOLE_BASE_PATH.test(value);
}

/**
 * Absolute path of a console page, honouring MAGNUS_CONSOLE_BASE_PATH.
 * Null when the configured base is invalid, so callers omit the link rather
 * than emit one they cannot vouch for. Startup validation rejects that value.
 */
export function consolePagePath(page: `/${string}`, env: Record<string, string | undefined> = process.env): string | null {
  const base = env['MAGNUS_CONSOLE_BASE_PATH'];
  if (!base) return page;
  return isConsoleBasePath(base) ? `${base}${page}` : null;
}
