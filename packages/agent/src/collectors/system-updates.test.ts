import { describe, expect, it } from 'vitest';
import { systemUpdateInternals } from './system-updates.js';

describe('system update posture parsing', () => {
  it('reads effective apt periodic values', () => {
    const config = [
      'APT::Periodic::Update-Package-Lists "1";',
      'APT::Periodic::Unattended-Upgrade "1";',
    ].join('\n');
    expect(systemUpdateInternals.aptValue(config, 'APT::Periodic::Update-Package-Lists')).toBe('1');
    expect(systemUpdateInternals.aptValue(config, 'APT::Periodic::Unattended-Upgrade')).toBe('1');
  });

  it('recognizes the Magnus full-upgrade policy in effective apt configuration', () => {
    const config = [
      'Unattended-Upgrade::Origins-Pattern "";',
      'Unattended-Upgrade::Origins-Pattern:: "origin=*";',
    ].join('\n');
    expect(systemUpdateInternals.aptValues(config, 'Unattended-Upgrade::Origins-Pattern')).toEqual(['', 'origin=*']);
    expect(systemUpdateInternals.magnusAptConfig()).toContain('"origin=*";');
  });

  it('normalizes systemd timer state', () => {
    expect(systemUpdateInternals.timerState([
      'Id=apt-daily-upgrade.timer',
      'ActiveState=active',
      'UnitFileState=enabled',
    ].join('\n'))).toEqual({
      name: 'apt-daily-upgrade.timer',
      enabled: true,
      active: true,
      state: 'enabled/active',
    });
  });
});
