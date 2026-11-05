// Magnus owns profile selection and process supervision. Codex owns its native
// configuration, authentication and protocol; no credentials are migrated here.
import { spawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
async function protectedPath(path, directory = false) {
  if (!isAbsolute(path)) throw Error('An absolute protected runtime path is required');
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 ||
      !(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1 && stat.size <= 1024 * 1024) || await realpath(path) !== resolve(path))
    throw Error('An owned private profile and environment file are required');
}
try {
  const input = process.argv.slice(2), argv = [];
  let profile, environment;
  for (let index = 0; index < input.length; index++) {
    if (input[index] === '--profile-path') { if (profile) throw Error('Select one explicit profile'); profile = input[++index]; }
    else if (input[index] === '--env-file') { if (environment) throw Error('Select one protected environment'); environment = input[++index]; }
    else argv.push(input[index]);
  }
  if (!profile || !environment || !argv.length) throw Error('Select --profile-path DIR --env-file FILE and a native Codex command');
  if (argv.some(value => /^(?:-p|--profile(?:=|$))/.test(value))) throw Error('Use only the explicit --profile-path selection');
  await protectedPath(profile, true); await protectedPath(environment);
  for (const name of ['config.toml', 'auth.json', '.env']) {
    try { await lstat(join(profile, name)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await protectedPath(join(profile, name));
  }
  const env = { ...process.env };
  const saved = parseEnv(await readFile(environment, 'utf8'));
  for (const values of [env, saved]) {
    if (values.CODEX_HOME && values.CODEX_HOME !== profile) throw Error('The selected profile conflicts with CODEX_HOME; preserve and review its original configuration');
    if (values.CODEX_PROFILE) throw Error('Conflicting Codex profile overrides must be reviewed before startup');
  }
  for (const [name, value] of Object.entries(saved))
    if (env[name] === undefined) env[name] = value;
  if (env.CODEX_HOME && env.CODEX_HOME !== profile) throw Error('The selected profile conflicts with CODEX_HOME; preserve and review its original configuration');
  env.CODEX_HOME = profile;
  if (argv[0] === '--native-acceptance') {
    if (!(argv.length === 1 || argv.length === 3 && argv[1] === '--expected-answer')) throw Error('Native acceptance takes only an optional bounded expected answer');
    const { runAcceptance } = await import('./acceptance.mjs');
    const { parse } = await import('smol-toml');
    const version = JSON.parse(await readFile(new URL('./node_modules/@openai/codex/package.json', import.meta.url))).version;
    const native = (args, childEnv, cwd, timeout) => new Promise((done, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./node_modules/@openai/codex/bin/codex.js', import.meta.url)), ...args], { env: childEnv, cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      let stdout = '', bytes = 0, failed = false;
      const stop = () => { failed = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
      const timer = setTimeout(stop, timeout); process.once('SIGINT', stop); process.once('SIGTERM', stop);
      const capture = data => { bytes += data.length; if (bytes > 1024 * 1024) stop(); };
      child.stdout.on('data', data => { capture(data); if (!failed) stdout += data; }); child.stderr.on('data', capture);
      const cleanup = () => { clearTimeout(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop); };
      child.once('error', () => { cleanup(); reject(Error('Native acceptance could not start')); });
      child.once('close', code => { cleanup(); if (code || failed) reject(Error('Native acceptance failed or exceeded its bounds')); else done(stdout); });
    });
    process.stdout.write(JSON.stringify(await runAcceptance({ profile, environment, env, native, parseToml: parse, version, expected: argv[2] ?? 'READY' })) + '\n');
    process.exit(0);
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL('./node_modules/@openai/codex/bin/codex.js', import.meta.url)), ...argv], { env, stdio: 'inherit' });
  const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  child.on('error', () => { process.stderr.write('Native Codex could not start\n'); process.exitCode = 1; });
  child.on('close', code => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); process.exitCode = code ?? 1; });
} catch (error) {
  process.stderr.write((error instanceof Error && !('path' in error) ? error.message : 'Native Codex profile or environment could not be read') + '\n');
  process.exitCode = 1;
}
