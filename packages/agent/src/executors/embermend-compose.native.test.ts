import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { composeInstanceFormat } from './embermend-host.js';

const selected = process.env['MAGNUS_EMBERMEND_DOCKER_TEST_IMAGE'];
describe.skipIf(!selected)('native Docker Compose inventory template', () => {
  it('observes a real container without Docker health metadata as unknown', () => {
    const image = z.string().regex(/^sha256:[a-f0-9]{64}$/).parse(selected);
    const id = execFileSync('docker', ['create', '--label', 'magnus.disposable-test=true', '--label', 'com.docker.compose.service=web', '--label', 'com.docker.compose.project=fixture', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '32', '--memory', '256m', '--no-healthcheck', image, 'node', '-e', 'process.exit(0)'], { encoding: 'utf8' }).trim();
    try {
      const value: unknown = JSON.parse(execFileSync('docker', ['inspect', '--format', composeInstanceFormat, id], { encoding: 'utf8' }));
      expect(z.object({ id: z.literal(id), imageRef: z.literal(image), health: z.null(), service: z.literal('web'), project: z.literal('fixture') }).parse(value).health).toBeNull();
    } finally { execFileSync('docker', ['rm', '--force', id], { stdio: 'pipe' }); }
  }, 20000);
  it('retains an independently configured real Docker health status', async () => {
    const image = z.string().regex(/^sha256:[a-f0-9]{64}$/).parse(selected);
    const id = execFileSync('docker', ['create', '--label', 'magnus.disposable-test=true', '--label', 'com.docker.compose.service=web', '--label', 'com.docker.compose.project=fixture', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '32', '--memory', '256m', '--health-cmd', 'node -e "process.exit(0)"', '--health-interval', '100ms', '--health-timeout', '2s', image, 'node', '-e', 'setInterval(() => {}, 1000)'], { encoding: 'utf8' }).trim();
    try {
      execFileSync('docker', ['start', id], { stdio: 'pipe' });
      let health: string | null = null;
      for (let attempt = 0; attempt < 50; attempt++) {
        const value: unknown = JSON.parse(execFileSync('docker', ['inspect', '--format', composeInstanceFormat, id], { encoding: 'utf8' }));
        health = z.object({ health: z.string().nullable() }).parse(value).health;
        if (health === 'healthy') break;
        await setTimeout(100);
      }
      expect(health).toBe('healthy');
    } finally { execFileSync('docker', ['rm', '--force', id], { stdio: 'pipe' }); }
  }, 20000);
});
