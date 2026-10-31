/**
 * Unit tests for cron-manager parseCrontab function.
 */
import { describe, it, expect } from 'vitest';
import { parseCrontab } from './cron-manager.js';

describe('parseCrontab', () => {
  it('should parse empty crontab', () => {
    expect(parseCrontab('')).toEqual([]);
  });

  it('should parse a single cron entry without a MAGNUS marker', () => {
    const raw = '*/5 * * * * /usr/bin/backup.sh';
    const result = parseCrontab(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: '/usr/bin/backup.sh',
      schedule: '*/5 * * * *',
      command: '/usr/bin/backup.sh',
    });
  });

  it('should parse a cron entry with a MAGNUS name marker', () => {
    const raw = [
      '# MAGNUS:daily-backup',
      '0 2 * * * /usr/bin/backup.sh --full',
    ].join('\n');
    const result = parseCrontab(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: 'daily-backup',
      schedule: '0 2 * * *',
      command: '/usr/bin/backup.sh --full',
    });
  });

  it('should parse multiple entries', () => {
    const raw = [
      '# MAGNUS:logrotate',
      '0 0 * * * /usr/sbin/logrotate',
      '# MAGNUS:health-check',
      '*/5 * * * * curl http://localhost:8080/health',
    ].join('\n');
    const result = parseCrontab(raw);
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe('logrotate');
    expect(result[1]!.name).toBe('health-check');
  });

  it('should skip comment-only lines', () => {
    const raw = [
      '# This is a comment',
      '# Another comment',
      '0 * * * * /bin/true',
    ].join('\n');
    const result = parseCrontab(raw);
    expect(result).toHaveLength(1);
    expect(result[0]!.command).toBe('/bin/true');
  });

  it('should handle malformed lines (fewer than 6 parts)', () => {
    const raw = '* * *';
    const result = parseCrontab(raw);
    expect(result).toEqual([]);
  });

  it('should preserve commands with spaces', () => {
    const raw = '0 12 * * 1-5 /usr/bin/notify "Hello World" --verbose';
    const result = parseCrontab(raw);
    expect(result).toHaveLength(1);
    expect(result[0]!.command).toBe('/usr/bin/notify "Hello World" --verbose');
  });
});
