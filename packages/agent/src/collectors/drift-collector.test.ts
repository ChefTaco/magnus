import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runDriftScan } from './drift-collector.js';

describe('drift collector', () => {
  it('never passes check names to a shell', async () => {
    const marker = join(tmpdir(), `drift-injection-${process.pid}`);
    const findings = await runDriftScan({ checks: [
      { type: 'package', name: `x;touch ${marker}`, expected: 'any' },
      { type: 'service', name: `x$(touch ${marker})`, expected: 'active' },
      { type: 'sysctl', name: `kernel.x;touch ${marker}`, expected: '1' },
      { type: 'user', name: `root;touch ${marker}`, expected: 'exists' },
    ] });
    expect(findings.map(f => f.actual)).toEqual(['invalid name', 'invalid name', 'invalid name', 'invalid name']);
    await expect(import('node:fs/promises').then(fs => fs.access(marker))).rejects.toThrow();
  });

  it('hashes and matches file content without shelling out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drift-'));
    try {
      const path = join(dir, 'config with spaces"$(x).conf');
      await writeFile(path, 'alpha=1\n');
      const sha = createHash('sha256').update('alpha=1\n').digest('hex');
      const [hashed, contains, missing] = await runDriftScan({ checks: [
        { type: 'file', name: path, expected: `sha256:${sha}` },
        { type: 'file', name: path, expected: 'alpha=1' },
        { type: 'file', name: join(dir, 'absent'), expected: 'exists' },
      ] });
      expect(hashed?.status).toBe('match');
      expect(contains?.status).toBe('match');
      expect(missing?.status).toBe('missing');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a present user as drifted when it should be absent', async () => {
    const [finding] = await runDriftScan({ checks: [{ type: 'user', name: 'root', expected: 'absent' }] });
    expect(finding?.status).toBe('drifted');
  });
});
