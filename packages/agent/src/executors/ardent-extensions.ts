import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { z } from 'zod';

export const ARDENT_EXTENSION_MANIFEST = 'extension-bundle.json';
const packageName = z.string().regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/);
const integrity = z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const extension = z.object({
  name: packageName, version: z.string().regex(/^\d+\.\d+\.\d+$/),
  archive: z.string().regex(/^extension-[0-9]+\.tgz$/), integrity,
  packageTreeSha256: digest,
}).strict();
export const ardentExtensionManifestSchema = z.object({ schemaVersion: z.literal(1), packages: z.array(extension).min(1).max(32) }).strict()
  .refine(value => new Set(value.packages.map(item => item.name)).size === value.packages.length &&
    new Set(value.packages.map(item => item.archive)).size === value.packages.length &&
    value.packages.every(item => item.name !== '@hivemagnus/ardent'), 'Duplicate or reserved extension package');
export type ArdentExtensionManifest = z.infer<typeof ardentExtensionManifestSchema>;
export type ArdentExtensionBundle = { manifest: ArdentExtensionManifest; text: string; sha256: string };

async function ownedFile(file: string, uid: number, maximum: number, privateFile = true) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & (privateFile ? 0o077 : 0o022)) !== 0 || stat.size > maximum || await realpath(file) !== file)
      throw new Error('Ardent extension file ownership, mode, path or size differs');
    return await handle.readFile();
  } finally { await handle.close(); }
}

/** Only explicitly retained, receipt-bound packages can follow a managed runtime upgrade. */
export async function readArdentExtensionBundle(
  install: string, uid: number, expectedSha256: string | undefined,
  packageTreeDigest: (directory: string) => Promise<string>,
): Promise<ArdentExtensionBundle | null> {
  const file = join(install, ARDENT_EXTENSION_MANIFEST);
  const present = await lstat(file).then(() => true, (error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  });
  if (!present && expectedSha256 === undefined) return null;
  if (!present || expectedSha256 === undefined) throw new Error('Ardent extension bundle and package receipt differ');
  if (await realpath(install) !== resolve(install)) throw new Error('Ardent extension installation path is aliased');
  const bytes = await ownedFile(file, uid, 256 * 1024), sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expectedSha256) throw new Error('Ardent extension bundle differs from its reviewed receipt');
  const text = bytes.toString('utf8'), manifest = ardentExtensionManifestSchema.parse(JSON.parse(text) as unknown);
  for (const item of manifest.packages) {
    const archive = await ownedFile(join(install, item.archive), uid, 16 * 1024 * 1024);
    if (`sha512-${createHash('sha512').update(archive).digest('base64')}` !== item.integrity) throw new Error('Ardent extension archive integrity differs');
    const directory = join(install, 'node_modules', ...item.name.split('/'));
    if (await realpath(directory) !== directory || await packageTreeDigest(directory) !== item.packageTreeSha256)
      throw new Error('Installed Ardent extension differs from its reviewed package');
    const metadata = z.object({ name: packageName, version: z.string() }).parse(JSON.parse(
      (await ownedFile(join(directory, 'package.json'), uid, 1024 * 1024, false)).toString('utf8')) as unknown);
    if (metadata.name !== item.name || metadata.version !== item.version) throw new Error('Ardent extension package identity differs');
  }
  return { manifest, text, sha256 };
}

export function assertArdentPluginsRetained(plugins: readonly string[], bundle: ArdentExtensionBundle | null): void {
  if (plugins.some(specifier => !bundle?.manifest.packages.some(item => specifier === item.name || specifier.startsWith(`${item.name}/`))))
    throw new Error('Configured Ardent plugins require a reviewed extension bundle before replacing the runtime');
}

/** npm's peer solver must use the selected host runtime, never a second SDK/runtime copy. */
export function validateArdentExtensionLock(lock: unknown, core: { name: string; version: string; integrity: string }, bundle: ArdentExtensionBundle): void {
  const parsed = z.object({ lockfileVersion: z.number().min(3), packages: z.record(z.string(), z.object({
    version: z.string().optional(), integrity: z.string().optional(), resolved: z.string().optional(), link: z.boolean().optional(),
  }).passthrough()) }).passthrough().parse(lock);
  const expected = new Map<string, { version: string; archive: string; integrity: string }>([[`node_modules/${core.name}`, { ...core, archive: 'core-package.tgz' }],
    ...bundle.manifest.packages.map(item => [`node_modules/${item.name}`, item] as const)]);
  for (const [name, item] of Object.entries(parsed.packages)) {
    if (name === '') continue;
    if (item.link || !item.integrity || !/^sha(?:256|384|512)-/.test(item.integrity)) throw new Error('Ardent dependency integrity is missing');
    const pinned = expected.get(name);
    if (pinned) {
      if (item.version !== pinned.version || item.integrity !== pinned.integrity || item.resolved !== `file:${pinned.archive}`)
        throw new Error('Ardent extension dependency lock differs from reviewed packages');
    } else if (!item.resolved?.startsWith('https://registry.npmjs.org/') || name.endsWith(`/node_modules/${core.name}`))
      throw new Error('Ardent extension dependency origin or runtime peer differs');
  }
  for (const name of expected.keys()) if (!parsed.packages[name]) throw new Error('Ardent extension is absent from the dependency lock');
}
