import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { rootControlled, type EmbermendNodeConfig } from './embermend-config.js';

const exec = promisify(execFile);
const reportSchema = z.object({ SchemaVersion: z.literal(2), Metadata: z.object({ ImageID: z.string(), RepoDigests: z.array(z.string()), OS: z.object({ Family: z.string(), Name: z.string() }).optional() }), Results: z.array(z.object({ Target: z.string(), Class: z.string().optional(), Type: z.string().optional(), Vulnerabilities: z.array(z.object({ VulnerabilityID: z.string(), PkgName: z.string(), InstalledVersion: z.string(), FixedVersion: z.string().optional(), Severity: z.string(), Title: z.string().optional(), PrimaryURL: z.string().optional(), DataSource: z.object({ ID: z.string(), Name: z.string(), URL: z.string() }).optional() })).optional() })) });
export function normalizeTrivy(raw: unknown, imageRef: string, feed: { generatedAt: string; sha256: string }, now = new Date()) {
  const report = reportSchema.parse(raw);
  if (!report.Metadata.RepoDigests.includes(imageRef)) throw new Error('Trivy image identity changed');
  const stale = now.getTime() - Date.parse(feed.generatedAt) > 48 * 3600000 || Date.parse(feed.generatedAt) > now.getTime() + 120000;
  return { engine: 'Trivy', vendor: report.Metadata.OS?.Family ?? 'package-vendors', platform: report.Metadata.OS?.Name ?? 'unknown', imageRef, imageId: report.Metadata.ImageID, observedAt: now.toISOString(), coverage: stale ? 'stale' : 'complete', failures: [], feed: { ...feed, url: 'https://github.com/aquasecurity/trivy-db' }, definitionCount: report.Results.length, advisories: report.Results.flatMap(result => (result.Vulnerabilities ?? []).map(item => ({ definitionId: item.VulnerabilityID, title: item.Title ?? item.VulnerabilityID, severity: item.Severity, references: item.PrimaryURL ? [{ source: item.DataSource?.ID ?? 'Trivy', id: item.VulnerabilityID, url: item.PrimaryURL }] : [], cves: /^CVE-\d{4}-\d{4,}$/.test(item.VulnerabilityID) ? [item.VulnerabilityID] : [], packages: [{ name: `${result.Target}:${item.PkgName}`, installedVersion: item.InstalledVersion, architecture: '', fixedVersions: item.FixedVersion ? item.FixedVersion.split(',').map(version => version.trim()).filter(Boolean) : [] }], vendorDecision: 'affected' }))) };
}
export async function assessImageVulnerabilities(raw: unknown, config: EmbermendNodeConfig) {
  const { imageRef } = z.object({ imageRef: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/) }).strict().parse(raw);
  const tool = config.trivy; if (!tool || !tool.imageRepositories.includes(imageRef.split('@')[0] ?? '')) throw new Error('Image assessment outside reviewed capability');
  await rootControlled(tool.path); const binary = await readFile(tool.path);
  if (createHash('sha256').update(binary).digest('hex') !== tool.sha256) throw new Error('Reviewed Trivy binary changed');
  const environment = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', HOME: '/nonexistent', DOCKER_HOST: 'unix:///var/run/docker.sock' };
  const command = async (path: string, args: string[], maxBuffer = 65536) => (await exec(path, args, { env: environment, timeout: 660000, maxBuffer })).stdout;
  const inspected = z.array(z.object({ Id: z.string(), RepoDigests: z.array(z.string()) })).length(1).parse(JSON.parse(await command('/usr/bin/docker', ['image', 'inspect', imageRef])))[0];
  if (!inspected?.RepoDigests.includes(imageRef)) throw new Error('Image must already exist locally under the approved immutable digest');
  const cache = '/var/cache/embermend-trivy'; await mkdir(cache, { recursive: true, mode: 0o700 }); await rootControlled(cache);
  const directory = await mkdtemp('/var/tmp/embermend-trivy-');
  try {
    const output = join(directory, 'report.json');
    await command(tool.path, ['image', '--image-src', 'docker', '--skip-version-check', '--scanners', 'vuln', '--cache-dir', cache, '--timeout', '10m', '--format', 'json', '--output', output, imageRef]);
    if ((await stat(output)).size > 16 * 1024 * 1024) throw new Error('Trivy result exceeds retained evidence budget');
    const rawReport = await readFile(output); const rawMetadata = await readFile(join(cache, 'db/metadata.json'));
    const metadata = z.object({ UpdatedAt: z.iso.datetime({ offset: true }) }).parse(JSON.parse(rawMetadata.toString('utf8')));
    const result = normalizeTrivy(JSON.parse(rawReport.toString('utf8')), imageRef, { generatedAt: metadata.UpdatedAt, sha256: createHash('sha256').update(rawMetadata).digest('hex') });
    if (result.imageId !== inspected.Id) throw new Error('Local image changed during assessment');
    return { ...result, engineVersion: (await command(tool.path, ['--version'])).split('\n')[0] ?? 'unavailable', resultSha256: createHash('sha256').update(rawReport).digest('hex') };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
