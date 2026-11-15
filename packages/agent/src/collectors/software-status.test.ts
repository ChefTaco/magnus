import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_VERSION } from '../version.js';

const io = vi.hoisted(() => ({ exec: vi.fn(), read: vi.fn(), stat: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<object>(), execFile: io.exec }));
vi.mock('node:fs/promises', async original => ({ ...await original<object>(), readFile: io.read, stat: io.stat }));
const { collectSoftwareStatus, parseSoftwarePackages } = await import('./software-status.js');
beforeEach(() => {
  io.exec.mockReset(); io.read.mockReset(); io.stat.mockReset();
  io.read.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  io.stat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  io.exec.mockImplementation((file, _args, _options, done) => {
    if (file === '/usr/bin/dpkg-query') done({ code: 1 }, 'python3\t3.12.3-1\tinstalled\ndocker-ce\t5:29.9.3-1\tinstalled\n', '');
    else done(null, 'Listing...\nfixture-package/stable 1.2.3 amd64 [upgradable from: 1.2.2]\n', '');
  });
});

describe('software metadata', () => {
  it('reads fixed package queries and npm metadata without executing discovered software or update hooks', async () => {
    io.read.mockResolvedValueOnce('{"version":"11.19.1"}');
    io.stat.mockResolvedValue({ mtime: new Date('2026-11-01T00:00:00Z') });
    const value = await collectSoftwareStatus();
    expect(value.versions).toMatchObject({ node: process.version, npm: '11.19.1', python3: '3.12.3-1', docker: '5:29.9.3-1', redis: null, 'magnus-agent': AGENT_VERSION });
    expect(value.packageUpdates).toEqual({ supported: true, pending: 1, source: 'local-package-cache', cacheRefreshedAt: '2026-11-01T00:00:00.000Z' });
    expect(io.exec.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ['/usr/bin/dpkg-query', ['-W', '-f=${Package}\t${Version}\t${db:Status-Status}\n', 'python3', 'redis-tools', 'redis-server', 'docker-ce', 'docker.io', 'tailscale']],
      ['/usr/bin/apt', ['list', '--upgradable', '-o', 'Dir::Cache::pkgcache=', '-o', 'Dir::Cache::srcpkgcache=']],
    ]);
    for (const [, , options] of io.exec.mock.calls) {
      expect(options.shell).not.toBe(true);
      expect(options.env).toEqual({ PATH: '/usr/bin:/bin', LANG: 'C' });
      expect(options.timeout).toBe(3000);
    }
  });
  it('keeps missing tools, failed queries and unknown cache freshness explicit without a fallback command', async () => {
    io.exec.mockImplementation((_file, _args, _options, done) => done({ code: 'ENOENT' }, '', ''));
    const value = await collectSoftwareStatus();
    expect(value.versions).toMatchObject({ npm: null, python3: null, redis: null, docker: null, tailscale: null });
    expect(value.packageUpdates).toEqual({ supported: false, pending: null, source: 'local-package-cache', cacheRefreshedAt: null });
    expect(io.exec).toHaveBeenCalledTimes(2);
  });
  it('does not report removed packages, arbitrary package names or malformed versions', () => {
    expect([...parseSoftwarePackages('python3\t3.12\tconfig-files\nforeign\t1.0\tinstalled\nredis-tools\t1.2; touch /tmp/unsafe\tinstalled\ntailscale\t1.2.3\tinstalled\n')])
      .toEqual([['tailscale', '1.2.3']]);
  });
});
