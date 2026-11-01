/**
 * `magnus-server upgrade|rollback`: the upgrade engine lives in
 * @hivemagnus/magnus. Find the managed project this server was installed
 * into and hand the command to the engine installed alongside it.
 */
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const PROJECT_FILE = 'magnus-project.json';

export function findProjectDir(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, PROJECT_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function locateProject(packageRoot: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env['MAGNUS_PROJECT_DIR']?.trim();
  if (configured) return existsSync(join(configured, PROJECT_FILE)) ? resolve(configured) : null;
  let real = packageRoot;
  try { real = realpathSync(packageRoot); } catch { /* keep the unresolved path */ }
  return findProjectDir(real);
}

export async function delegateToProject(command: 'upgrade' | 'rollback', args: readonly string[], packageRoot: string): Promise<number> {
  const dir = locateProject(packageRoot);
  if (!dir) {
    console.error([
      'This magnus-server was not installed by `magnus init`, so there is no managed project to upgrade.',
      'Either turn this install into a managed project once:',
      '  npx @hivemagnus/magnus adopt --server-env-file <path to your server env file> [--ui-env-file <path>]',
      'or upgrade by hand: see UPGRADING.md (https://github.com/ChefTaco/magnus/blob/main/UPGRADING.md).',
      'Set MAGNUS_PROJECT_DIR if the project lives somewhere else.',
    ].join('\n'));
    return 1;
  }
  const engine = join(dir, 'current', 'node_modules', '@hivemagnus', 'magnus', 'dist', 'cli.js');
  if (!existsSync(engine)) {
    console.error(`The project at ${dir} has no upgrade engine in ./current. Run: npx @hivemagnus/magnus@latest ${command} --dir ${dir}`);
    return 1;
  }
  return new Promise<number>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [engine, command, '--dir', dir, ...args], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', code => resolvePromise(code ?? 1));
  });
}
