/**
 * Paths to this agent's own code that outlive the process (cron lines, for
 * example) must not name versions/<X>: a self-upgrade moves ./current and later
 * prunes old versions. Under the launcher, such a path is rewritten through the
 * install directory: `<dir>/node_modules/…` when that is the compatibility link
 * to current/node_modules (so lines written before the versioned layout keep
 * their exact text), otherwise `<dir>/current/…`.
 */
import { lstatSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export function stableCodePath(path: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env['MAGNUS_AGENT_LAUNCHER'] !== '1' || !env['AGENT_INSTALL_DIR']) return path;
  const dir = resolve(env['AGENT_INSTALL_DIR']);
  const inside = relative(join(dir, 'versions'), path);
  if (inside.startsWith('..') || inside === '' || inside.startsWith(sep)) return path;
  const [, ...rest] = inside.split(sep);
  if (rest.length === 0) return path;
  try {
    const link = join(dir, 'node_modules');
    if (rest[0] === 'node_modules' && lstatSync(link).isSymbolicLink()
      && realpathSync(link) === realpathSync(join(dir, 'current', 'node_modules'))) {
      return join(dir, ...rest);
    }
  } catch {
    // no compatibility link
  }
  return join(dir, 'current', ...rest);
}
