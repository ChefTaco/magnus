// Magnus owns profile selection and process supervision. Codex owns its native
// configuration, authentication and protocol; no credentials are migrated here.
import { spawn } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
async function protectedPath(path, directory = false) {
  if (!isAbsolute(path)) throw Error('An absolute protected runtime path is required');
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 ||
      !(directory ? stat.isDirectory() : stat.isFile() && stat.size <= 1024 * 1024))
    throw Error('An owned private profile and environment file are required');
}
try {
  const input = process.argv.slice(2), argv = [];
  let profile, environment;
  for (let index = 0; index < input.length; index++) {
    if (input[index] === '--profile-path') profile = input[++index];
    else if (input[index] === '--env-file') environment = input[++index];
    else argv.push(input[index]);
  }
  if (!profile || !environment || !argv.length) throw Error('Select --profile-path DIR --env-file FILE and a native Codex command');
  await protectedPath(profile, true); await protectedPath(environment);
  const env = { ...process.env };
  for (const [name, value] of Object.entries(parseEnv(await readFile(environment, 'utf8'))))
    if (env[name] === undefined) env[name] = value;
  if (env.CODEX_HOME && env.CODEX_HOME !== profile) throw Error('The selected profile conflicts with CODEX_HOME; preserve and review its original configuration');
  env.CODEX_HOME = profile;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./node_modules/@openai/codex/bin/codex.js', import.meta.url)), ...argv], { env, stdio: 'inherit' });
  const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  child.on('error', () => { process.stderr.write('Native Codex could not start\n'); process.exitCode = 1; });
  child.on('close', code => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); process.exitCode = code ?? 1; });
} catch (error) {
  process.stderr.write((error instanceof Error && !('path' in error) ? error.message : 'Native Codex profile or environment could not be read') + '\n');
  process.exitCode = 1;
}
