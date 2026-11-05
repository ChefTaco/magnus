#!/usr/bin/env node
// Build only the reviewed upstream public Git object, never a working checkout.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
export const HERMES_REVISION = '345cd2b057a452236de401d3534b8502a7465e8d';
export const HERMES_VERSION = '0.21.3';
export const HERMES_SOURCE = 'https://github.com/NousResearch/hermes-agent';
const execute = (program, args, options = {}) => execFileSync(program, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
export function publicHermesPaths(paths) {
  const directories = new Set(['agent','tools','hermes_cli','gateway','tui_gateway','cron','acp_adapter','plugins','providers','skills','optional-skills','assets','locales','plugin-catalog','optional-mcps']);
  const files = new Set(['LICENSE','README.md','SOUL.md','pyproject.toml','uv.lock','cli-config.yaml.example']);
  const selected = paths.filter(path => {
    if (path.includes('..') || path.startsWith('/') || path.includes('\\') || /[\r\n]/.test(path)) throw Error('Unsupported public source path');
    const parts = path.split('/');
    return parts.length === 1 ? files.has(path) || path.endsWith('.py') : directories.has(parts[0]);
  });
  if (selected.some(path => /\.(gguf|ggml|safetensors)$/i.test(path))) throw Error('External inference assets cannot be packaged');
  for (const file of ['LICENSE','pyproject.toml','uv.lock','hermes_cli/main.py','run_agent.py']) if (!selected.includes(file)) throw Error('Incomplete public Hermes source');
  return selected;
}
export function hermesBuildExtras(value = 'none') {
  if (!['none', 'messaging'].includes(value)) throw Error('Select --extras none or messaging; arbitrary runtime dependency additions are forbidden');
  return value === 'none' ? [] : ['messaging'];
}
export function buildHermesImage({ source, tag, extras = 'none' }) {
  const selectedExtras = hermesBuildExtras(extras);
  if (!source || !tag || !/^[a-z0-9][a-z0-9._/-]*:[a-z0-9][a-z0-9._-]*$/.test(tag)) throw Error('Select --source PUBLIC_GIT_OBJECT_STORE --tag LOCAL_REVIEW_TAG');
  const git = args => execute('git', ['--no-replace-objects', '-C', resolve(source), ...args]);
  if (git(['rev-parse', HERMES_REVISION + '^{commit}']).trim() !== HERMES_REVISION) throw Error('The exact reviewed public revision is required');
  const paths = publicHermesPaths(git(['ls-tree','-r','--name-only',HERMES_REVISION]).trim().split('\n'));
  const selected = new Set(paths);
  for (const row of git(['ls-tree', '-r', HERMES_REVISION]).trim().split('\n')) {
    const [metadata, path] = row.split('\t');
    if (selected.has(path) && !/^100(?:644|755) blob [a-f0-9]{40}$/.test(metadata))
      throw Error('Public runtime inputs must be regular immutable Git blobs');
  }
  const temporary = mkdtempSync(join(tmpdir(), 'magnus-public-hermes-build-'));
  try {
    mkdirSync(join(temporary,'source'), { mode: 0o700 });
    const archive = join(temporary,'public-source.tar');
    // Git archive reads only the immutable object; untracked files, private
    // fork changes, profiles, credentials and .git are never build inputs.
    const data = execFileSync('git', ['--no-replace-objects', '-C', resolve(source), 'archive', '--format=tar', HERMES_REVISION, '--', ...paths], { maxBuffer: 128 * 1024 * 1024 });
    writeFileSync(archive, data, { mode: 0o600 });
    execute('tar',['-xf',archive,'-C',join(temporary,'source'),'--no-same-owner']);
    const sourceRoot = join(temporary,'source');
    const project = readFileSync(join(sourceRoot,'pyproject.toml'),'utf8');
    if (!project.includes('version = "' + HERMES_VERSION + '"')) throw Error('Reviewed product version mismatch');
    const provenance = { schema:1, source:HERMES_SOURCE, revision:HERMES_REVISION, tag:'v2026.9.14', version:HERMES_VERSION,
      sourceArchiveSHA256:createHash('sha256').update(data).digest('hex'), lockSHA256:createHash('sha256').update(readFileSync(join(sourceRoot,'uv.lock'))).digest('hex'),
      sqlite:'3.53.4', sqliteSourceSHA256:'0e9483900e92cd5de8fd48d16bf9200145a61f7fd5be542a5ac81d8a9516eb9c', pythonSourceSHA256:'2ab91ff401783ccca64f75d10c882e957bdfd60e2bf5a72f8421793729b78a71', python:'3.13.13', uv:'0.11.6', installMode:'frozen-public-source-no-install-project', extras:selectedExtras, inference:'external-only' };
    writeFileSync(join(temporary,'provenance.json'),JSON.stringify(provenance,null,2)+'\n');
    const tooling=fileURLToPath(new URL('../tooling/native-hermes/',import.meta.url));
    for(const file of ['Dockerfile','launcher.mjs','runner.py','sqlite-loader.py','NOTICE'])copyFileSync(join(tooling,file),join(temporary,file));
    execute('docker',['build','--build-arg','HERMES_NATIVE_EXTRA='+extras,'-t',tag,temporary], { stdio:'inherit' });
    return provenance;
  } finally { rmSync(temporary,{recursive:true,force:true}); }
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try {
    const options={};
    for(let index=2;index<process.argv.length;index+=2){const name=process.argv[index],value=process.argv[index+1];if(!['--source','--tag','--extras'].includes(name)||!value||options[name.slice(2)])throw Error('Select --source PUBLIC_GIT_OBJECT_STORE --tag LOCAL_REVIEW_TAG');options[name.slice(2)]=value;}
    console.log(JSON.stringify(buildHermesImage(options)));
  } catch { process.stderr.write('Reviewed public Hermes image build failed; preserve protected build diagnostics\n');process.exitCode=1; }
}
