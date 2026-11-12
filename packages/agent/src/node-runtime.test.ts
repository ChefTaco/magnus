import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { nodeRuntimeCheck } from './node-runtime.js';

const installation = mkdtempSync(join(tmpdir(), 'magnus-runtime-gate-'));
afterAll(() => rmSync(installation, { recursive: true, force: true }));

function cliOn(version: string, args: string[]) {
  const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
  const script = `Object.defineProperty(process, 'version', { value: ${JSON.stringify(`v${version}`)} });
    Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });
    process.argv = [process.execPath, ${JSON.stringify(entry)}, ...${JSON.stringify(args)}];
    await import(${JSON.stringify(new URL('./index.ts', import.meta.url).href)});`;
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env['PATH'], NODE_ENV: 'test', AGENT_INSTALL_DIR: installation,
      CONTROL_API_URL: 'https://magnus.example.com', HOST_FQDN: 'node-1.example.com' },
  });
}

describe('native agent Node security minimum', () => {
  it.each(['24.22.3', 'v24.22.3', '24.23.0', '26.13.1', '26.14.0'])('accepts patched supported runtime %s', version => {
    expect(nodeRuntimeCheck(version).status).toBe('pass');
  });

  it.each(['22.99.99', '24.22.1', '24.22.2', '25.0.0', '26.13.0', '27.0.0', '24.22.3-rc.1'])('rejects unsupported runtime %s', version => {
    expect(nodeRuntimeCheck(version)).toMatchObject({ status: 'fail', message: expect.stringContaining('requires Node.js ^24.22.3 || ^26.13.1') });
  });

  it.each(['24.22.2', '26.13.0'])('blocks start and service installation on %s before reading configuration', version => {
    for (const command of ['start', 'install-service']) {
      const child = cliOn(version, [command, '--env-file', join(installation, 'missing.env')]);
      expect(child.status, child.stderr).toBe(1);
      expect(child.stderr).toContain('requires Node.js ^24.22.3 || ^26.13.1');
      expect(child.stderr).not.toContain('cannot read --env-file');
    }
  });

  it('keeps help and version available on an unsupported runtime', () => {
    for (const flag of ['--help', '--version']) {
      const child = cliOn('24.22.2', [flag]);
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout.length).toBeGreaterThan(0);
    }
  });

  it('keeps configuration diagnostics available and reports the unsupported runtime', () => {
    const child = cliOn('24.22.2', ['check', '--json']);
    expect(child.status, child.stderr).toBe(1);
    const report = JSON.parse(child.stdout) as { ok: boolean; errors: string[] };
    expect(report.ok).toBe(false);
    expect(report.errors).toContain('requires Node.js ^24.22.3 || ^26.13.1; this node runs v24.22.2');
  });
});
