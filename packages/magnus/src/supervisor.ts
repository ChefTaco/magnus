/** Starting, stopping and restarting the project's services. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mustRun, type Io } from './io.js';
import type { Component, Project } from './project.js';

export function unitDirectory(project: Project, env: NodeJS.ProcessEnv): string {
  return project.state.scope === 'system'
    ? '/etc/systemd/system'
    : join(env['XDG_CONFIG_HOME'] || join(homedir(), '.config'), 'systemd', 'user');
}

function systemctlArgs(project: Project, args: string[]): string[] {
  return project.state.scope === 'user' ? ['--user', ...args] : args;
}

function unitNames(project: Project, components: readonly Component[] = project.state.components): string[] {
  return components.map((component) => `${project.state.units[component]}.service`);
}

export async function systemctl(io: Io, project: Project, ...args: string[]): Promise<void> {
  await mustRun(io, 'systemctl', systemctlArgs(project, args), { capture: true });
}

export function manualRestartHint(project: Project): string {
  if (project.state.supervisor === 'none') return `restart the processes started from ${project.path('units')}/*.service (ExecStart)`;
  return project.state.scope === 'user'
    ? `systemctl --user restart ${unitNames(project).join(' ')}`
    : `sudo systemctl restart ${unitNames(project).join(' ')}`;
}

/** Restart every component (server first, so the console reconnects to the new API). */
export async function restartServices(io: Io, project: Project): Promise<void> {
  switch (project.state.supervisor) {
    case 'systemd':
      await systemctl(io, project, 'daemon-reload');
      for (const unit of unitNames(project)) await systemctl(io, project, 'restart', unit);
      return;
    case 'none':
      io.log(`Restart the Magnus server and console now so they run ./current: ${manualRestartHint(project)}. Waiting for them…`);
      return;
  }
}

export async function stopServices(io: Io, project: Project): Promise<void> {
  if (project.state.supervisor === 'systemd') {
    for (const unit of unitNames(project).reverse()) await systemctl(io, project, 'stop', unit);
  } else if (project.state.supervisor === 'none') {
    io.log('Stop the Magnus server and console now.');
  }
}

export async function enableServices(io: Io, project: Project): Promise<void> {
  if (project.state.supervisor !== 'systemd') return;
  await systemctl(io, project, 'daemon-reload');
  await systemctl(io, project, 'enable', ...unitNames(project));
}
