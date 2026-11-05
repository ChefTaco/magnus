#!/usr/bin/env node
// Release tooling: export the reviewed, production-only agent image as a native
// artifact with its exact Node binary. No installer or service is started.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function assertPinnedImage(image) {
  if (
    typeof image !== 'string' ||
    !/^(?:[a-z0-9][a-z0-9./:_-]*@sha256:|sha256:)[a-f0-9]{64}$/.test(image)
  )
    throw Error('An exact reviewed image digest or local image ID is required');
}
export function validateRuntimeTree(root) {
  const base = realpathSync(root);
  function walk(directory, ancestors = new Set()) {
    const canonical = realpathSync(directory);
    if (ancestors.has(canonical))
      throw Error('Runtime contains a cyclic directory link');
    const next = new Set(ancestors);
    next.add(canonical);
    for (const name of readdirSync(directory)) {
      if (/\.(gguf|ggml|safetensors)$/i.test(name))
        throw Error('Native runtime includes external inference model assets');
      if (/[\r\n]/.test(name) || name.includes('..'))
        throw Error('Runtime archive contains an unsupported path');
      const path = join(directory, name),
        stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const target = realpathSync(path);
        if (!target.startsWith(base + sep))
          throw Error('Runtime link escapes the exported public package tree');
        if (statSync(target).isDirectory()) walk(target, next);
      } else if (stat.isDirectory()) walk(path, next);
      else if (!stat.isFile())
        throw Error('Runtime archive contains an unsupported file type');
    }
  }
  walk(base);
}
export function copyRuntimeTree(source, destination) {
  mkdirSync(destination, { mode: 0o700 });
  for (const name of readdirSync(source)) {
    const from = join(source, name),
      to = join(destination, name),
      stat = statSync(from);
    if (stat.isDirectory()) copyRuntimeTree(from, to);
    else if (stat.isFile()) {
      writeFileSync(to, readFileSync(from), {
        mode: stat.mode & 0o111 ? 0o700 : 0o600,
      });
    } else throw Error('Runtime contains an unsupported file type');
  }
}
function protectTree(root) {
  for (const name of readdirSync(root)) {
    const path = join(root, name),
      stat = lstatSync(path);
    if (stat.isDirectory()) {
      chmodSync(path, 0o700);
      protectTree(path);
    } else {
      if (!stat.isFile())
        throw Error(
          'Native bundle contains an unsupported file type: ' +
            path.slice(root.length + 1),
        );
      chmodSync(path, stat.mode & 0o111 ? 0o700 : 0o600);
    }
  }
}
export function buildNativeAgent(
  { image, output, product: selected = 'magnus' },
  execute = (command, args, environment) =>
    execFileSync(command, args, {
      ...(environment ? { env: environment } : {}),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    }).trim(),
) {
  assertPinnedImage(image);
  const layouts = {
    magnus: { root: '/opt/magnus-agent', name: '@hivemagnus/magnus-agent', bin: 'magnus-agent', entry: 'index.js',
      arguments: ['--env-file', '@ENV_FILE@', 'start'],
      acceptanceArguments: ['--env-file', '@ENV_FILE@', 'acceptance', '--json', '--wait-seconds', '60'] },
    ardent: { root: '/opt/ardent', name: '@hivemagnus/ardent', bin: 'ardent', entry: 'native-entry.js',
      arguments: ['--env-file', '@ENV_FILE@', '--profile-path', '@PROFILE@', 'gateway', 'run'],
      acceptanceArguments: ['--env-file', '@ENV_FILE@', '--profile-path', '@PROFILE@', 'acceptance'] },
    hermes: { root: '/opt/hermes-native', name: 'hermes-agent', bin: 'hermes', launcher: 'launcher.mjs',
      arguments: ['--env-file', '@ENV_FILE@', '--profile-path', '@PROFILE@', 'gateway', 'run'],
      versionPrefix: 'hermes-agent ',
      initializationArguments: ['--env-file', '@ENV_FILE@', '--profile-path', '@PROFILE@', '--native-init-profile'],
      verificationArguments: ['--env-file', '@ENV_FILE@', '--profile-path', '@PROFILE@', '--native-verify-profile'],
      acceptanceArguments: ['--env-file', '@ENV_FILE@', '--profile-path', '@PROFILE@', '--native-acceptance'],
      preflightArguments: ['--env-file', '@ENV_FILE@', '--profile-path', '@PROFILE@', '--native-preflight'] },
    codex: { root: '/opt/codex', name: '@openai/codex', bin: 'codex', launcher: 'launcher.mjs',
      arguments: ['--env-file', '@ENV_FILE@', '--profile-path', '@PROFILE@', 'app-server', '--listen', 'stdio://'],
      versionPrefix: 'codex-cli ',
      acceptanceArguments: ['--env-file', '@ENV_FILE@', '--profile-path', '@PROFILE@', '--native-acceptance'],
      preflightArguments: ['--env-file', '@ENV_FILE@', '--profile-path', '@PROFILE@', '--version'] },
  };
  const layout = layouts[selected];
  if (!layout) throw Error('Select an owned native product: magnus, ardent, codex or hermes');
  const destination = resolve(output);
  if (existsSync(destination))
    throw Error(
      'Output already exists; preserve its evidence and select a new directory',
    );
  const inspected = JSON.parse(
    execute('docker', ['image', 'inspect', image]),
  )[0];
  const architecture = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  if (inspected.Os !== 'linux' || inspected.Architecture !== architecture)
    throw Error(
      'Build and verify the native artifact on a matching Linux architecture',
    );
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  chmodSync(destination, 0o700);
  const temporary = mkdtempSync(join(tmpdir(), 'magnus-native-')),
    container = 'magnus-native-export-' + randomBytes(8).toString('hex');
  const preflightHome = join(temporary, 'preflight-home');
  mkdirSync(preflightHome, { mode: 0o700 });
  const nativeEnvironment = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: preflightHome, LANG: 'C.UTF-8' };
  let created = false;
  const put = (name, value) => {
    const path = join(destination, name);
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    chmodSync(path, 0o600);
  };
  try {
    execute('docker', [
      'create',
      '--name',
      container,
      '--entrypoint',
      '/bin/true',
      image,
    ]);
    created = true;
    const exported = join(temporary, 'exported');
    mkdirSync(exported, { mode: 0o700 });
    execute('docker', ['cp', container + ':' + layout.root + '/.', exported]);
    validateRuntimeTree(exported);
    const bundle = join(temporary, 'bundle');
    mkdirSync(bundle, { mode: 0o700 });
    copyRuntimeTree(exported, join(bundle, 'app'));
    mkdirSync(join(bundle, 'runtime'), { mode: 0o700 });
    mkdirSync(join(bundle, 'bin'), { mode: 0o700 });
    writeFileSync(join(bundle, 'MAGNUS-LICENSE'), readFileSync(new URL('../LICENSE', import.meta.url)), { mode: 0o600 });
    execute('docker', [
      'cp',
      '--follow-link',
      container + ':/usr/local/bin/node',
      join(bundle, 'runtime/node'),
    ]);
    chmodSync(join(bundle, 'runtime/node'), 0o700);
    const nodeVersion = execute(join(bundle, 'runtime/node'), ['--version'], nativeEnvironment);
    const packageFile = join(
      bundle,
      'app/node_modules/' + layout.name + '/package.json',
    );
    const product = JSON.parse(readFileSync(packageFile, 'utf8'));
    if (
      product.name !== layout.name ||
      !/^\d+\.\d+\.\d+$/.test(product.version)
    )
      throw Error(
        'Exported image does not contain the expected independently versioned product',
      );
    const launcher = join(bundle, 'bin', layout.bin);
    writeFileSync(
      launcher,
      '#!/usr/bin/env bash\nset -euo pipefail\numask 077\nartifact=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)\n' +
      'exec "$artifact/runtime/node" ' +
      '"$artifact/app/' + (layout.launcher ?? 'node_modules/' + layout.name + '/dist/' + layout.entry) + '" "$@"\n',
      { mode: 0o700 },
    );
    protectTree(bundle);
    const preflightArguments = layout.preflightArguments ?? ['--version'];
    const profile = join(temporary, 'preflight-profile'), environmentFile = join(temporary, 'preflight.env');
    mkdirSync(profile, { mode: 0o700 });
    writeFileSync(environmentFile, '', { mode: 0o600 });
    if (layout.initializationArguments) execute(launcher, layout.initializationArguments.map(value => value === '@PROFILE@' ? profile : value === '@ENV_FILE@' ? environmentFile : value), nativeEnvironment);
    const version = execute(launcher, preflightArguments.map(value => value === '@PROFILE@' ? profile : value === '@ENV_FILE@' ? environmentFile : value), nativeEnvironment);
    if (version !== (layout.versionPrefix ?? '') + product.version)
      throw Error('Native launcher version does not match its package');
    const name = `${layout.bin}-${product.version}-linux-${architecture}.tar.gz`,
      archive = join(destination, name);
    execute('tar', [
      '--sort=name',
      '--mtime=@0',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '--hard-dereference',
      '-czf',
      archive,
      '-C',
      bundle,
      '.',
    ]);
    chmodSync(archive, 0o600);
    const sha256 = createHash('sha256')
      .update(readFileSync(archive))
      .digest('hex');
    put('artifact.json', {
      schema: 1,
      product: product.name,
      version: product.version,
      architecture,
      sourceImage: image,
      sourceImageID: inspected.Id,
      ...(selected === 'hermes' ? { provenance: JSON.parse(readFileSync(join(bundle, 'app/provenance.json'), 'utf8')) } : {}),
      nodeVersion,
      nodeSHA256: createHash('sha256')
        .update(readFileSync(join(bundle, 'runtime/node')))
        .digest('hex'),
      archive: name,
      sha256,
      executable: 'bin/' + layout.bin,
      arguments: layout.arguments,
      preflight: { arguments: preflightArguments, expectedOutput: version },
      acceptanceArguments: layout.acceptanceArguments,
      initializationArguments: layout.initializationArguments,
      verificationArguments: layout.verificationArguments,
      published: false,
    });
    return { archive, sha256, version: product.version, architecture };
  } catch (error) {
    put('build-failed.json', { schema: 1, failed: true, published: false });
    throw error;
  } finally {
    if (created)
      try {
        execute('docker', ['rm', '-f', container]);
      } catch {}
    rmSync(temporary, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const options = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = process.argv[index],
        value = process.argv[index + 1];
      if (!['--image', '--output', '--product'].includes(key) || !value)
        throw Error(
          'Usage: build-native-agent.mjs --image PINNED_IMAGE --output NEW_DIRECTORY [--product magnus|ardent|codex|hermes]',
        );
      options[key.slice(2)] = value;
    }
    if (!options.output) throw Error('A new output directory is required');
    const result = buildNativeAgent(options);
    console.log(
      `Native agent artifact prepared: ${result.version} linux-${result.architecture}, SHA256 ${result.sha256}. Publication and host acceptance remain separate gates.`,
    );
  } catch (error) {
    console.error(
      error instanceof Error && !('stderr' in error)
        ? error.message
        : 'Native artifact build failed; protected evidence was retained',
    );
    process.exitCode = 1;
  }
}
