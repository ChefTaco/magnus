/** Bounded observation of existing Linux scheduler sources. Never starts a manager. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { z } from 'zod';
import { constants } from 'node:fs';
import { hash, readJson } from './execution-supervisor-state.js';
const exec = promisify(execFile);
async function boundedSchedulerFile(path: string, maximum: number) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.size > maximum) throw new Error('Scheduler source exceeded bound or is not a regular file');
    const buffer = Buffer.alloc(maximum + 1); let used = 0;
    while (used < buffer.length) { const result = await fd.read(buffer, used, buffer.length - used, null); if (!result.bytesRead) break; used += result.bytesRead; }
    if (used > maximum) throw new Error('Scheduler source exceeded bound'); return { content: buffer.subarray(0, used), info };
  } finally { await fd.close(); }
}
export async function boundedSchedulerRead(path: string, maximum = 256 * 1024): Promise<Buffer> {
  return (await boundedSchedulerFile(path, maximum)).content;
}
export interface Account { name: string; uid: number; home: string }
export interface DiscoveryBlocker { identityVersion: 2; kind: string; sourceSha256: string; count: number }
export type DiscoveryBlockerInput = Omit<DiscoveryBlocker, 'identityVersion'> & { identityVersion?: 2 };
export interface SchedulerMemberEvidence {
  member: string; type: 'file' | 'symlink-file' | 'optional-file-absent'; mode: number; uid: number; gid: number; nlink: number;
  size: number; contentSha256: string; linkTargetSha256?: string;
}
const MAX_DISCOVERY_MEMBERS = 4096;
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
export function schedulerContentDigest(value: string | Buffer, maximum = 1024 * 1024): string {
  const content = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16 * 1024 * 1024 || content.length > maximum)
    throw new Error('Scheduler digest content bound exceeded');
  return hash(Buffer.concat([Buffer.from('magnus.scheduler-content.v2\0'), content]));
}
export function schedulerMembersDigest(members: string[]): string {
  if (members.length > MAX_DISCOVERY_MEMBERS || members.some(member => Buffer.byteLength(member) > 4096 || /[\x00-\x1f]/.test(member)))
    throw new Error('Scheduler digest member bound exceeded');
  const canonical = [...members].sort(compareText);
  return hash(JSON.stringify({ domain: 'magnus.scheduler-members.v2', members: canonical }));
}
export async function boundedSchedulerMemberEvidence(path: string, member = path, maximum = 256 * 1024): Promise<SchedulerMemberEvidence> {
  if (Buffer.byteLength(member) > 4096 || /[\x00-\x1f]/.test(member)) throw new Error('Scheduler evidence member is not canonical');
  const { content, info } = await boundedSchedulerFile(path, maximum);
  return { member, type: 'file', mode: info.mode & 0o7777, uid: info.uid, gid: info.gid, nlink: info.nlink,
    size: content.length, contentSha256: schedulerContentDigest(content, maximum) };
}
export function schedulerMemberEvidenceDigest(members: SchedulerMemberEvidence[]): string {
  if (!members.length || members.length > MAX_DISCOVERY_MEMBERS) throw new Error('Scheduler evidence member bound exceeded');
  const canonical = [...members].sort((a, b) => compareText(a.member, b.member));
  if (new Set(canonical.map(member => member.member)).size !== canonical.length) throw new Error('Duplicate scheduler evidence member');
  return hash(JSON.stringify({ domain: 'magnus.scheduler-member-evidence.v2', members: canonical }));
}
export function aggregateSchedulerBlockers(rows: DiscoveryBlockerInput[]): DiscoveryBlocker[] {
  const combined = new Map<string, DiscoveryBlocker>();
  for (const row of rows) {
    if (!/^[A-Z_]{1,80}$/.test(row.kind) || !/^[a-f0-9]{64}$/.test(row.sourceSha256)
      || !Number.isSafeInteger(row.count) || row.count < 1) throw new Error('Invalid scheduler blocker');
    const key = row.kind + ':' + row.sourceSha256; const prior = combined.get(key);
    const count = (prior?.count ?? 0) + row.count;
    if (count > 1_000_000) throw new Error('Scheduler blocker count bound exceeded');
    combined.set(key, { identityVersion: 2, kind: row.kind, sourceSha256: row.sourceSha256, count });
  }
  if (combined.size > 1024) throw new Error('Scheduler blocker inventory bound exceeded');
  return [...combined.values()].sort((a, b) => compareText(a.kind, b.kind) || compareText(a.sourceSha256, b.sourceSha256));
}
export interface DiscoveryOptions {
  accounts?: Account[]; run?: (command: string, args: string[]) => Promise<string>;
  runtimeRoot?: string; globalUserUnits?: string[]; procRoot?: string;
  coverageRoot?: string; now?: () => number;
}
export function parseSchedulerAccounts(text: string): Account[] {
  const rows = text.trim().split('\n').filter(Boolean);
  if (rows.length > 256) throw new Error('Account inventory bound exceeded');
  return rows.map(line => {
    const fields = line.split(':'); const uid = Number(fields[2]);
    if (fields.length !== 7 || !/^[a-zA-Z0-9_.-]+\$?$/.test(fields[0]!) || !Number.isSafeInteger(uid) || uid < 0 || !fields[5]?.startsWith('/')) throw new Error('Account inventory malformed');
    return { name: fields[0]!, uid, home: fields[5] };
  });
}
/** Only these installed package-service shell forms have statically bounded
 * executable inputs. This does not make their foreign timers managed jobs. */
export function boundedTimerInlineSources(executable: string, argv: string):
    { paths: string[]; commands: string[]; mdmonitor: boolean } | null {
  const shell = ['sh', '/bin/sh', '/usr/bin/sh', '/bin/bash', '/usr/bin/bash'].includes(executable)
    ? executable : null;
  if (!shell || !argv.startsWith(shell + ' -c ')) return null;
  const body = argv.slice(shell.length + 4);
  if (['sh', '/bin/sh', '/usr/bin/sh'].includes(shell)
    && body === '[ "$AUTOSCAN" != "true" ] || /sbin/mdadm --monitor --oneshot --scan')
    return { paths: ['/sbin/mdadm'], commands: shell === 'sh' ? ['sh'] : [], mdmonitor: true };
  const collector = '(/usr/share/prometheus-node-exporter-collectors/[a-zA-Z0-9_.-]+)';
  const target = '(/var/lib/prometheus/node-exporter/[a-zA-Z0-9_.-]+\\.prom)';
  const simple = new RegExp('^' + collector + ' \\| sponge ' + target + '$').exec(body);
  if (simple) return { paths: [simple[1]!, ...(shell.startsWith('/') ? [shell] : [])],
    commands: ['sponge', ...(shell.startsWith('/') ? [] : [shell])], mdmonitor: false };
  const sensor = new RegExp('^/usr/bin/ipmitool sensor \\| ' + collector + ' \\| sponge ' + target + '$').exec(body);
  if (sensor) return { paths: ['/usr/bin/ipmitool', sensor[1]!, ...(shell.startsWith('/') ? [shell] : [])],
    commands: ['sponge', ...(shell.startsWith('/') ? [] : [shell])], mdmonitor: false };
  return null;
}
export async function discoverSchedulerSources(options: DiscoveryOptions = {}) {
  const issues: string[] = []; const blockers: DiscoveryBlockerInput[] = []; const sources: Record<string, string> = {};
  const homes = new Set<string>(); const hermesRoots = new Set<string>();
  const now = options.now ?? Date.now; const deadline = now() + 10_000;
  const check = () => { if (now() >= deadline) throw new Error('Scheduler discovery deadline'); };
  const run = options.run ?? (async (command, args) => {
    check(); return (await exec(command, args, { timeout: Math.max(1, Math.min(2000, deadline - now())), maxBuffer: 256 * 1024 })).stdout;
  });
  const blockEvidence = (kind: string, evidence: SchedulerMemberEvidence[], count = evidence.length) => {
    if (count) blockers.push({ kind, sourceSha256: schedulerMemberEvidenceDigest(evidence), count });
  };
  const issue = (kind: string, path = '') => issues.push(kind + (path ? ':' + hash(path) : ''));
  async function text(path: string, optional = true) {
    try {
      check(); const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) throw new Error('Unsupported source');
      const raw = (await boundedSchedulerRead(path)).toString('utf8'); sources[hash(path)] = schedulerContentDigest(raw); return raw;
    } catch (error) { if (!optional || (error as NodeJS.ErrnoException).code !== 'ENOENT') issue('SCHEDULER_SOURCE_UNREADABLE', path); return undefined; }
  }
  let timerEvidenceMembers = 0; let timerEvidenceBytes = 0;
  async function timerFileEvidence(path: string, member = path, maximum = 256 * 1024): Promise<SchedulerMemberEvidence> {
    if (timerEvidenceMembers >= MAX_DISCOVERY_MEMBERS || timerEvidenceBytes >= 64 * 1024 * 1024)
      throw new Error('Timer evidence aggregate bound exceeded');
    check(); const info = await lstat(path);
    let evidence: SchedulerMemberEvidence;
    if (info.isSymbolicLink()) {
      const before = await readlink(path);
      if (Buffer.byteLength(before) > 4096 || /[\x00-\x1f]/.test(before)) throw new Error('Timer alias target bound exceeded');
      const target = await realpath(path); const targetEvidence = await boundedSchedulerMemberEvidence(target, member, maximum);
      if (await readlink(path) !== before || !(await lstat(path)).isSymbolicLink()) throw new Error('Timer alias changed during observation');
      evidence = { ...targetEvidence, type: 'symlink-file', mode: info.mode & 0o7777, uid: info.uid, gid: info.gid,
        nlink: info.nlink, linkTargetSha256: schedulerContentDigest(before) };
    } else evidence = await boundedSchedulerMemberEvidence(path, member, maximum);
    timerEvidenceMembers++; timerEvidenceBytes += evidence.size;
    if (timerEvidenceMembers > MAX_DISCOVERY_MEMBERS || timerEvidenceBytes > 64 * 1024 * 1024)
      throw new Error('Timer evidence aggregate bound exceeded');
    return evidence;
  }
  const timerNames = (raw: string) => {
    const lines = raw.split('\n').map(line => line.trim()).filter(Boolean);
    if (lines.length > 512) throw new Error('Timer unit inventory bound exceeded');
    return lines.map(line => {
      const name = line.split(/\s+/)[0];
      if (!name || !/^[a-zA-Z0-9@_.:\\-]+\.timer$/.test(name)) throw new Error('Timer unit inventory malformed');
      return name;
    });
  };
  const timerProperties = (raw: string, repeatable = new Set<string>()) => {
    if (Buffer.byteLength(raw) > 64 * 1024) throw new Error('Timer property bound exceeded');
    const properties = new Map<string, string>();
    for (const line of raw.split('\n').filter(Boolean)) {
      const split = line.indexOf('='); if (split < 1) throw new Error('Timer property malformed');
      const key = line.slice(0, split); if (properties.has(key) && !repeatable.has(key)) throw new Error('Duplicate timer property');
      properties.set(key, properties.has(key) ? properties.get(key) + '\n' + line.slice(split + 1) : line.slice(split + 1));
    }
    return properties;
  };
  async function exactTimerInventory(scope: string[], kind: string, issuePrefix: string, sourceKey: string) {
    try {
      const activeRaw = await run('/usr/bin/systemctl', [...scope, 'list-units', '--type=timer',
        '--state=active,activating,reloading', '--all', '--plain', '--no-legend', '--no-pager']);
      const enabledRaw = await run('/usr/bin/systemctl', [...scope, 'list-unit-files', '--type=timer',
        '--state=enabled,enabled-runtime', '--plain', '--no-legend', '--no-pager']);
      sources[sourceKey] = schedulerContentDigest(JSON.stringify([activeRaw, enabledRaw]));
      const names = [...new Set([...timerNames(activeRaw), ...timerNames(enabledRaw)])].sort(compareText);
      for (const name of names) {
        try {
          const showArgs = [...scope, 'show', name, '--no-pager', '--property=Id', '--property=Names', '--property=LoadState',
            '--property=FragmentPath', '--property=DropInPaths', '--property=ActiveState', '--property=UnitFileState', '--property=Unit'];
          const raw = await run('/usr/bin/systemctl', showArgs); const properties = timerProperties(raw);
          const id = properties.get('Id') ?? ''; const aliases = (properties.get('Names') ?? '').split(/\s+/).filter(Boolean);
          const activeState = properties.get('ActiveState') ?? ''; const unitFileState = properties.get('UnitFileState') ?? '';
          const isActive = ['active', 'activating', 'reloading'].includes(activeState);
          const isEnabled = ['enabled', 'enabled-runtime'].includes(unitFileState);
          const fragment = properties.get('FragmentPath') ?? '';
          const triggeredService = properties.get('Unit') ?? '';
          if ((!aliases.includes(name) && id !== name) || properties.get('LoadState') !== 'loaded' || (!isActive && !isEnabled)
            || !fragment.startsWith('/') || normalize(fragment) !== fragment || /[\x00-\x1f]/.test(fragment)
            || !/^[a-zA-Z0-9@_.:\-]+\.service$/.test(triggeredService))
            throw new Error('Timer identity could not be resolved');
          const dropInsRaw = properties.get('DropInPaths') ?? '';
          const dropIns = dropInsRaw ? dropInsRaw.split(/\s+/) : [];
          if (dropIns.length > 64 || dropIns.some(path => !path.startsWith('/') || normalize(path) !== path || /[\\\x00-\x1f]/.test(path)))
            throw new Error('Timer drop-in identity could not be resolved');
          const state = `active:${activeState}:unit-file:${unitFileState}:id:${id}`;
          const evidence = [await timerFileEvidence(fragment, `timer:${name}:${state}:fragment:${fragment}`)];
          for (const path of [...new Set(dropIns)].sort(compareText))
            evidence.push(await timerFileEvidence(path, `timer:${name}:${state}:drop-in:${path}`));
          // A timer's bytes do not identify the work it starts. Bind the
          // triggered service and every effective drop-in to the same source.
          const serviceShowArgs = [...scope, 'show', triggeredService, '--no-pager', '--property=Id', '--property=Names',
            '--property=LoadState', '--property=FragmentPath', '--property=DropInPaths', '--property=ExecStart',
            '--property=ExecStartPre', '--property=ExecStartPost', '--property=ExecCondition', '--property=EnvironmentFiles',
            '--property=Environment', '--property=PassEnvironment', '--property=ExecSearchPath',
            '--property=RootDirectory', '--property=RootImage', '--property=BindPaths',
            '--property=BindReadOnlyPaths', '--property=TemporaryFileSystem',
            '--property=ExtensionImages', '--property=ExtensionDirectories',
            '--property=User', '--property=Group'];
          const serviceRaw = await run('/usr/bin/systemctl', serviceShowArgs);
          const service = timerProperties(serviceRaw, new Set(['ExecStart', 'ExecStartPre', 'ExecStartPost', 'ExecCondition', 'EnvironmentFiles']));
          const serviceAliases = (service.get('Names') ?? '').split(/\s+/).filter(Boolean);
          const serviceFragment = service.get('FragmentPath') ?? '';
          const serviceDropInsRaw = service.get('DropInPaths') ?? '';
          const serviceDropIns = serviceDropInsRaw ? serviceDropInsRaw.split(/\s+/) : [];
          if ((!serviceAliases.includes(triggeredService) && service.get('Id') !== triggeredService)
            || service.get('LoadState') !== 'loaded' || !serviceFragment.startsWith('/')
            || normalize(serviceFragment) !== serviceFragment || /[\x00-\x1f]/.test(serviceFragment)
            || serviceDropIns.length > 64 || serviceDropIns.some(path => !path.startsWith('/')
              || normalize(path) !== path || /[\\\x00-\x1f]/.test(path)))
            throw new Error('Triggered service identity could not be resolved');
          evidence.push(await timerFileEvidence(serviceFragment,
            `service:${triggeredService}:fragment:${serviceFragment}`));
          for (const path of [...new Set(serviceDropIns)].sort(compareText))
            evidence.push(await timerFileEvidence(path, `service:${triggeredService}:drop-in:${path}`));
          // EnvironmentFile contents can change what a timer executes even
          // while its unit bytes stay fixed. Bind files and explicit optional
          // absence; a later creation then changes the blocker identity.
          const absentEnvironmentFiles: string[] = [];
          const presentEnvironmentFiles: string[] = [];
          const environmentRecords = (service.get('EnvironmentFiles') ?? '').split('\n').filter(Boolean);
          if (environmentRecords.length > 64) throw new Error('Triggered service environment files are unbounded');
          for (const record of environmentRecords) {
            const match = /^(\/[a-zA-Z0-9_./-]+) \(ignore_errors=(yes|no)\)$/.exec(record);
            const path = match?.[1];
            if (!path || normalize(path) !== path) throw new Error('Triggered service environment file is unresolved');
            try {
              evidence.push(await timerFileEvidence(path, `environment:${triggeredService}:${path}`));
              presentEnvironmentFiles.push(path);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || match[2] !== 'yes') throw error;
              absentEnvironmentFiles.push(path);
              evidence.push({ member: `environment:${triggeredService}:${path}`, type: 'optional-file-absent',
                mode: 0, uid: 0, gid: 0, nlink: 0, size: 0, contentSha256: schedulerContentDigest('optional-file-absent') });
            }
          }
          const executionPaths = new Set<string>();
          const pathCommands = new Set<string>();
          let executionCommands = 0;
          let mdmonitorOnly = true;
          let prometheusCollectorOnly = true;
          for (const property of ['ExecStart', 'ExecStartPre', 'ExecStartPost', 'ExecCondition']) {
            const definition = service.get(property) ?? '';
            if (!definition) continue;
            // systemctl repeats ExecStart for multi-command oneshots. A command
            // record can itself contain ${...} or shell braces in argv[].
            const commands = definition.split('\n');
            if (!commands.length || commands.length > 32) throw new Error('Triggered service command is unresolved');
            for (const command of commands) {
              const body = /^\{\s*([\s\S]*?)\s*\}$/.exec(command)?.[1];
              const executable = /^path=([^\s;]+)\s*;/.exec(body ?? '')?.[1];
              const argv = /(?:^|;)\s*argv\[\]=([\s\S]*?)(?=\s*;\s*(?:(?:ignore_errors|start_time|stop_time|pid|code|status)=|$))/.exec(body ?? '')?.[1] ?? '';
              if (!executable || (!executable.startsWith('/') && !/^[a-zA-Z0-9_.+-]+$/.test(executable)))
                throw new Error('Triggered service executable is unresolved');
              executionCommands++;
              const interpreter = /(?:^|\/)(?:node|python(?:[23](?:\.\d+)?)?|bash|sh|env)$/.test(executable);
              if (!interpreter && executable.startsWith('/')) executionPaths.add(executable);
              else if (!executable.startsWith('/')) pathCommands.add(executable);
              if (interpreter) {
                // Inline code and arbitrary shell expressions can open other
                // files or commands. Keep them unresolved unless a separate
                // parser can prove the entire expression and its inputs.
                if (/(?:^|\s)(?:-[a-zA-Z]*[ce][a-zA-Z]*|--(?:command|eval))(?:\s|=|$)/.test(argv)) {
                  const bounded = boundedTimerInlineSources(executable, argv);
                  if (!bounded) throw new Error('Inline interpreter command is unresolved');
                  for (const path of bounded.paths) executionPaths.add(path);
                  for (const name of bounded.commands) pathCommands.add(name);
                  mdmonitorOnly &&= bounded.mdmonitor;
                  prometheusCollectorOnly &&= !bounded.mdmonitor;
                  continue;
                }
                const scripts = [...argv.matchAll(/\/[a-zA-Z0-9_./-]+\.(?:m?js|py|sh)\b/g)].map(match => match[0]);
                if (!scripts.length || scripts.length > 16) throw new Error('Interpreter source is unresolved');
                for (const script of scripts) executionPaths.add(script);
              }
              mdmonitorOnly = false;
              prometheusCollectorOnly = false;
            }
          }
          if (!executionCommands || executionPaths.size > 128 || pathCommands.size > 32)
            throw new Error('Triggered service execution source is unresolved');
          if (pathCommands.size) {
            // A basename is searched by systemd at execution time. Bind every
            // candidate in its configured default and manager PATH; absent
            // candidates matter because an earlier new binary could win.
            // Unit-specific environment/PATH injection has no reliable static
            // resolution here, so retain an explicit unresolved identity.
            const boundedPrometheusEnvironment = prometheusCollectorOnly
              && /^(?:LC_ALL=C )?TMPDIR=\/var\/lib\/prometheus\/node-exporter$/.test(service.get('Environment') ?? '');
            if ((service.get('Environment') && !boundedPrometheusEnvironment)
              || (service.get('EnvironmentFiles') && !mdmonitorOnly)
              || service.get('PassEnvironment') || service.get('ExecSearchPath')
              || ['RootDirectory', 'RootImage', 'BindPaths', 'BindReadOnlyPaths', 'TemporaryFileSystem',
                'ExtensionImages', 'ExtensionDirectories'].some(key => service.get(key)))
              throw new Error('Custom execution search path is unresolved');
            if (mdmonitorOnly) for (const path of presentEnvironmentFiles) {
              // The exact mdmonitor expression quotes AUTOSCAN and invokes
              // mdadm by absolute path. Still reject a supplied PATH, which
              // could alter how systemd resolves the basename `sh`.
              const lines = (await boundedSchedulerRead(path)).toString('utf8').split('\n');
              if (lines.length > 4096 || lines.some(line => {
                const trimmed = line.trimStart();
                if (!trimmed || trimmed.startsWith('#')) return false;
                const key = /^([a-zA-Z_][a-zA-Z0-9_]*)=/.exec(trimmed)?.[1];
                return !key || key === 'PATH';
              })) throw new Error('Custom execution search path is unresolved');
            }
            const defaultPath = (await run('/usr/bin/systemd-path', ['search-binaries-default'])).trim();
            const managerEnvironment = await run('/usr/bin/systemctl', [...scope, 'show-environment']);
            const managerPath = managerEnvironment.split('\n').filter(line => line.startsWith('PATH='));
            if (managerPath.length > 1) throw new Error('Manager PATH is ambiguous');
            const directories = [...new Set([defaultPath, managerPath[0]?.slice(5) ?? '']
              .filter(Boolean).flatMap(value => value.split(':')))];
            if (!directories.length || directories.length > 32 || directories.some(path =>
              !path.startsWith('/') || normalize(path) !== path || /[\x00-\x1f\\]/.test(path)))
              throw new Error('Execution search path is unresolved');
            for (const command of [...pathCommands].sort(compareText)) {
              let present = 0;
              for (const directory of directories) {
                const path = join(directory, command);
                try {
                  evidence.push(await timerFileEvidence(path, `execution:${triggeredService}:candidate:${path}`, 16 * 1024 * 1024));
                  present++;
                }
                catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                  evidence.push({ member: `execution:${triggeredService}:candidate:${path}`, type: 'optional-file-absent',
                    mode: 0, uid: 0, gid: 0, nlink: 0, size: 0, contentSha256: schedulerContentDigest('execution-candidate-absent') });
                }
              }
              if (!present) throw new Error('No executable search candidate exists');
            }
            if ((await run('/usr/bin/systemd-path', ['search-binaries-default'])).trim() !== defaultPath
              || await run('/usr/bin/systemctl', [...scope, 'show-environment']) !== managerEnvironment)
              throw new Error('Execution search path changed during observation');
          }
          for (const path of [...executionPaths].sort(compareText))
            evidence.push(await timerFileEvidence(path, `execution:${triggeredService}:${path}`, 16 * 1024 * 1024));
          for (const path of presentEnvironmentFiles) {
            const member = `environment:${triggeredService}:${path}`;
            const original = evidence.find(row => row.member === member);
            if (!original || JSON.stringify(await timerFileEvidence(path, member)) !== JSON.stringify(original))
              throw new Error('Triggered service environment file changed during observation');
          }
          for (const path of absentEnvironmentFiles)
            try { await lstat(path); throw new Error('Optional environment file appeared during observation'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (await run('/usr/bin/systemctl', showArgs) !== raw
            || await run('/usr/bin/systemctl', serviceShowArgs) !== serviceRaw)
            throw new Error('Timer or triggered service identity changed during observation');
          sources[sourceKey + ':' + hash(name)] = schedulerContentDigest(JSON.stringify([raw, serviceRaw]));
          blockEvidence(kind, evidence, 1);
        } catch (error) {
          issue(issuePrefix + '_TIMER_IDENTITY_UNRECONCILABLE', name);
          // Keep the existing fail-closed issue and its stable identity. An
          // explicit shell command is a common operator-actionable case, but
          // never include the command or the raw exception in public evidence.
          if (error instanceof Error && error.message === 'Inline interpreter command is unresolved')
            issue(issuePrefix + '_TIMER_INLINE_INTERPRETER_UNRESOLVED', name);
        }
      }
    } catch { issue(issuePrefix + '_TIMER_INVENTORY_UNAVAILABLE'); }
  }
  const globalUserUnits = options.globalUserUnits ?? ['/etc/systemd/user', '/usr/local/lib/systemd/user', '/usr/lib/systemd/user', '/lib/systemd/user'];
  async function offlineEnabledUserTimers(path: string, unitRoots: string[], depth = 0) {
    try {
      if (depth > 5) throw new Error('User timer enablement depth exceeded');
      const rows = await readdir(path, { withFileTypes: true }); if (rows.length > 512) throw new Error('User timer enablement bound exceeded');
      for (const row of rows) {
        const child = join(path, row.name);
        if (row.isDirectory()) await offlineEnabledUserTimers(child, unitRoots, depth + 1);
        else if (row.isSymbolicLink() && row.name.endsWith('.timer') && /\.(?:wants|requires)$/.test(path)) {
          try {
            const evidence = [await timerFileEvidence(child)];
            const timerPaths = [child];
            for (const root of unitRoots) {
              const unit = join(root, row.name);
              try { evidence.push(await timerFileEvidence(unit)); timerPaths.push(unit); }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
              const dropIn = join(root, row.name + '.d');
              try {
                const files = await readdir(dropIn, { withFileTypes: true });
                if (files.length > 64) throw new Error('Offline timer drop-in bound exceeded');
                for (const file of files) if (file.name.endsWith('.conf')) {
                  const location = join(dropIn, file.name);
                  evidence.push(await timerFileEvidence(location)); timerPaths.push(location);
                }
              } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            }
            // Without a live user manager there is no effective Unit= property.
            // The default same-name service can be bound offline; any custom
            // mapping remains unreconcilable until its manager can attest it.
            for (const timerPath of timerPaths) {
              const contentBytes = await boundedSchedulerRead(await realpath(timerPath));
              if (schedulerContentDigest(contentBytes) !== evidence.find(member => member.member === timerPath)?.contentSha256)
                throw new Error('Offline timer changed during observation');
              const content = contentBytes.toString('utf8');
              if (/^\s*Unit\s*=/m.test(content)) throw new Error('Offline custom timer target is unresolved');
            }
            const serviceName = row.name.replace(/\.timer$/, '.service');
            let serviceFound = false;
            for (const root of unitRoots) {
              const service = join(root, serviceName);
              try { evidence.push(await timerFileEvidence(service)); serviceFound = true; }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
              const dropIn = join(root, serviceName + '.d');
              try {
                const files = await readdir(dropIn, { withFileTypes: true });
                if (files.length > 64) throw new Error('Offline service drop-in bound exceeded');
                for (const file of files) if (file.name.endsWith('.conf'))
                  evidence.push(await timerFileEvidence(join(dropIn, file.name)));
              } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            }
            if (!serviceFound) throw new Error('Offline timer service is unresolved');
            blockEvidence('USER_TIMER_OFFLINE_ENABLED', evidence, 1);
          } catch { issue('USER_TIMER_IDENTITY_UNRECONCILABLE', child); }
        }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issue('USER_TIMER_INVENTORY_UNAVAILABLE', path); }
  }
  let accounts: Account[] = [];
  try { accounts = options.accounts ?? parseSchedulerAccounts(await run('/usr/bin/getent', ['passwd'])); }
  catch { issue('SCHEDULER_ACCOUNT_DISCOVERY_UNAVAILABLE'); }
  for (const account of accounts) homes.add(account.home);
  await exactTimerInventory([], 'SYSTEM_TIMER_DEFINITION', 'SYSTEM', 'system-timer-units');
  for (const path of globalUserUnits) await offlineEnabledUserTimers(path, globalUserUnits);
  const active = new Set<number>();
  try {
    const raw = await run('/usr/bin/systemctl', ['list-units', '--all', '--plain', '--no-legend', '--no-pager', 'user@*.service']);
    sources['user-managers'] = schedulerContentDigest(raw);
    for (const line of raw.split('\n').filter(line => line.trim())) {
      const fields = line.trim().split(/\s+/); const match = /^user@(\d+)\.service$/.exec(fields[0] ?? '');
      if (!match || fields.length < 4) throw new Error('Unknown user manager observation');
      const uid = Number(match[1]);
      if (!accounts.some(account => account.uid === uid)) issue('USER_MANAGER_ACCOUNT_UNKNOWN');
      if (!['inactive', 'failed'].includes(fields[2]!)) active.add(uid);
      if (fields[2] === 'failed') issue('USER_MANAGER_FAILED_UNRECONCILABLE', fields[0]!);
    }
  } catch { issue('USER_MANAGER_INVENTORY_UNAVAILABLE'); }
  const runtime = options.runtimeRoot ?? '/run/user';
  for (const account of accounts) {
    try {
      check();
      const env = await text(join(account.home, '.hermes/.env'));
      for (const line of (env ?? '').split('\n')) {
        const match = /^\s*(?:export\s+)?HERMES_HOME\s*=\s*(.*?)\s*$/.exec(line); if (!match) continue;
        const value = match[1]!.replace(/^(['"])(.*)\1$/, '$2');
        if (!value.startsWith('/') || /[\x00-\x1f$`]/.test(value)) issue('CUSTOM_HERMES_HOME_UNRESOLVED'); else hermesRoots.add(value);
      }
      let bus = false;
      try { bus = (await lstat(join(runtime, String(account.uid), 'bus'))).isSocket(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issue('USER_BUS_UNREADABLE'); }
      if (active.has(account.uid) || bus) {
        if (!bus) issue('ACTIVE_USER_MANAGER_WITHOUT_OBSERVABLE_BUS');
        else await exactTimerInventory(['--user', '--machine=' + account.name + '@.host'], 'USER_TIMER_DEFINITION', 'USER', 'user-timer-units:' + account.uid);
      }
      if (!bus) {
        const userUnitRoots = [...globalUserUnits, join(account.home, '.config/systemd/user'),
          join(account.home, '.local/share/systemd/user'), join(runtime, String(account.uid), 'systemd/user')];
        for (const path of userUnitRoots.slice(globalUserUnits.length)) await offlineEnabledUserTimers(path, userUnitRoots);
      }
    } catch { issue('USER_SCHEDULER_OBSERVATION_UNAVAILABLE', account.home); }
  }
  // Observe custom active profile homes without exporting process arguments or
  // environment values. An unreadable process inventory is an explicit gap.
  try {
    const proc = options.procRoot ?? '/proc'; const processes = (await readdir(proc)).filter(name => /^\d+$/.test(name));
    if (processes.length > 4096) throw new Error('Process inventory limit');
    const processStart = async (pid: string) => {
      const stat = (await boundedSchedulerRead(join(proc, pid, 'stat'), 64 * 1024)).toString('utf8');
      const end = stat.lastIndexOf(') '); if (end < 0) throw new Error('Process stat malformed');
      const fields = stat.slice(end + 2).trim().split(/\s+/); const startedAt = fields[19];
      if (!/^[A-Z]$/.test(fields[0] ?? '') || !startedAt || !/^\d+$/.test(startedAt)) throw new Error('Process start identity unavailable');
      return startedAt;
    };
    for (const pid of processes) {
      check();
      try {
        const command = await boundedSchedulerRead(join(proc, pid, 'cmdline')); if (command.length > 256 * 1024) throw new Error('Process command bound');
        if (/(?:hermes|run_gateway\.py)/i.test(command.toString('utf8'))) {
          try {
            const startedAt = await processStart(pid);
            const member = await boundedSchedulerMemberEvidence(join(proc, pid, 'cmdline'), `process:${pid}:start:${startedAt}`);
            const verified = await boundedSchedulerRead(join(proc, pid, 'cmdline'));
            if (await processStart(pid) !== startedAt || schedulerContentDigest(verified) !== member.contentSha256
              || !/(?:hermes|run_gateway\.py)/i.test(verified.toString('utf8'))) throw new Error('Process identity changed during observation');
            blockEvidence('NATIVE_HERMES_RUNTIME_UNINSTRUMENTED', [member]);
          } catch { issue('NATIVE_HERMES_RUNTIME_IDENTITY_UNRECONCILABLE', 'process:' + pid); }
          const args = command.toString('utf8').split('\0');
          for (let index = 0; index < args.length; index++) {
            const argument = args[index]!;
            const home = /^--(?:hermes-)?home=/.test(argument) ? argument.slice(argument.indexOf('=') + 1)
              : /^--(?:hermes-)?home$/.test(argument) ? args[index + 1] : undefined;
            if (home !== undefined) { if (!home.startsWith('/')) issue('PROCESS_HERMES_HOME_UNRESOLVED'); else hermesRoots.add(home); }
          }
        }
        const raw = await boundedSchedulerRead(join(proc, pid, 'environ')); if (raw.length > 256 * 1024) throw new Error('Process environment bound');
        const selected = raw.toString('utf8').split('\0').filter(value => value.startsWith('HERMES_HOME='));
        for (const value of selected) { const home = value.slice('HERMES_HOME='.length);
          if (!home.startsWith('/') || /[\x00-\x1f]/.test(home)) issue('PROCESS_HERMES_HOME_UNRESOLVED'); else hermesRoots.add(home); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ESRCH') issue('PROCESS_SCHEDULER_DISCOVERY_UNAVAILABLE'); }
    }
  } catch { issue('PROCESS_SCHEDULER_DISCOVERY_UNAVAILABLE'); }
  if (options.coverageRoot) {
    try {
      const raw = await readJson<unknown>(options.coverageRoot, 'scheduler-coverage.json', 64 * 1024);
      if (raw !== undefined) {
        const value = z.object({ version: z.literal(1), reviewRef: z.string().min(1).max(256),
          additionalHermesHomes: z.array(z.string().min(1).max(4096).startsWith('/').refine(path => normalize(path) === path && !/[\x00-\x1f]/.test(path), 'Canonical absolute home required')).max(128) }).strict().parse(raw);
        for (const home of value.additionalHermesHomes) {
          const info = await lstat(home); if (!info.isDirectory() || info.isSymbolicLink() || await realpath(home) !== home) throw new Error('Reviewed root is not canonical');
          hermesRoots.add(home);
        }
        sources['reviewed-additional-roots'] = schedulerContentDigest(JSON.stringify(value));
      }
    } catch { issue('REVIEWED_SCHEDULER_COVERAGE_INVALID'); }
  }
  return { homes: [...homes].sort(), hermesRoots: [...hermesRoots].sort(), blockers: aggregateSchedulerBlockers(blockers),
    issues: [...new Set(issues)].sort(), sources };
}
