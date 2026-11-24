/**
 * HiveSkills catalog releases for Ardent profiles (the skill-install action). Magnus fetches a release
 * from its HiveSkills registry, MAGNUS_ARDENT_HIVESKILLS_URL or, without it, the HiveSkills the Hive
 * Registry lists (services/discovery.ts), and checks it the way the HiveSkills Hermes bridge does: the
 * archive's SHA-256 must equal the release digest the registry states (and its X-Content-SHA256 header),
 * and the archive may hold only regular files and directories under a root SKILL.md. HiveSkills releases
 * are immutable and carry no signature, so the stated digest over HTTPS is the trust anchor. The node
 * agent checks everything again before it installs anything.
 *
 * The release promoted on a channel is public: Magnus sends no credential for it. A pinned request
 * (`pinned: true`) for another release reads it through the pinned-release routes
 * (skills.pinned-release.v1) as Magnus's enrolled HiveSkills target, MAGNUS_ARDENT_HIVESKILLS_TARGET with
 * the target token in MAGNUS_ARDENT_HIVESKILLS_TARGET_TOKEN_FILE, limited to that target's skills.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import YAML from 'yaml';
import { z } from 'zod';
import { ARDENT_SKILL_ARCHIVE_LIMITS, checkArdentSkillArchive, type ArdentSkillInstall } from '@hivemagnus/magnus-contracts';
import { HttpError } from '../middleware/error-handler.js';
import { discoveredEndpoint } from './discovery.js';

/** The registry base URL (ending in `/`), or null when Magnus has none. Throws on an unusable value. */
export function ardentHiveSkillsUrl(env: NodeJS.ProcessEnv = process.env, discovered: string | null = discoveredEndpoint('hiveskills', env)): string | null {
  const value = env['MAGNUS_ARDENT_HIVESKILLS_URL'] || discovered;
  if (!value) return null;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('MAGNUS_ARDENT_HIVESKILLS_URL must be a URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('MAGNUS_ARDENT_HIVESKILLS_URL must be an HTTPS URL without credentials, query or fragment');
  return url.toString().endsWith('/') ? url.toString() : `${url.toString()}/`;
}

/** Magnus's HiveSkills target for pinned releases, or null when none is configured. Throws on a partial or unreadable setup. */
export function ardentHiveSkillsTarget(env: NodeJS.ProcessEnv = process.env): { name: string; token: string } | null {
  const name = env['MAGNUS_ARDENT_HIVESKILLS_TARGET'];
  const file = env['MAGNUS_ARDENT_HIVESKILLS_TARGET_TOKEN_FILE'];
  if (!name && !file) return null;
  if (!name || !file) throw new Error('MAGNUS_ARDENT_HIVESKILLS_TARGET and MAGNUS_ARDENT_HIVESKILLS_TARGET_TOKEN_FILE are set together');
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(name)) throw new Error('MAGNUS_ARDENT_HIVESKILLS_TARGET must match [A-Za-z0-9._-]{1,128}');
  let token: string;
  try { token = readFileSync(file, 'utf8').trim(); }
  catch (error: unknown) { throw new Error(`MAGNUS_ARDENT_HIVESKILLS_TARGET_TOKEN_FILE cannot be read: ${(error as { code?: string }).code ?? 'unreadable'}`); }
  if (!/^[^\s,]{1,4096}$/u.test(token)) throw new Error('MAGNUS_ARDENT_HIVESKILLS_TARGET_TOKEN_FILE must hold one bearer token');
  return { name, token };
}

/** A checked release, ready for the node agent. */
export interface ArdentSkillRelease { sha256: string; archiveBase64: string; files: number }

const catalogEntrySchema = z.object({
  slug: z.string(),
  release: z.object({ version: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).passthrough().nullable().optional(),
}).passthrough();

const unavailable = (message: string) => new HttpError(503, 'DEPENDENCY_UNAVAILABLE', message);
const invalid = (message: string) => new HttpError(422, 'SKILL_ARCHIVE_INVALID', message.slice(0, 300));

async function get(fetchImpl: typeof fetch, url: URL, timeoutMs: number, token?: string): Promise<Response> {
  try { return await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) }); }
  catch (error: unknown) {
    throw unavailable(`The HiveSkills registry is unreachable: ${error instanceof Error ? error.message : 'request failed'}`.slice(0, 300));
  }
}

/** The response body, refused beyond `limit` bytes without reading the rest. */
async function bounded(response: Response, limit: number, tooLarge: () => HttpError): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel().catch(() => undefined); throw tooLarge(); }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw tooLarge();
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks);
}

const pinnedReleaseSchema = z.object({ slug: z.string(), version: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).passthrough();

function registryBase(): string {
  let base: string | null;
  try { base = ardentHiveSkillsUrl(); }
  catch (error: unknown) { throw new HttpError(503, 'HIVESKILLS_UNCONFIGURED', error instanceof Error ? error.message : 'Invalid HiveSkills registry'); }
  if (!base) throw new HttpError(503, 'HIVESKILLS_UNCONFIGURED', 'Magnus has no HiveSkills registry; set MAGNUS_ARDENT_HIVESKILLS_URL or enrol Magnus with the Hive Registry');
  return base;
}

async function json<T>(response: Response, schema: z.ZodType<T>, what: string): Promise<T> {
  try {
    const text = (await bounded(response, 1024 * 1024, () => unavailable(`The HiveSkills ${what} is too large`))).toString('utf8');
    return schema.parse(JSON.parse(text) as unknown);
  } catch (error: unknown) {
    if (error instanceof HttpError) throw error;
    throw unavailable(`HiveSkills returned an unexpected ${what}`);
  }
}

/** Where a release comes from: the public promoted archive, or the pinned routes as Magnus's target. */
interface ReleaseSource { sha256: string; archiveUrl: URL; token?: string; promoted: boolean }

/**
 * The release a request names and the digest HiveSkills states for it, without its archive. Answers 404 when
 * the catalog has no such enabled skill and 409 SKILL_VERSION_UNAVAILABLE when the version cannot be had: not
 * promoted on the channel (and not pinned), no target configured for a pinned one, or refused to that target.
 */
async function locateRelease(request: ArdentSkillInstall, fetchImpl: typeof fetch): Promise<ReleaseSource> {
  const base = registryBase();
  const channel = request.channel ?? 'stable';
  const withChannel = (path: string) => {
    const url = new URL(path, base);
    if (channel !== 'stable') url.searchParams.set('channel', channel);
    return url;
  };
  const catalog = await get(fetchImpl, withChannel(`v1/skills/${request.name}`), 10_000);
  if (catalog.status === 404) { await catalog.body?.cancel().catch(() => undefined); throw new HttpError(404, 'NOT_FOUND', `HiveSkills has no skill named ${request.name}`); }
  if (!catalog.ok) { await catalog.body?.cancel().catch(() => undefined); throw unavailable(`HiveSkills answered the catalog request with HTTP ${catalog.status}`); }
  const entry = await json(catalog, catalogEntrySchema, 'catalog entry');
  if (entry.slug !== request.name) throw unavailable('HiveSkills returned an unexpected catalog entry');
  const promoted = entry.release ?? null;
  const version = encodeURIComponent(request.version);
  if (promoted && promoted.version === request.version)
    return { sha256: promoted.sha256, archiveUrl: withChannel(`v1/skills/${request.name}/releases/${version}/archive`), promoted: true };
  const notPromoted = `${request.name} ${request.version} is not the release promoted on the ${channel} channel${promoted ? `; ${promoted.version} is` : ''}`;
  if (!request.pinned) throw new HttpError(409, 'SKILL_VERSION_UNAVAILABLE', notPromoted);
  let target: ReturnType<typeof ardentHiveSkillsTarget>;
  try { target = ardentHiveSkillsTarget(); }
  catch (error: unknown) { throw new HttpError(409, 'SKILL_VERSION_UNAVAILABLE', `${notPromoted}, and the HiveSkills target is misconfigured: ${error instanceof Error ? error.message : 'invalid'}`.slice(0, 500)); }
  if (!target) throw new HttpError(409, 'SKILL_VERSION_UNAVAILABLE',
    `${notPromoted}. A pinned release that is not promoted needs a HiveSkills target: set MAGNUS_ARDENT_HIVESKILLS_TARGET and MAGNUS_ARDENT_HIVESKILLS_TARGET_TOKEN_FILE`);
  const pinned = (path: string) => { const url = new URL(path, base); url.searchParams.set('target', target.name); return url; };
  const metadata = await get(fetchImpl, pinned(`v1/skills/${request.name}/releases/${version}`), 10_000, target.token);
  if ([401, 403, 404].includes(metadata.status)) {
    await metadata.body?.cancel().catch(() => undefined);
    throw new HttpError(409, 'SKILL_VERSION_UNAVAILABLE', metadata.status === 404
      ? `HiveSkills has no release ${request.name} ${request.version}, or no longer serves pinned releases`
      : `HiveSkills refused the pinned release ${request.name} ${request.version} to target ${target.name} (HTTP ${metadata.status}); assign the skill to the target`);
  }
  if (!metadata.ok) { await metadata.body?.cancel().catch(() => undefined); throw unavailable(`HiveSkills answered the pinned release request with HTTP ${metadata.status}`); }
  const release = await json(metadata, pinnedReleaseSchema, 'pinned release');
  if (release.slug !== request.name || release.version !== request.version) throw unavailable('HiveSkills returned an unexpected pinned release');
  return { sha256: release.sha256, archiveUrl: pinned(`v1/skills/${request.name}/releases/${version}/archive`), token: target.token, promoted: false };
}

/**
 * Whether a release can be installed, and the digest HiveSkills states for it, without downloading it (the
 * definition preflight). Throws the same errors as fetchArdentSkillRelease does before the download.
 */
export async function checkArdentSkillRelease(request: ArdentSkillInstall, fetchImpl: typeof fetch = fetch): Promise<{ sha256: string; promoted: boolean }> {
  const source = await locateRelease(request, fetchImpl);
  return { sha256: source.sha256, promoted: source.promoted };
}

/**
 * Fetch and check the requested release. Answers 503 HIVESKILLS_UNCONFIGURED without a registry, 404 when
 * the catalog has no such enabled skill, 409 SKILL_VERSION_UNAVAILABLE when the version cannot be had (see
 * locateRelease) or its digest is not `expectedSha256`, 422 SKILL_ARCHIVE_INVALID when the archive fails a
 * check, and 503 when the registry cannot be reached.
 */
export async function fetchArdentSkillRelease(request: ArdentSkillInstall, fetchImpl: typeof fetch = fetch,
  options: { expectedSha256?: string } = {}): Promise<ArdentSkillRelease> {
  const source = await locateRelease(request, fetchImpl);
  if (options.expectedSha256 !== undefined && source.sha256 !== options.expectedSha256)
    throw new HttpError(409, 'SKILL_VERSION_UNAVAILABLE', `HiveSkills states another digest for ${request.name} ${request.version} than the one pinned`);
  const download = await get(fetchImpl, source.archiveUrl, 30_000, source.token);
  if (download.status === 404) {
    await download.body?.cancel().catch(() => undefined);
    throw new HttpError(409, 'SKILL_VERSION_UNAVAILABLE', source.promoted
      ? `${request.name} ${request.version} is no longer promoted on the ${request.channel ?? 'stable'} channel`
      : `HiveSkills no longer serves ${request.name} ${request.version}`);
  }
  if (!download.ok) { await download.body?.cancel().catch(() => undefined); throw unavailable(`HiveSkills answered the archive request with HTTP ${download.status}`); }
  const header = download.headers.get('x-content-sha256');
  const archive = await bounded(download, ARDENT_SKILL_ARCHIVE_LIMITS.archiveBytes,
    () => invalid(`The ${request.name} archive exceeds the ${ARDENT_SKILL_ARCHIVE_LIMITS.archiveBytes / 1024 / 1024} MiB Magnus installs onto Ardent`));
  const sha256 = createHash('sha256').update(archive).digest('hex');
  if (sha256 !== source.sha256 || (header !== null && header !== source.sha256)) throw invalid('The archive digest differs from the HiveSkills catalog release');
  // The pinned-release route always states the digest; its absence means something else answered.
  if (!source.promoted && header === null) throw invalid('HiveSkills sent the pinned archive without its X-Content-SHA256 digest');
  let files: number;
  try {
    const tar = gunzipSync(archive, { maxOutputLength: ARDENT_SKILL_ARCHIVE_LIMITS.unpackedBytes });
    files = checkArdentSkillArchive(new Uint8Array(tar), request.name, source => YAML.parse(source) as unknown).files;
  } catch (error: unknown) {
    throw invalid(`The ${request.name} archive cannot be installed on Ardent: ${error instanceof Error ? error.message : 'unreadable'}`);
  }
  return { sha256, archiveBase64: archive.toString('base64'), files };
}
