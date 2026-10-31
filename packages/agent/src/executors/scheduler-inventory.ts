/** Conservative inventory: unreadable/foreign schedulers are blockers, never zero work. */
import { lstat, readdir } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { hash } from './execution-supervisor-state.js';
import { aggregateSchedulerBlockers, boundedSchedulerMemberEvidence, boundedSchedulerRead, discoverSchedulerSources,
  schedulerContentDigest, schedulerMemberEvidenceDigest, schedulerMembersDigest, type DiscoveryBlockerInput,
  type DiscoveryOptions } from './scheduler-discovery.js';
import { ManagedScheduler, type SchedulerDrainIdentity } from './managed-scheduler.js';
export interface SchedulerInventoryOptions {
  scheduler?: ManagedScheduler; spool?: string; managedUser?: string; systemCrontab?: string;
  systemDirectories?: string[]; homes?: string[]; timers?: () => Promise<string>;
  discovery?: DiscoveryOptions; expectedBarrier?: SchedulerDrainIdentity; atSpools?: string[];
  wrapper?: (job: Awaited<ReturnType<ManagedScheduler['job']>> & {}) => string;
}
export async function schedulerInventory(options: SchedulerInventoryOptions = {}) {
  const blockers: DiscoveryBlockerInput[] = [];
  const issues: string[] = []; const sources: Record<string, string> = {};
  const blockContent = (kind: string, source: string | Buffer, count = 1) => {
    if (count) blockers.push({ kind, sourceSha256: schedulerContentDigest(source), count });
  };
  const read = async (path: string): Promise<string | undefined> => {
    try {
      const st = await lstat(path); if (!st.isFile() || st.isSymbolicLink() || st.size > 1024 * 1024) throw new Error('Unbounded scheduler source');
      const raw = (await boundedSchedulerRead(path, 1024 * 1024)).toString('utf8'); sources[hash(path)] = schedulerContentDigest(raw); return raw;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issues.push('UNREADABLE_SCHEDULER_SOURCE:' + hash(path)); return undefined; }
  };
  const scheduler = options.scheduler ?? new ManagedScheduler();
  let managed: Awaited<ReturnType<ManagedScheduler['inventory']>>;
  try { managed = await scheduler.inventory(options.expectedBarrier); } catch { managed = { jobs: [], occurrences: [], issues: ['MANAGED_INVENTORY_UNAVAILABLE'], barrier: null }; }
  issues.push(...managed.issues);
  const expected = new Set(options.wrapper ? managed.jobs.filter(job => job.enabled).map(job => options.wrapper!(job)) : []);
  const seen = new Set<string>();
  const owner = options.managedUser ?? userInfo().username;
  for (const spool of options.spool ? [options.spool] : ['/var/spool/cron/crontabs', '/var/spool/cron/tabs', '/var/spool/cron']) {
  try {
    const users = await readdir(spool); if (users.length > 256) throw new Error('Unbounded crontab inventory');
    for (const user of users) {
      if (spool === '/var/spool/cron' && ['crontabs', 'tabs', 'atjobs', 'atspool'].includes(user)) continue;
      const path = join(spool, user); const raw = await read(path); if (raw === undefined) continue;
      for (const line of raw.split('\n').map(value => value.trim()).filter(value => value && !value.startsWith('#'))) {
        if (expected.has(line)) { if (user !== owner) { blockContent('MANAGED_TRIGGER_OWNER_MISMATCH', raw); continue; } if (seen.has(line)) blockContent('DUPLICATE_MANAGED_TRIGGER', line); seen.add(line); }
        else blockContent('LEGACY_OR_UNSUPPORTED_CRONTAB', line);
      }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issues.push('CRONTAB_INVENTORY_UNAVAILABLE'); }
  }
  for (const line of expected) if (!seen.has(line)) blockContent('MANAGED_TRIGGER_MISSING', line);
  const rawSystem = await read(options.systemCrontab ?? '/etc/crontab');
  if (options.systemCrontab === undefined) { const anacron = await read('/etc/anacrontab');
    if (anacron) blockContent('SYSTEM_ANACRON', anacron, anacron.split('\n').filter(line => line.trim() && !line.trimStart().startsWith('#')).length); }
  if (rawSystem) {
    const entries = rawSystem.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    // Cron environment assignments are source bytes, but not scheduled work.
    // Keep the entire file digest and a blocker for an environment-only file:
    // unknown or malformed lines must never turn into a clear inventory.
    const schedules = entries.filter(line => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(line));
    blockContent('SYSTEM_CRONTAB', rawSystem, schedules.length || (entries.length ? 1 : 0));
  }
  for (const directory of options.systemDirectories ?? ['/etc/cron.d', '/etc/cron.hourly', '/etc/cron.daily', '/etc/cron.weekly', '/etc/cron.monthly']) {
    try {
      const names = await readdir(directory); if (names.length > 256) throw new Error('Unbounded scheduler directory');
      for (const name of names) { if (name.startsWith('.')) continue; const raw = await read(join(directory, name)); if (raw?.trim()) blockContent('SYSTEM_CRON_SOURCE', raw); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issues.push('SYSTEM_CRON_INVENTORY_UNAVAILABLE:' + hash(directory)); }
  }
  const discovery = options.homes !== undefined && options.discovery === undefined
    ? { homes: options.homes, hermesRoots: [], blockers: [], issues: [], sources: {} }
    : await discoverSchedulerSources({ ...options.discovery, coverageRoot: scheduler.root });
  blockers.push(...discovery.blockers); issues.push(...discovery.issues); Object.assign(sources, discovery.sources);
  let rememberedRoots: string[] = [];
  try { rememberedRoots = (await scheduler.observeDiscovery(discovery.hermesRoots, [])).hermesRoots; }
  catch { issues.push('SCHEDULER_DISCOVERY_JOURNAL_UNAVAILABLE'); }
  const roots = new Set([...discovery.homes.map(home => join(home, '.hermes')), ...rememberedRoots, ...discovery.hermesRoots]);
  for (const root of [...roots]) {
    try {
      const profiles = await readdir(join(root, 'profiles'), { withFileTypes: true });
      if (profiles.length > 128) throw new Error('Native profile limit exceeded');
      sources[hash(join(root, 'profiles'))] = schedulerMembersDigest(profiles.map(entry =>
        `${entry.name}:${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'}`));
      for (const profile of profiles) {
        if (profile.isSymbolicLink()) { issues.push('NATIVE_PROFILE_ALIAS_UNVERIFIED:' + hash(join(root, 'profiles', profile.name))); continue; }
        if (profile.isDirectory()) roots.add(join(root, 'profiles', profile.name));
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issues.push('NATIVE_PROFILE_INVENTORY_UNAVAILABLE:' + hash(root)); }
  }
  for (const root of roots) {
    const path = join(root, 'cron/jobs.json'); const raw = await read(path); if (raw === undefined) continue;
    try {
      const value = JSON.parse(raw); const jobs = Array.isArray(value) ? value : value.jobs;
      if (!Array.isArray(jobs) || jobs.length > 1000 || jobs.some(job => !job || typeof job !== 'object'
        || job.enabled !== undefined && typeof job.enabled !== 'boolean' || job.paused !== undefined && typeof job.paused !== 'boolean')) throw new Error('Invalid native jobs');
      blockContent('NATIVE_HERMES_SCHEDULES', raw, jobs.filter(job => job.enabled !== false && job.paused !== true).length);
      // Native claim TTL/PID liveness cannot prove descendants stopped. A paused
      // schedule with any unresolved claim remains uncertain until its owner proves completion.
      blockContent('NATIVE_HERMES_UNSETTLED_CLAIMS', raw, jobs.filter(job => job.fire_claim || job.run_claim || ['running', 'working'].includes(job.last_status)).length);
    } catch { issues.push('HERMES_SCHEDULE_INVENTORY_INVALID:' + hash(path)); }
  }
  for (const directory of options.atSpools ?? (options.homes !== undefined ? [] : ['/var/spool/at', '/var/spool/atjobs', '/var/spool/cron/atjobs', '/var/spool/cron/atspool'])) {
    try {
      const names = await readdir(directory); if (names.length > 1024) throw new Error('Unbounded at queue');
      const canonicalNames = [...names].sort(); const jobs = canonicalNames.filter(name => !['.SEQ', '.lock'].includes(name));
      const evidence = []; let totalBytes = 0; let complete = true;
      for (const name of jobs) {
        const path = join(directory, name);
        try {
          const member = await boundedSchedulerMemberEvidence(path, path, 256 * 1024);
          if (totalBytes + member.size > 4 * 1024 * 1024) {
            complete = false; issues.push('AT_JOB_IDENTITY_UNRECONCILABLE:' + hash(directory)); break;
          }
          totalBytes += member.size;
          evidence.push(member);
        } catch { complete = false; issues.push('AT_JOB_IDENTITY_UNRECONCILABLE:' + hash(path)); break; }
      }
      const confirmedNames = (await readdir(directory)).sort();
      if (confirmedNames.length !== canonicalNames.length || confirmedNames.some((name, index) => name !== canonicalNames[index])) {
        complete = false; issues.push('AT_JOB_IDENTITY_UNRECONCILABLE:' + hash(directory));
      }
      sources[hash(directory)] = evidence.length ? schedulerMemberEvidenceDigest(evidence) : schedulerMembersDigest(names);
      if (complete && evidence.length) blockers.push({ kind: 'NATIVE_AT_QUEUE',
        sourceSha256: schedulerMemberEvidenceDigest(evidence), count: evidence.length });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issues.push('AT_QUEUE_INVENTORY_UNAVAILABLE:' + hash(directory)); }
  }
  if (options.timers) try {
    const timers = await options.timers(); const lines = timers.split('\n').filter(line => line.trim());
    // The fixture hook cannot provide resolved unit/drop-in identity. Production
    // system timer evidence is collected by discoverSchedulerSources.
    if (lines.length) issues.push('SYSTEM_TIMER_IDENTITY_UNRECONCILABLE:' + schedulerContentDigest(timers));
    sources['system-timers'] = schedulerContentDigest(timers);
  } catch { issues.push('SYSTEM_TIMER_INVENTORY_UNAVAILABLE'); }
  let finalBlockers = aggregateSchedulerBlockers(blockers);
  try {
    const current = finalBlockers;
    const remembered = await scheduler.observeDiscovery([], current.filter(source => !source.kind.startsWith('MANAGED_') && source.kind !== 'DUPLICATE_MANAGED_TRIGGER'));
    const combined = new Map(remembered.foreignSources.map(source => [source.kind + ':' + source.sourceSha256, source]));
    for (const source of current) {
      const key = source.kind + ':' + source.sourceSha256;
      const prior = combined.get(key);
      combined.set(key, { ...source, count: Math.max(prior?.count ?? 0, source.count) });
    }
    finalBlockers = aggregateSchedulerBlockers([...combined.values(), ...remembered.legacyForeignSources.map(source => ({
      kind: 'LEGACY_SCHEDULER_IDENTITY_UNRECONCILABLE',
      sourceSha256: schedulerContentDigest(JSON.stringify(source)), count: source.count,
    }))]);
    for (const source of remembered.legacyForeignSources)
      issues.push('LEGACY_SCHEDULER_IDENTITY_UNRECONCILABLE:' + schedulerContentDigest(JSON.stringify(source)));
    sources['foreign-discovery-journal'] = schedulerContentDigest(JSON.stringify(remembered));
  } catch { issues.push('SCHEDULER_DISCOVERY_JOURNAL_UNAVAILABLE'); }
  const active = managed.occurrences.filter(row => row.state === 'admitting' || row.state === 'running').length;
  const unknown = managed.occurrences.filter(row => row.state === 'unknown' || (['completed', 'not-started'].includes(row.state) && row.settlementPending)).length;
  return { version: 1, barrier: managed.barrier, sources, supported: issues.length === 0 && finalBlockers.length === 0,
    quiescent: issues.length === 0 && finalBlockers.length === 0 && active === 0 && unknown === 0,
    activeCount: active, unknownCount: unknown, blockers: finalBlockers, issues,
    managedJobs: managed.jobs.map(job => ({ jobId: job.jobId, revision: job.spec.revision, specSha256: job.specSha256, enabled: job.enabled, expiresAt: job.spec.expiresAt })),
    occurrences: managed.occurrences.map(row => ({ occurrenceId: row.occurrenceId, state: row.state, deadline: row.deadline, settlementPending: row.settlementPending })) };
}
