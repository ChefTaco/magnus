/**
 * HiveSkills catalog releases for Ardent profiles (the skill-install action). Magnus fetches a release
 * from its configured registry, MAGNUS_ARDENT_HIVESKILLS_URL, which serves only the release promoted on a
 * channel, and checks it the way the HiveSkills Hermes bridge does: the archive's SHA-256 must equal the
 * catalog's release digest (and the registry's X-Content-SHA256 header), and the archive may hold only
 * regular files and directories under a root SKILL.md. HiveSkills releases are immutable and carry no
 * signature, so the catalog digest over HTTPS is the trust anchor. The node agent checks everything again
 * before it installs anything. The registry is public within its network: Magnus sends no credential.
 */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import YAML from 'yaml';
import { z } from 'zod';
import { ARDENT_SKILL_ARCHIVE_LIMITS, checkArdentSkillArchive, type ArdentSkillInstall } from '@hivemagnus/magnus-contracts';
import { HttpError } from '../middleware/error-handler.js';

/** The registry base URL (ending in `/`), or null when Magnus has none. Throws on an unusable value. */
export function ardentHiveSkillsUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env['MAGNUS_ARDENT_HIVESKILLS_URL'];
  if (!value) return null;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('MAGNUS_ARDENT_HIVESKILLS_URL must be a URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('MAGNUS_ARDENT_HIVESKILLS_URL must be an HTTPS URL without credentials, query or fragment');
  return url.toString().endsWith('/') ? url.toString() : `${url.toString()}/`;
}

/** A checked release, ready for the node agent. */
export interface ArdentSkillRelease { sha256: string; archiveBase64: string; files: number }

const catalogEntrySchema = z.object({
  slug: z.string(),
  release: z.object({ version: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).passthrough().nullable().optional(),
}).passthrough();

const unavailable = (message: string) => new HttpError(503, 'DEPENDENCY_UNAVAILABLE', message);
const invalid = (message: string) => new HttpError(422, 'SKILL_ARCHIVE_INVALID', message.slice(0, 300));

async function get(fetchImpl: typeof fetch, url: URL, timeoutMs: number): Promise<Response> {
  try { return await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); }
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

/**
 * Fetch and check the requested release. Answers 503 HIVESKILLS_UNCONFIGURED without a registry, 404 when
 * the catalog has no such enabled skill, 409 SKILL_VERSION_UNAVAILABLE when the version is not the one
 * promoted on the channel, 422 SKILL_ARCHIVE_INVALID when the archive fails a check, and 503 when the
 * registry cannot be reached.
 */
export async function fetchArdentSkillRelease(request: ArdentSkillInstall, fetchImpl: typeof fetch = fetch): Promise<ArdentSkillRelease> {
  let base: string | null;
  try { base = ardentHiveSkillsUrl(); }
  catch (error: unknown) { throw new HttpError(503, 'HIVESKILLS_UNCONFIGURED', error instanceof Error ? error.message : 'Invalid HiveSkills registry'); }
  if (!base) throw new HttpError(503, 'HIVESKILLS_UNCONFIGURED', 'Magnus has no HiveSkills registry; set MAGNUS_ARDENT_HIVESKILLS_URL');
  const channel = request.channel ?? 'stable';
  const withChannel = (path: string) => {
    const url = new URL(path, base);
    if (channel !== 'stable') url.searchParams.set('channel', channel);
    return url;
  };
  const catalog = await get(fetchImpl, withChannel(`v1/skills/${request.name}`), 10_000);
  if (catalog.status === 404) { await catalog.body?.cancel().catch(() => undefined); throw new HttpError(404, 'NOT_FOUND', `HiveSkills has no skill named ${request.name}`); }
  if (!catalog.ok) { await catalog.body?.cancel().catch(() => undefined); throw unavailable(`HiveSkills answered the catalog request with HTTP ${catalog.status}`); }
  let entry: z.infer<typeof catalogEntrySchema>;
  try {
    const text = (await bounded(catalog, 1024 * 1024, () => unavailable('The HiveSkills catalog entry is too large'))).toString('utf8');
    entry = catalogEntrySchema.parse(JSON.parse(text) as unknown);
  } catch (error: unknown) {
    if (error instanceof HttpError) throw error;
    throw unavailable('HiveSkills returned an unexpected catalog entry');
  }
  if (entry.slug !== request.name) throw unavailable('HiveSkills returned an unexpected catalog entry');
  const promoted = entry.release ?? null;
  if (!promoted || promoted.version !== request.version)
    throw new HttpError(409, 'SKILL_VERSION_UNAVAILABLE', `${request.name} ${request.version} is not the release promoted on the ${channel} channel${promoted ? `; ${promoted.version} is` : ''}`);
  const download = await get(fetchImpl, withChannel(`v1/skills/${request.name}/releases/${encodeURIComponent(request.version)}/archive`), 30_000);
  if (download.status === 404) {
    await download.body?.cancel().catch(() => undefined);
    throw new HttpError(409, 'SKILL_VERSION_UNAVAILABLE', `${request.name} ${request.version} is no longer promoted on the ${channel} channel`);
  }
  if (!download.ok) { await download.body?.cancel().catch(() => undefined); throw unavailable(`HiveSkills answered the archive request with HTTP ${download.status}`); }
  const header = download.headers.get('x-content-sha256');
  const archive = await bounded(download, ARDENT_SKILL_ARCHIVE_LIMITS.archiveBytes,
    () => invalid(`The ${request.name} archive exceeds the ${ARDENT_SKILL_ARCHIVE_LIMITS.archiveBytes / 1024 / 1024} MiB Magnus installs onto Ardent`));
  const sha256 = createHash('sha256').update(archive).digest('hex');
  if (sha256 !== promoted.sha256 || (header !== null && header !== promoted.sha256)) throw invalid('The archive digest differs from the HiveSkills catalog release');
  let files: number;
  try {
    const tar = gunzipSync(archive, { maxOutputLength: ARDENT_SKILL_ARCHIVE_LIMITS.unpackedBytes });
    files = checkArdentSkillArchive(new Uint8Array(tar), request.name, source => YAML.parse(source) as unknown).files;
  } catch (error: unknown) {
    throw invalid(`The ${request.name} archive cannot be installed on Ardent: ${error instanceof Error ? error.message : 'unreadable'}`);
  }
  return { sha256, archiveBase64: archive.toString('base64'), files };
}
