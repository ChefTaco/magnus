/** Bounded read-only package mapping evidence. Never reads process arguments or environments. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { open, opendir, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const exec = promisify(execFile);
const packageName = z.string().max(200).regex(/^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?$/);
const limits = { packages: 32, files: 4096, processes: 8192, mapBytes: 262144, consumers: 256, consumerBytes: 65536, milliseconds: 5000 };
export interface ActivationFile { path: string; device: string; inode: string }
export interface ActivationSystem {
  metadata(name: string): Promise<{ version: string; paths: string[] }>;
  file(path: string): Promise<ActivationFile | null>;
  pids(): Promise<number[]>;
  identity(pid: number): Promise<string>;
  maps(pid: number): Promise<string>;
  now(): number;
}
async function dpkg(args: string[]): Promise<string> {
  return (await exec('/usr/bin/dpkg-query', args, { timeout: 5000, maxBuffer: 512 * 1024, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } })).stdout;
}
async function boundedRead(path: string, max: number): Promise<string> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const chunks: Buffer[] = []; let size = 0;
    for (;;) { const bytes = Buffer.alloc(Math.min(8192, max - size + 1)); const { bytesRead } = await fd.read(bytes, 0, bytes.length, null); if (!bytesRead) break; size += bytesRead; if (size > max) throw new Error('READ_LIMIT'); chunks.push(bytes.subarray(0, bytesRead)); }
    return Buffer.concat(chunks).toString('utf8');
  }
  finally { await fd.close(); }
}
const system: ActivationSystem = {
  metadata: async name => ({ version: (await dpkg(['-W', '-f=${Version}', name])).trim(), paths: (await dpkg(['-L', name])).trim().split('\n') }),
  file: async path => {
    const canonical = await realpath(path); const info = await stat(canonical, { bigint: true });
    if (!info.isFile()) return null;
    const major = (info.dev >> 8n & 0xfffn) | (info.dev >> 32n & ~0xfffn);
    const minor = (info.dev & 0xffn) | (info.dev >> 12n & ~0xffn);
    return { path: canonical, device: `${major}:${minor}`, inode: info.ino.toString() };
  },
  pids: async () => { const pids: number[] = []; for await (const entry of await opendir('/proc')) if (/^\d+$/.test(entry.name)) { pids.push(Number(entry.name)); if (pids.length > limits.processes) break; } return pids; },
  identity: async pid => { const value = await boundedRead(`/proc/${pid}/stat`, 8192); const end = value.lastIndexOf(') '); if (end < 0) throw new Error('PROCESS_IDENTITY_FORMAT'); return z.string().regex(/^\d+$/).parse(value.slice(end + 2).trim().split(/\s+/)[19]); },
  maps: async pid => boundedRead(`/proc/${pid}/maps`, limits.mapBytes),
  now: () => performance.now(),
};
const fileSchema = z.object({ path: z.string().startsWith('/').max(512).regex(/^[^\u0000-\u001f\u007f\\]+$/).refine(path => !path.endsWith(' (deleted)')), device: z.string().regex(/^\d+:\d+$/), inode: z.string().regex(/^\d+$/) }).strict();
const consumerSchema = z.object({ pid: z.number().int().positive(), processStartTicks: z.string().regex(/^\d+$/), path: fileSchema.shape.path, mappedDevice: z.string(), mappedInode: z.string(), installedDevice: z.string(), installedInode: z.string(), state: z.enum(['current', 'stale']) }).strict();
export const packageActivationSchema = z.object({
  version: z.literal(1), method: z.literal('userspace-package-mappings.v1'),
  scope: z.literal('Installed package file mappings only; not kernel, firmware, cached interpreted code or effective configuration'),
  requestedPackages: z.array(packageName), observedAt: z.iso.datetime(), coverage: z.enum(['complete', 'partial']), state: z.enum(['no-stale-mappings-observed', 'stale-mappings-observed', 'unknown']),
  packages: z.array(z.object({ name: packageName, installedVersion: z.string().nullable(), manifestSha256: z.string().nullable(), filesExamined: z.number().int(), consumers: z.array(consumerSchema) }).strict()),
  processesExamined: z.number().int(), disappearedProcesses: z.number().int(), failures: z.array(z.string()), limits: z.object({ packages: z.number(), files: z.number(), processes: z.number(), mapBytes: z.number(), consumers: z.number(), consumerBytes: z.number(), milliseconds: z.number() }).strict(),
}).strict();
const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function disappeared(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'; }

export async function packageActivation(input: readonly string[], host: ActivationSystem = system) {
  const names = [...new Set(z.array(packageName).max(200).parse(input))].sort(); const started = host.now();
  const failures = new Set<string>(); let partial = false;
  const fail = (reason: string): void => { partial = true; if (failures.size < 100) failures.add(reason); };
  const outOfTime = (): boolean => { if (host.now() - started < limits.milliseconds) return false; fail('ACTIVATION_TIME_LIMIT'); return true; };
  const metadata = async (name: string, pathLimit: number) => {
    const raw = await host.metadata(name); const version = z.string().min(1).max(200).regex(/^[A-Za-z0-9.+:~_-]+$/).parse(raw.version); const files: ActivationFile[] = []; const known = new Set<string>();
    const paths = [...new Set(raw.paths)].sort(); if (paths.length > pathLimit) fail(`PACKAGE_FILE_LIMIT:${name}`);
    for (const path of paths.slice(0, pathLimit)) {
      if (outOfTime()) break;
      if (!fileSchema.shape.path.safeParse(path).success || path.split('/').includes('..')) { fail(`UNSUPPORTED_PACKAGE_PATH:${name}`); continue; }
      try { const file = await host.file(path); if (file) { const parsed = fileSchema.parse(file); const key = fingerprint(parsed); if (!known.has(key)) { known.add(key); files.push(parsed); } } }
      catch { fail(`PACKAGE_FILE_UNAVAILABLE:${name}`); }
    }
    files.sort((a, b) => a.path.localeCompare(b.path) || a.inode.localeCompare(b.inode));
    return { version, files, pathLimit, pathsExamined: Math.min(paths.length, pathLimit), digest: fingerprint({ version, files }) };
  };
  if (!names.length) fail('NO_PACKAGES_REQUESTED');
  if (names.length > limits.packages) fail('PACKAGE_COUNT_LIMIT');
  const packages: { name: string; installedVersion: string | null; manifestSha256: string | null; filesExamined: number; consumers: z.infer<typeof consumerSchema>[] }[] = [];
  const selected = new Map<string, { version: string; files: ActivationFile[]; digest: string; pathLimit: number; pathsExamined: number }>(); let remainingFiles = limits.files;
  for (const name of names.slice(0, limits.packages)) {
    if (outOfTime()) break;
    try { const value = await metadata(name, remainingFiles); selected.set(name, value); remainingFiles -= value.pathsExamined; } catch { fail(`PACKAGE_METADATA_UNAVAILABLE:${name}`); }
    const value = selected.get(name); packages.push({ name, installedVersion: value?.version ?? null, manifestSha256: value?.digest ?? null, filesExamined: value?.files.length ?? 0, consumers: [] });
  }
  const filesByPath = new Map<string, { pkg: (typeof packages)[number]; file: ActivationFile }[]>();
  for (const pkg of packages) for (const file of selected.get(pkg.name)?.files ?? []) { const entries = filesByPath.get(file.path) ?? []; entries.push({ pkg, file }); filesByPath.set(file.path, entries); }
  let initial: number[] = []; let processesExamined = 0; let disappearedProcesses = 0; let consumerCount = 0; let resultBytes = 0;
  try { initial = z.array(z.number().int().positive().max(2147483647)).parse(await host.pids()).sort((a, b) => a - b); }
  catch { fail('PROCESS_INVENTORY_UNAVAILABLE'); }
  if (initial.length > limits.processes) fail('PROCESS_COUNT_LIMIT');
  const seen = new Set<string>(); const identities = new Map<number, string>();
  outer: for (const pid of initial.slice(0, limits.processes)) {
    if (outOfTime()) break;
    let maps: string; let identity: string;
    try {
      identity = z.string().regex(/^\d+$/).max(100).parse(await host.identity(pid));
      maps = await host.maps(pid); if (Buffer.byteLength(maps) > limits.mapBytes) { fail(`PROCESS_MAP_LIMIT:${pid}`); continue; }
      if (await host.identity(pid) !== identity) { fail(`PROCESS_IDENTITY_CHANGED:${pid}`); continue; }
      identities.set(pid, identity);
    }
    catch (error) { if (disappeared(error)) disappearedProcesses++; else fail(`PROCESS_MAP_UNAVAILABLE:${pid}`); continue; }
    processesExamined++;
    for (const line of maps.split('\n').filter(Boolean)) {
      if (outOfTime()) break outer;
      const match = /^[\da-f]{1,16}-[\da-f]{1,16}\s+[r-][w-][x-][ps]\s+[\da-f]{1,16}\s+([\da-f]{1,8}):([\da-f]{1,8})\s+(\d{1,20})(?:\s+(.*))?$/.exec(line);
      if (!match) { fail(`PROCESS_MAP_FORMAT:${pid}`); continue; }
      const [, major, minor, inode, rawPath] = match; if (!major || !minor || !inode || !rawPath?.startsWith('/')) continue;
      const deleted = rawPath.endsWith(' (deleted)');
      const path = (deleted ? rawPath.slice(0, -10) : rawPath).replace(/\\([0-7]{3})/g, (_match: string, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
      const device = `${BigInt('0x' + major)}:${BigInt('0x' + minor)}`; let attributed = false;
      for (const { pkg, file } of filesByPath.get(path) ?? []) {
        attributed = true;
        const key = fingerprint([pkg.name, pid, path, device, inode]); if (seen.has(key)) continue; seen.add(key);
        const value = consumerSchema.parse({ pid, processStartTicks: identity, path, mappedDevice: device, mappedInode: inode, installedDevice: file.device, installedInode: file.inode, state: deleted || file.device !== device || file.inode !== inode ? 'stale' : 'current' });
        const size = Buffer.byteLength(JSON.stringify(value));
        if (++consumerCount > limits.consumers || resultBytes + size > limits.consumerBytes) { fail('CONSUMER_EVIDENCE_LIMIT'); break outer; }
        resultBytes += size; pkg.consumers.push(value);
      }
      // A removed/renamed old library may no longer occur in current dpkg metadata.
      // Its ownership cannot be guessed; it blocks a claim of complete activation.
      if (deleted && !attributed) fail(`UNATTRIBUTED_DELETED_MAPPING:${pid}`);
    }
  }
  try {
    const final = z.array(z.number().int().positive().max(2147483647)).parse(await host.pids());
    for (const pid of final.slice(0, limits.processes)) {
      if (outOfTime()) break;
      if (!identities.has(pid)) { fail('NEW_UNEXAMINED_PROCESS'); continue; }
      try { if (await host.identity(pid) !== identities.get(pid)) fail(`PROCESS_IDENTITY_CHANGED:${pid}`); }
      catch (error) { if (!disappeared(error)) fail(`FINAL_PROCESS_IDENTITY_UNAVAILABLE:${pid}`); }
    }
    if (final.length > limits.processes) fail('FINAL_PROCESS_COUNT_LIMIT');
  }
  catch { fail('FINAL_PROCESS_INVENTORY_UNAVAILABLE'); }
  for (const [name, before] of selected) {
    if (outOfTime()) break;
    try { if ((await metadata(name, before.pathLimit)).digest !== before.digest) fail(`PACKAGE_CHANGED_DURING_OBSERVATION:${name}`); }
    catch { fail(`FINAL_PACKAGE_METADATA_UNAVAILABLE:${name}`); }
  }
  const stale = packages.some(pkg => pkg.consumers.some(consumer => consumer.state === 'stale'));
  return packageActivationSchema.parse({ version: 1, method: 'userspace-package-mappings.v1', scope: 'Installed package file mappings only; not kernel, firmware, cached interpreted code or effective configuration', requestedPackages: names, observedAt: new Date().toISOString(), coverage: partial ? 'partial' : 'complete', state: stale ? 'stale-mappings-observed' : partial ? 'unknown' : 'no-stale-mappings-observed', packages, processesExamined, disappearedProcesses, failures: [...failures], limits });
}
