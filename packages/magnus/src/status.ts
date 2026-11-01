/** `magnus status`: what is installed, what is serving, and whether an update is available. */
import { existsSync, readdirSync } from 'node:fs';
import { compareVersions, latestVersion } from '@hivemagnus/magnus-contracts';
import { readRuntime } from './health.js';
import type { Io } from './io.js';
import { Project } from './project.js';
import { fetchRegistryCatalog } from './release.js';

export interface StatusOptions {
  dir: string;
  json: boolean;
  offline: boolean;
  registry: string;
}

export async function status(io: Io, options: StatusOptions): Promise<number> {
  const project = Project.load(options.dir);
  const versionsDir = project.path('versions');
  const installed = existsSync(versionsDir)
    ? readdirSync(versionsDir).filter((name) => /^\d+\.\d+\.\d+/.test(name) && !name.endsWith('.tmp')).sort(compareVersions)
    : [];
  const runtime = readRuntime(project);
  let latest: { sameMajor: string | null; any: string | null; error?: string } | null = null;
  if (!options.offline && project.state.current) {
    try {
      const catalog = await fetchRegistryCatalog(io, options.registry);
      latest = { sameMajor: latestVersion(catalog.versions, { sameMajorAs: project.state.current }), any: latestVersion(catalog.versions) };
    } catch (error) {
      latest = { sameMajor: null, any: null, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const report = {
    dir: project.dir,
    supervisor: project.state.supervisor,
    scope: project.state.scope,
    current: project.state.current,
    linked: project.linkedVersion(),
    previous: project.state.previous,
    installed,
    serving: runtime ? { version: runtime.version, pid: runtime.pid, startedAt: runtime.startedAt } : null,
    latest,
    history: project.state.history.slice(-5),
  };
  if (options.json) {
    io.log(JSON.stringify(report, null, 2));
    return 0;
  }
  io.log(`Magnus project ${report.dir} (${report.supervisor}${report.supervisor === 'systemd' ? `, ${report.scope} units` : ''})`);
  io.log(`  current:   ${report.current ?? '(none)'}${report.linked && report.linked !== report.current ? ` (but ./current points at ${report.linked}!)` : ''}`);
  io.log(`  previous:  ${report.previous ?? '(none)'}`);
  io.log(`  installed: ${installed.join(', ') || '(none)'}`);
  io.log(`  serving:   ${report.serving ? `${report.serving.version} (pid ${report.serving.pid}, since ${report.serving.startedAt})` : 'unknown (no runtime file)'}`);
  if (latest?.error) io.log(`  updates:   could not check (${latest.error})`);
  else if (latest && report.current) {
    const newer = latest.sameMajor && compareVersions(latest.sameMajor, report.current) > 0 ? latest.sameMajor : null;
    io.log(`  updates:   ${newer ? `${newer} available: magnus upgrade --dir ${report.dir}` : 'up to date'}`);
    if (latest.any && latest.any.split('.')[0] !== report.current.split('.')[0] && compareVersions(latest.any, report.current) > 0) {
      io.log(`             ${latest.any} is a new major version; see UPGRADING.md before \`magnus upgrade --to ${latest.any} --allow-major\``);
    }
  }
  for (const entry of report.history) {
    io.log(`  ${entry.at}  ${entry.action} ${entry.from ?? '-'} -> ${entry.to}: ${entry.result}${entry.reason ? ` (${entry.reason})` : ''}`);
  }
  return 0;
}
