import { afterEach, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARDENT_EXTENSION_MANIFEST, ardentExtensionManifestSchema, assertArdentPluginsRetained, readArdentExtensionBundle, validateArdentExtensionLock } from './ardent-extensions.js';
import { packageTreeDigest } from './ardent-manager.js';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sri = (value: string | Buffer) => `sha512-${createHash('sha512').update(value).digest('base64')}`;
async function fixture() {
  const install = await mkdtemp(join(tmpdir(), 'ardent-extension-')); dirs.push(install);
  const name = '@example/extension', directory = join(install, 'node_modules', name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0' }), { mode: 0o644 });
  await writeFile(join(directory, 'index.js'), 'export default {name:"example"};\n');
  const archive = 'extension-0.tgz', archiveBytes = Buffer.from('fixture archive');
  await writeFile(join(install, archive), archiveBytes, { mode: 0o600 });
  const manifest = { schemaVersion: 1, packages: [{ name, version: '1.0.0', archive, integrity: sri(archiveBytes), packageTreeSha256: await packageTreeDigest(directory) }] };
  const text = JSON.stringify(manifest) + '\n', digest = sha(text);
  await writeFile(join(install, ARDENT_EXTENSION_MANIFEST), text, { mode: 0o600 });
  const bundle = await readArdentExtensionBundle(install, process.getuid!(), digest, packageTreeDigest);
  if (!bundle) throw Error('Missing fixture bundle');
  return { install, name, directory, archive, manifest, text, digest, bundle };
}
it('retains exact reviewed packages and refuses configured plugins without a retained bundle', async () => {
  const f = await fixture();
  expect(f.bundle.sha256).toBe(f.digest);
  expect(() => assertArdentPluginsRetained([f.name, `${f.name}/feature`], f.bundle)).not.toThrow();
  expect(() => assertArdentPluginsRetained(['@example/other'], f.bundle)).toThrow('reviewed extension bundle');
  expect(() => assertArdentPluginsRetained([f.name], null)).toThrow();
  expect(() => assertArdentPluginsRetained([], null)).not.toThrow();
  await expect(readArdentExtensionBundle(f.install, process.getuid!(), undefined, packageTreeDigest)).rejects.toThrow('receipt differ');
});
it('rejects altered archive bytes, private manifest permissions and symlink paths', async () => {
  const f = await fixture(), archive = join(f.install, f.archive);
  const original = await readFile(archive); await writeFile(archive, 'tampered');
  await expect(readArdentExtensionBundle(f.install, process.getuid!(), f.digest, packageTreeDigest)).rejects.toThrow('integrity');
  await writeFile(archive, original); await chmod(join(f.install, ARDENT_EXTENSION_MANIFEST), 0o644);
  await expect(readArdentExtensionBundle(f.install, process.getuid!(), f.digest, packageTreeDigest)).rejects.toThrow('ownership');
  await chmod(join(f.install, ARDENT_EXTENSION_MANIFEST), 0o600);
  const link = join(f.install, 'aliased'); await symlink(f.install, link);
  await expect(readArdentExtensionBundle(link, process.getuid!(), f.digest, packageTreeDigest)).rejects.toThrow('aliased');
  await writeFile(join(f.directory, 'index.js'), 'tampered');
  await expect(readArdentExtensionBundle(f.install, process.getuid!(), f.digest, packageTreeDigest)).rejects.toThrow('reviewed package');
});
it('refuses forged receipts, missing archives, package aliases and reserved package names', async () => {
  const f = await fixture();
  await expect(readArdentExtensionBundle(f.install, process.getuid!(), '0'.repeat(64), packageTreeDigest)).rejects.toThrow('reviewed receipt');
  await expect(readArdentExtensionBundle(f.install, process.getuid!() + 1, f.digest, packageTreeDigest)).rejects.toThrow('ownership');
  expect(() => ardentExtensionManifestSchema.parse({ ...f.manifest, packages: [f.manifest.packages[0], f.manifest.packages[0]] })).toThrow();
  expect(() => ardentExtensionManifestSchema.parse({ ...f.manifest, packages: [{ ...f.manifest.packages[0], name: '@hivemagnus/ardent' }] })).toThrow();
  await rm(join(f.install, f.archive)); await symlink(join(f.directory, 'index.js'), join(f.install, f.archive));
  await expect(readArdentExtensionBundle(f.install, process.getuid!(), f.digest, packageTreeDigest)).rejects.toThrow();
});
it('pins local package integrities, rejects foreign registries and forbids a second host runtime', async () => {
  const f = await fixture(), core = { name: '@hivemagnus/ardent', version: '3.1.0', integrity: sri('core') };
  const packages = { '': {}, [`node_modules/${core.name}`]: { version: core.version, integrity: core.integrity, resolved: 'file:core-package.tgz' },
    [`node_modules/${f.name}`]: { version: '1.0.0', integrity: f.manifest.packages[0]!.integrity, resolved: 'file:extension-0.tgz' },
    'node_modules/dependency': { version: '1.0.0', integrity: sri('dependency'), resolved: 'https://registry.npmjs.org/dependency/-/dependency-1.0.0.tgz' } };
  const lock = { lockfileVersion: 3, packages };
  expect(() => validateArdentExtensionLock(lock, core, f.bundle)).not.toThrow();
  expect(() => validateArdentExtensionLock({ ...lock, packages: { ...packages, 'node_modules/dependency': { ...packages['node_modules/dependency'], resolved: 'https://untrusted.example.com/package.tgz' } } }, core, f.bundle)).toThrow('origin');
  expect(() => validateArdentExtensionLock({ ...lock, packages: { ...packages, [`node_modules/${f.name}/node_modules/${core.name}`]: { version: '3.0.0', integrity: sri('old'), resolved: 'https://registry.npmjs.org/ardent.tgz' } } }, core, f.bundle)).toThrow('runtime peer');
  expect(() => validateArdentExtensionLock({ ...lock, packages: { ...packages, [`node_modules/${f.name}`]: { ...packages[`node_modules/${f.name}`], integrity: sri('other') } } }, core, f.bundle)).toThrow('reviewed packages');
});
