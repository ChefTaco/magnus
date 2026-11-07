import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { image: { type: 'string', default: 'node:24.22.1-bookworm-slim' } } });
if (!/^node:(?:24\.22\.1|26\.13\.0)-bookworm-slim$/.test(values.image)) throw new Error('Use a supported pinned Node image');
const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'magnus-context-container-'));
try {
  await chmod(temporary, 0o755);
  const fixture = join(temporary, 'fixture');
  await mkdir(fixture);
  await writeFile(join(fixture, 'package.json'), '{"private":true,"type":"module"}');
  execFileSync('npm', ['install', '--prefix', fixture, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
    '--registry=https://registry.npmjs.org', '@hivemagnus/ardent@1.1.2'], {
    env: { PATH: process.env.PATH, HOME: temporary, npm_config_cache: join(temporary, 'cache') }, timeout: 300000, stdio: 'pipe' });
  const source = join(temporary, 'source');
  await mkdir(join(source, 'node_modules'), { recursive: true });
  for (const workspace of ['agent', 'contracts']) {
    const destination = join(source, 'packages', workspace);
    await mkdir(destination, { recursive: true });
    await cp(join(root, 'packages', workspace, 'dist'), join(destination, 'dist'), { recursive: true });
    await cp(join(root, 'packages', workspace, 'package.json'), join(destination, 'package.json'));
  }
  await cp(join(root, 'scripts/fixtures/context-adoption-container.mjs'), join(temporary, 'run.mjs'));
  await cp(join(root, 'scripts/fixtures/context-adoption-codex.mjs'), join(temporary, 'codex.mjs'));
  execFileSync('docker', ['run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE',
    '--cap-add', 'FOWNER', '--cap-add', 'FSETID', '--cap-add', 'KILL',
    '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '1g',
    '-v', `${temporary}:/fixture:ro`, '-v', `${source}:/source:ro`, '-v', `${join(root, 'node_modules')}:/source/node_modules:ro`,
    values.image, '/usr/local/bin/node', '/fixture/run.mjs'], { timeout: 180000, stdio: 'inherit' });
} finally { await rm(temporary, { recursive: true, force: true }); }
