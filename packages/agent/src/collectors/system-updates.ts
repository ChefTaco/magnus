import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { SystemUpdateInfo } from '../types/index.js';
import { childEnvironment } from '../utils/child-env.js';

const execFileAsync = promisify(execFile);
const MAGNUS_APT_CONFIG = '/etc/apt/apt.conf.d/52magnus-auto-upgrades';
const FULL_UPGRADE_ORIGIN_PATTERN = 'origin=*';

function aptValue(output: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = output.match(new RegExp(`^${escapedKey}\\s+\"([^\"]*)\";`, 'm'));
  return match?.[1] ?? null;
}

function aptValues(output: string, key: string): string[] {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = output.matchAll(new RegExp(`^${escapedKey}(?:::)?\\s+"([^\"]*)";`, 'gm'));
  return [...matches].map((match) => match[1] ?? '');
}

function magnusAptConfig(): string {
  return [
    '// Managed by Magnus. Use the Magnus node action to restore this policy.',
    '// Match every configured trusted APT origin, just as apt-get upgrade does.',
    'APT::Periodic::Update-Package-Lists "1";',
    'APT::Periodic::Unattended-Upgrade "1";',
    'Unattended-Upgrade::Origins-Pattern {',
    `  "${FULL_UPGRADE_ORIGIN_PATTERN}";`,
    '};',
    '',
  ].join('\n');
}

function timerState(output: string): SystemUpdateInfo['timers'][number] {
  const values = Object.fromEntries(
    output.split('\n').map((line) => line.split('=', 2)).filter((parts) => parts.length === 2),
  );
  const enabled = values['UnitFileState'] ?? 'unknown';
  const active = values['ActiveState'] ?? 'unknown';
  return {
    name: values['Id'] ?? 'unknown',
    enabled: ['enabled', 'enabled-runtime', 'static'].includes(enabled),
    active: active === 'active',
    state: `${enabled}/${active}`,
  };
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

async function inspectTimer(name: string): Promise<SystemUpdateInfo['timers'][number]> {
  try {
    const { stdout } = await execFileAsync('systemctl', [
      'show', name,
      '--property=Id', '--property=LoadState', '--property=ActiveState', '--property=UnitFileState',
      '--no-pager',
    ], { timeout: 5_000 });
    const timer = timerState(stdout);
    if (stdout.includes('LoadState=not-found')) return { ...timer, enabled: false, active: false };
    return timer;
  } catch {
    return { name, enabled: false, active: false, state: 'unknown' };
  }
}

export async function collectSystemUpdates(): Promise<SystemUpdateInfo> {
  const osRelease = await readOptional('/etc/os-release');
  const osId = osRelease.match(/^ID=(?:"([^"]+)"|([^\n]+))$/m)?.slice(1).find(Boolean)?.trim() ?? 'unknown';
  const osLike = osRelease.match(/^ID_LIKE=(?:"([^"]+)"|([^\n]+))$/m)?.slice(1).find(Boolean)?.trim() ?? '';
  const supported = /(?:^|\s)(ubuntu|debian|raspbian)(?:\s|$)/.test(`${osId} ${osLike}`);

  const [aptConfig, packageResult, timers, rebootMarker, rebootPackages] = await Promise.all([
    execFileAsync('apt-config', ['dump'], { timeout: 5_000 }).then(({ stdout }) => stdout).catch(() => ''),
    execFileAsync('dpkg-query', ['-W', '-f=${Status}', 'unattended-upgrades'], { timeout: 5_000 })
      .then(({ stdout }) => stdout.includes('install ok installed'))
      .catch(() => false),
    Promise.all([inspectTimer('apt-daily.timer'), inspectTimer('apt-daily-upgrade.timer')]),
    readOptional('/var/run/reboot-required'),
    readOptional('/var/run/reboot-required.pkgs'),
  ]);

  const updateLists = aptValue(aptConfig, 'APT::Periodic::Update-Package-Lists');
  const unattended = aptValue(aptConfig, 'APT::Periodic::Unattended-Upgrade');
  const fullUpgradePolicyEnabled = aptValues(aptConfig, 'Unattended-Upgrade::Origins-Pattern')
    .some((pattern) => pattern.trim().toLowerCase() === FULL_UPGRADE_ORIGIN_PATTERN);
  const periodicConfigured = Number(updateLists) > 0 && Number(unattended) > 0 && fullUpgradePolicyEnabled;
  const timersEnabled = timers.every((timer) => timer.enabled);
  const automaticUpdates = !supported
    ? 'unsupported'
    : packageResult && periodicConfigured && timersEnabled
      ? 'enabled'
      : packageResult || periodicConfigured || timers.some((timer) => timer.enabled)
        ? 'partial'
        : 'disabled';

  return {
    supported,
    platform: osId,
    automaticUpdates,
    unattendedUpgradesInstalled: packageResult,
    periodicUpdateListsEnabled: Number(updateLists) > 0,
    periodicUnattendedUpgradeEnabled: Number(unattended) > 0,
    fullUpgradePolicyEnabled,
    timers,
    rebootRequired: rebootMarker.trim().length > 0,
    rebootRequiredPackages: rebootPackages.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 50),
  };
}

export async function enableSystemUpdates(): Promise<SystemUpdateInfo> {
  const current = await collectSystemUpdates();
  if (!current.supported) {
    throw new Error(`Automatic apt updates are not supported on platform ${current.platform}`);
  }

  await execFileAsync('apt-get', ['update', '-qq'], {
    timeout: 10 * 60_000,
    env: childEnvironment({ DEBIAN_FRONTEND: 'noninteractive' }),
  });
  await execFileAsync('apt-get', ['install', '-y', 'unattended-upgrades'], {
    timeout: 10 * 60_000,
    env: childEnvironment({ DEBIAN_FRONTEND: 'noninteractive' }),
  });
  await writeFile(
    MAGNUS_APT_CONFIG,
    magnusAptConfig(),
    { encoding: 'utf8', mode: 0o644 },
  );
  await execFileAsync('systemctl', ['enable', '--now', 'apt-daily.timer', 'apt-daily-upgrade.timer'], {
    timeout: 30_000,
  });

  return collectSystemUpdates();
}

export const systemUpdateInternals = { aptValue, aptValues, timerState, magnusAptConfig };
