import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ardentHiveSkillsUrl, ardentHiveSkillsTarget, checkArdentSkillRelease, fetchArdentSkillRelease } from './ardent-hiveskills.js';

const REGISTRY = 'https://skills.example.com:4030';

/** A gzip ustar archive of [name, contents] files, the shape HiveSkills publishes. */
function archive(entries: Array<[string, string]>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, contents] of entries) {
    const body = Buffer.from(contents);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0', 257); header.write('00', 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
const SKILL = '---\nname: web-research\ndescription: Search the web carefully.\n---\n\n# Web research\n';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const request = { source: 'hiveskills' as const, name: 'web-research', version: '1.2.0' };

/** A registry answering the catalog entry and the archive, recording each URL it was asked for. */
function registry(bytes: Buffer, options: { version?: string; digest?: string; header?: string | null; catalogStatus?: number; archiveStatus?: number } = {}) {
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    expect(init?.redirect).toBe('error');
    if (url.includes('/archive')) {
      const header = options.header === undefined ? sha(bytes) : options.header;
      return new Response(new Uint8Array(bytes), { status: options.archiveStatus ?? 200, headers: { 'Content-Type': 'application/gzip', ...(header ? { 'X-Content-SHA256': header } : {}) } });
    }
    return Response.json({ slug: 'web-research', name: 'Web research', enabled: true,
      release: { version: options.version ?? '1.2.0', sha256: options.digest ?? sha(bytes), notes: null, createdAt: '2026-01-01T00:00:00.000Z' } }, { status: options.catalogStatus ?? 200 });
  });
  return { urls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

afterEach(() => vi.unstubAllEnvs());

describe('HiveSkills releases for Ardent', () => {
  it('fetches the promoted release and checks it against the catalog digest', async () => {
    vi.stubEnv('MAGNUS_ARDENT_HIVESKILLS_URL', REGISTRY);
    const bytes = archive([['SKILL.md', SKILL], ['references/tools.md', '# Tools\n']]);
    const { urls, fetchImpl } = registry(bytes);
    expect(await fetchArdentSkillRelease(request, fetchImpl)).toEqual({ sha256: sha(bytes), archiveBase64: bytes.toString('base64'), files: 2 });
    expect(urls).toEqual([`${REGISTRY}/v1/skills/web-research`, `${REGISTRY}/v1/skills/web-research/releases/1.2.0/archive`]);
    const canary = registry(bytes);
    await fetchArdentSkillRelease({ ...request, channel: 'canary' }, canary.fetchImpl);
    expect(canary.urls.every(url => url.endsWith('?channel=canary'))).toBe(true);
  });

  it('needs an HTTPS registry without credentials', async () => {
    expect(ardentHiveSkillsUrl({})).toBeNull();
    expect(ardentHiveSkillsUrl({ MAGNUS_ARDENT_HIVESKILLS_URL: `${REGISTRY}/base` })).toBe(`${REGISTRY}/base/`);
    for (const value of ['http://skills.example.com', 'https://user:secret@skills.example.com', 'https://skills.example.com/?x=1'])
      expect(() => ardentHiveSkillsUrl({ MAGNUS_ARDENT_HIVESKILLS_URL: value }), value).toThrow();
    await expect(fetchArdentSkillRelease(request, registry(archive([['SKILL.md', SKILL]])).fetchImpl)).rejects.toMatchObject({ status: 503, code: 'HIVESKILLS_UNCONFIGURED' });
  });

  it('refuses a missing skill, a version that is not promoted and an unreachable registry', async () => {
    vi.stubEnv('MAGNUS_ARDENT_HIVESKILLS_URL', REGISTRY);
    const bytes = archive([['SKILL.md', SKILL]]);
    await expect(fetchArdentSkillRelease(request, registry(bytes, { catalogStatus: 404 }).fetchImpl)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    await expect(fetchArdentSkillRelease(request, registry(bytes, { version: '1.3.0' }).fetchImpl))
      .rejects.toMatchObject({ status: 409, code: 'SKILL_VERSION_UNAVAILABLE', message: 'web-research 1.2.0 is not the release promoted on the stable channel; 1.3.0 is' });
    await expect(fetchArdentSkillRelease(request, registry(bytes, { archiveStatus: 404 }).fetchImpl)).rejects.toMatchObject({ status: 409, code: 'SKILL_VERSION_UNAVAILABLE' });
    const down = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await expect(fetchArdentSkillRelease(request, down)).rejects.toMatchObject({ status: 503, code: 'DEPENDENCY_UNAVAILABLE' });
  });

  it('refuses an archive whose digest differs from the catalog, or that Ardent could not index', async () => {
    vi.stubEnv('MAGNUS_ARDENT_HIVESKILLS_URL', REGISTRY);
    const bytes = archive([['SKILL.md', SKILL]]);
    await expect(fetchArdentSkillRelease(request, registry(bytes, { digest: 'a'.repeat(64) }).fetchImpl)).rejects.toMatchObject({ status: 422, code: 'SKILL_ARCHIVE_INVALID' });
    await expect(fetchArdentSkillRelease(request, registry(bytes, { header: 'b'.repeat(64) }).fetchImpl)).rejects.toMatchObject({ status: 422, code: 'SKILL_ARCHIVE_INVALID' });
    expect(await fetchArdentSkillRelease(request, registry(bytes, { header: null }).fetchImpl)).toMatchObject({ files: 1 });
    const unsafe = archive([['SKILL.md', SKILL], ['../escape.md', 'x']]);
    await expect(fetchArdentSkillRelease(request, registry(unsafe).fetchImpl)).rejects.toMatchObject({ status: 422, message: expect.stringContaining('Unsafe or duplicate archive path') });
    const renamed = archive([['SKILL.md', SKILL.replace('name: web-research', 'name: other')]]);
    await expect(fetchArdentSkillRelease(request, registry(renamed).fetchImpl)).rejects.toMatchObject({ message: expect.stringContaining('names the skill other') });
    const large = Buffer.concat([archive([['SKILL.md', SKILL]]), Buffer.alloc(1024 * 1024)]);
    await expect(fetchArdentSkillRelease(request, registry(large).fetchImpl)).rejects.toMatchObject({ status: 422, message: expect.stringContaining('exceeds the 1 MiB') });
  });
});

/**
 * A HiveSkills with 1.3.0 promoted and 1.2.0 kept as an immutable release: the pinned routes answer only the
 * enrolled target `magnus` with its token, as HiveSkills' pinned-release reader does; anonymous archive
 * requests for 1.2.0 answer 404.
 */
function pinnedRegistry(bytes: Buffer, options: { assigned?: boolean; header?: string | null; metadataDigest?: string } = {}) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get('authorization');
    calls.push({ url: url.toString(), authorization });
    expect(init?.redirect).toBe('error');
    if (url.pathname === '/v1/skills/web-research') return Response.json({ slug: 'web-research', enabled: true, release: { version: '1.3.0', sha256: 'c'.repeat(64) } });
    const reader = url.searchParams.get('target') === 'magnus' && authorization === `Bearer ${TARGET_TOKEN}`;
    if (!reader) return Response.json({ error: 'Release archive not found' }, { status: url.searchParams.has('target') ? 401 : 404 });
    if (options.assigned === false) return Response.json({ error: 'This target is not assigned the skill' }, { status: 403 });
    if (url.pathname === '/v1/skills/web-research/releases/1.2.0') return Response.json({ slug: 'web-research', version: '1.2.0', sha256: options.metadataDigest ?? sha(bytes),
      size: bytes.length, notes: null, compatibility: { minHermesVersion: null, maxHermesVersion: null }, channels: [], archiveUrl: 'https://skills.example.com/x', createdAt: '2026-01-01T00:00:00.000Z' });
    if (url.pathname === '/v1/skills/web-research/releases/1.2.0/archive') {
      const header = options.header === undefined ? sha(bytes) : options.header;
      return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'application/gzip', ...(header ? { 'X-Content-SHA256': header } : {}) } });
    }
    return Response.json({ error: 'Release not found' }, { status: 404 });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}
const TARGET_TOKEN = 'fixture-target-token-value';
let secrets: string | undefined;
afterEach(() => { if (secrets) rmSync(secrets, { recursive: true, force: true }); secrets = undefined; });
function targetCredential(token = TARGET_TOKEN): void {
  secrets = mkdtempSync(join(tmpdir(), 'hiveskills-target-'));
  const file = join(secrets, 'token');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  vi.stubEnv('MAGNUS_ARDENT_HIVESKILLS_TARGET', 'magnus');
  vi.stubEnv('MAGNUS_ARDENT_HIVESKILLS_TARGET_TOKEN_FILE', file);
}

describe('pinned HiveSkills releases', () => {
  const pinned = { ...request, pinned: true };

  it('installs a release that is not promoted as the enrolled target, checking the stated digest and header', async () => {
    vi.stubEnv('MAGNUS_ARDENT_HIVESKILLS_URL', REGISTRY);
    targetCredential();
    const bytes = archive([['SKILL.md', SKILL]]);
    const { calls, fetchImpl } = pinnedRegistry(bytes);
    expect(await fetchArdentSkillRelease(pinned, fetchImpl, { expectedSha256: sha(bytes) })).toEqual({ sha256: sha(bytes), archiveBase64: bytes.toString('base64'), files: 1 });
    expect(calls).toEqual([
      { url: `${REGISTRY}/v1/skills/web-research`, authorization: null },
      { url: `${REGISTRY}/v1/skills/web-research/releases/1.2.0?target=magnus`, authorization: `Bearer ${TARGET_TOKEN}` },
      { url: `${REGISTRY}/v1/skills/web-research/releases/1.2.0/archive?target=magnus`, authorization: `Bearer ${TARGET_TOKEN}` },
    ]);
    expect(await checkArdentSkillRelease(pinned, pinnedRegistry(bytes).fetchImpl)).toEqual({ sha256: sha(bytes), promoted: false });
  });

  it('is refused without a target credential, and an unpinned request still needs the promoted version', async () => {
    vi.stubEnv('MAGNUS_ARDENT_HIVESKILLS_URL', REGISTRY);
    const bytes = archive([['SKILL.md', SKILL]]);
    const without = pinnedRegistry(bytes);
    await expect(fetchArdentSkillRelease(pinned, without.fetchImpl)).rejects.toMatchObject({ status: 409, code: 'SKILL_VERSION_UNAVAILABLE',
      message: expect.stringContaining('set MAGNUS_ARDENT_HIVESKILLS_TARGET and MAGNUS_ARDENT_HIVESKILLS_TARGET_TOKEN_FILE') });
    // Nothing but the public catalog was asked, and no credential was sent.
    expect(without.calls.map(call => call.url)).toEqual([`${REGISTRY}/v1/skills/web-research`]);
    targetCredential();
    await expect(fetchArdentSkillRelease(request, pinnedRegistry(bytes).fetchImpl)).rejects.toMatchObject({ status: 409, code: 'SKILL_VERSION_UNAVAILABLE',
      message: expect.stringContaining('1.3.0 is') });
  });

  it('reports a wrong token, an unassigned skill, another digest and a missing digest header', async () => {
    vi.stubEnv('MAGNUS_ARDENT_HIVESKILLS_URL', REGISTRY);
    const bytes = archive([['SKILL.md', SKILL]]);
    targetCredential('fixture-wrong-token');
    await expect(fetchArdentSkillRelease(pinned, pinnedRegistry(bytes).fetchImpl)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('HTTP 401') });
    targetCredential();
    await expect(fetchArdentSkillRelease(pinned, pinnedRegistry(bytes, { assigned: false }).fetchImpl)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('assign the skill') });
    await expect(fetchArdentSkillRelease(pinned, pinnedRegistry(bytes).fetchImpl, { expectedSha256: 'e'.repeat(64) })).rejects.toMatchObject({ status: 409, code: 'SKILL_VERSION_UNAVAILABLE' });
    await expect(fetchArdentSkillRelease(pinned, pinnedRegistry(bytes, { metadataDigest: 'a'.repeat(64) }).fetchImpl)).rejects.toMatchObject({ status: 422, code: 'SKILL_ARCHIVE_INVALID' });
    await expect(fetchArdentSkillRelease(pinned, pinnedRegistry(bytes, { header: null }).fetchImpl)).rejects.toMatchObject({ status: 422, message: expect.stringContaining('X-Content-SHA256') });
  });

  it('needs the target name and token file together', () => {
    expect(ardentHiveSkillsTarget({})).toBeNull();
    expect(() => ardentHiveSkillsTarget({ MAGNUS_ARDENT_HIVESKILLS_TARGET: 'magnus' })).toThrow('set together');
    expect(() => ardentHiveSkillsTarget({ MAGNUS_ARDENT_HIVESKILLS_TARGET: 'magnus', MAGNUS_ARDENT_HIVESKILLS_TARGET_TOKEN_FILE: '/nonexistent/token' })).toThrow('cannot be read');
  });
});
