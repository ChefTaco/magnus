import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const object = (value: unknown): Record<string, unknown> => z.record(z.string(), z.unknown()).parse(value);
const list = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? z.array(z.unknown()).parse(value) : [value];
const text = (value: unknown): string => {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  const parsed = z.object({ '#text': z.union([z.string(), z.number()]) }).safeParse(value);
  return parsed.success ? String(parsed.data['#text']) : '';
};
function parseXml(input: string): Record<string, unknown> {
  if (Buffer.byteLength(input) > 160 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(input)) throw new Error('Unsupported or oversized vendor XML');
  return object(new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, processEntities: false, parseTagValue: false }).parse(input));
}
function testRefs(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) testRefs(item, found);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(object(value))) { if (key === '@_test_ref') found.add(z.string().parse(item)); else testRefs(item, found); }
  return found;
}
/** OpenSCAP makes applicability decisions, including Debian version/backport semantics.
 * This parser only joins its evaluated tests and collected package items to vendor
 * definitions; it never compares versions or treats an unevaluated item as clean. */
export function normalizeUbuntuOval(definitionsXml: string, resultsXml: string, now = new Date()) {
  const definitions = object(parseXml(definitionsXml)['oval_definitions']);
  const generator = object(definitions['generator']);
  const date = text(generator['timestamp']); const generatedAt = new Date(date.endsWith('Z') || /[+-]\d\d:\d\d$/.test(date) ? date : date + 'Z').toISOString();
  const root = object(parseXml(resultsXml)['oval_results']);
  const system = object(object(root['results'])['system']);
  const evaluated = new Map(list(object(system['definitions'])['definition']).map(value => { const row = object(value); return [z.string().parse(row['@_definition_id']), row]; }));
  const tests = new Map(list(object(system['tests'])['test']).map(value => { const row = object(value); return [z.string().parse(row['@_test_id']), row]; }));
  const items = new Map(list(object(object(system['oval_system_characteristics'])['system_data'])['dpkginfo_item']).map(value => { const row = object(value); return [z.string().parse(row['@_id']), row]; }));
  const sourceTests = new Map(list(object(definitions['tests'])['dpkginfo_test']).map(value => { const row = object(value); return [z.string().parse(row['@_id']), row]; }));
  const states = new Map(list(object(definitions['states'])['dpkginfo_state']).map(value => { const row = object(value); return [z.string().parse(row['@_id']), row]; }));
  const failures: string[] = []; const advisories = [];
  for (const raw of list(object(definitions['definitions'])['definition'])) {
    const definition = object(raw); if (definition['@_class'] !== 'patch' && definition['@_class'] !== 'vulnerability') continue;
    const definitionId = z.string().parse(definition['@_id']); const outcome = evaluated.get(definitionId)?.['@_result'];
    if (outcome !== 'true' && outcome !== 'false' && outcome !== 'not applicable') failures.push(definitionId);
    if (outcome !== 'true') continue;
    const metadata = object(definition['metadata']); const advisory = object(metadata['advisory'] ?? {});
    const packages = [];
    for (const ref of testRefs(definition['criteria'])) {
      const test = tests.get(ref); const source = sourceTests.get(ref); if (!test || !source || test['@_result'] !== 'true') continue;
      const fixes = list(source['state']).flatMap(value => { const state = states.get(z.string().parse(object(value)['@_state_ref'])); const evr = state?.['evr']; const parsed = z.record(z.string(), z.unknown()).safeParse(evr); return parsed.success && parsed.data['@_operation'] === 'less than' ? [text(evr)] : []; });
      for (const rawItem of list(test['tested_item'])) {
        const row = object(rawItem); if (row['@_result'] !== 'true') continue;
        const item = items.get(z.string().parse(row['@_item_id'])); if (!item || item['@_status'] !== 'exists') continue;
        packages.push({ name: text(item['name']), installedVersion: text(item['evr']) || text(item['version']), architecture: text(item['arch']), fixedVersions: fixes });
      }
    }
    if (!packages.length) failures.push(definitionId + ':package-evidence-unresolved');
    const references = list(metadata['reference']).map(value => { const row = object(value); return { source: text(row['@_source']), id: text(row['@_ref_id']), url: text(row['@_ref_url']) }; });
    const cves = [...new Set([...references.filter(row => row.source === 'CVE').map(row => row.id), ...list(advisory['cve']).map(text)].filter(value => /^CVE-\d{4}-\d{4,}$/.test(value)))];
    advisories.push({ definitionId, title: text(metadata['title']), severity: text(advisory['severity']), references, cves, packages, vendorDecision: 'affected' });
  }
  const stale = now.getTime() - Date.parse(generatedAt) > 48 * 3600000 || Date.parse(generatedAt) > now.getTime() + 120000;
  return { engine: 'OpenSCAP', vendor: 'Ubuntu', platform: 'ubuntu-24.04', feed: { url: 'https://security-metadata.canonical.com/oval/com.ubuntu.noble.usn.oval.xml.bz2', generatedAt, sha256: createHash('sha256').update(definitionsXml).digest('hex') }, observedAt: now.toISOString(), coverage: stale ? 'stale' : failures.length ? 'partial' : 'complete', failures, advisories, definitionCount: evaluated.size };
}
const exec = promisify(execFile);
export async function assessUbuntuOval() {
  const directory = await mkdtemp('/var/tmp/embermend-oval-');
  try {
    const response = await fetch('https://security-metadata.canonical.com/oval/com.ubuntu.noble.usn.oval.xml.bz2', { redirect: 'error', signal: AbortSignal.timeout(60000) });
    if (!response.ok || !response.body) throw new Error('Ubuntu vendor feed unavailable');
    let size = 0; const chunks: Uint8Array[] = [];
    for await (const chunk of response.body) { size += chunk.length; if (size > 16 * 1024 * 1024) throw new Error('Vendor feed size exceeded'); chunks.push(chunk); }
    const compressed = join(directory, 'vendor.xml.bz2'); const input = join(directory, 'vendor.xml'); const output = join(directory, 'results.xml');
    await writeFile(compressed, Buffer.concat(chunks), { mode: 0o600 });
    const decompressed = await exec('/usr/bin/bzip2', ['--decompress', '--stdout', compressed], { timeout: 30000, maxBuffer: 80 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
    if (/<!DOCTYPE|<!ENTITY/i.test(decompressed.stdout)) throw new Error('External XML entities refused');
    await writeFile(input, decompressed.stdout, { mode: 0o600 });
    // Exit 2 means evaluated definitions matched; it is not an evaluator failure.
    try { await exec('/usr/bin/oscap', ['oval', 'eval', '--results', output, input], { timeout: 600000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } }); }
    catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 2) throw error; }
    if ((await stat(output)).size > 160 * 1024 * 1024) throw new Error('OpenSCAP result size exceeded');
    const result = await readFile(output);
    const normalized = normalizeUbuntuOval(decompressed.stdout, result.toString('utf8'));
    const engineVersion = (await exec('/usr/bin/oscap', ['--version'], { timeout: 10000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin' } })).stdout.split('\n')[0] ?? 'unavailable';
    return { ...normalized, engineVersion, resultSha256: createHash('sha256').update(result).digest('hex') };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
