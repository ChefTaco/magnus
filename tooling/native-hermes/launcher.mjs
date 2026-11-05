// Magnus owns explicit profile selection; the reviewed public Hermes runtime
// retains its own provider configuration and native authentication protocols.
import { spawn } from 'node:child_process';
import { lstat, readFile, realpath, readdir, mkdir } from 'node:fs/promises';
import { isAbsolute, resolve, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
async function protectedPath(path, directory = false) {
  if (!isAbsolute(path)) throw Error('An absolute protected runtime path is required');
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 ||
      !(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1 && stat.size <= 1024 * 1024) || await realpath(path) !== resolve(path))
    throw Error('An owned private profile and environment file without links are required');
}
try {
  const input = process.argv.slice(2), argv = [];
  let profile, environment;
  for (let index = 0; index < input.length; index++) {
    if (input[index] === '--profile-path') { if (profile) throw Error('Select one explicit profile'); profile = input[++index]; }
    else if (input[index] === '--env-file') { if (environment) throw Error('Select one protected environment'); environment = input[++index]; }
    else argv.push(input[index]);
  }
  if (!profile || !environment || !argv.length) throw Error('Select --profile-path DIR --env-file FILE and a native Hermes command');
  if (argv.some(value => /^(?:-p|--profile(?:=|$))/.test(value))) throw Error('Use only the explicit --profile-path selection');
  await protectedPath(profile, true); await protectedPath(environment);
  for (const name of ['config.yaml', 'auth.json', '.env']) {
    try { await lstat(join(profile, name)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await protectedPath(join(profile, name));
  }
  const env = { ...process.env };
  const saved = parseEnv(await readFile(environment, 'utf8'));
  for (const values of [env, saved]) {
    if (values.HERMES_HOME && values.HERMES_HOME !== profile) throw Error('The selected profile conflicts with HERMES_HOME; preserve and review its original configuration');
    if (['PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'UV_PROJECT_ENVIRONMENT', 'HERMES_PROFILE'].some(name => values[name]))
      throw Error('Conflicting Python or Hermes profile overrides must be reviewed before startup');
  }
  for (const [name, value] of Object.entries(saved)) if (env[name] === undefined) env[name] = value;
  // Disable runtime dependency installation and writes to the release tree.
  env.HERMES_HOME = profile; env.HERMES_MANAGED = 'magnus'; env.HERMES_DISABLE_LAZY_INSTALLS = '1';
  env.PYTHONDONTWRITEBYTECODE = '1'; env.PYTHONNOUSERSITE = '1';
  if (argv.length === 1 && ['--native-init-profile', '--native-verify-profile'].includes(argv[0])) {
    for (const name of ['cron', 'sessions', 'logs', 'memories']) {
      const path = join(profile, name);
      if (argv[0] === '--native-init-profile')
        try { await lstat(path); } catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(path, { mode: 0o700 }); }
      await protectedPath(path, true);
    }
    process.stdout.write(JSON.stringify({ ok: true, product: 'hermes-agent', initialized: true, readOnly: argv[0] === '--native-verify-profile' }) + '\n');
    process.exit(0);
  }
  if (!(argv.length === 1 && argv[0] === '--native-preflight'))
    for (const name of ['cron', 'sessions', 'logs', 'memories']) await protectedPath(join(profile, name), true);

  const root = fileURLToPath(new URL('.', import.meta.url));
  const names = (await readdir(join(root, 'python'))).filter(name => /^cpython-3\.13\.13-linux-(x86_64|aarch64)-gnu$/.test(name));
  if (names.length !== 1) throw Error('An exact bundled Python runtime is required');
  const python = join(root, 'python', names[0], 'bin/python3.13');
  env.PATH = join(root, 'python', names[0], 'bin') + delimiter + (env.PATH ?? '/usr/bin:/bin');
  const child = spawn(python, ['-I', '-B', join(root, 'runner.py'), ...argv], { env, stdio: 'inherit' });
  const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  child.on('error', () => { process.stderr.write('Native Hermes could not start\n'); process.exitCode = 1; });
  child.on('close', code => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); process.exitCode = code ?? 1; });
} catch (error) {
  process.stderr.write((error instanceof Error && !('path' in error) ? error.message : 'Native Hermes profile or environment could not be read') + '\n');
  process.exitCode = 1;
}
