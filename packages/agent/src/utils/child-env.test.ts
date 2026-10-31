import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { AGENT_SECRET_ENV_KEYS, childEnvironment } from './child-env.js';
import { armChildTimeout } from './child-timeout.js';

describe('child environment', () => {
  it('removes every agent credential and applies overrides', () => {
    const base = Object.fromEntries([...AGENT_SECRET_ENV_KEYS.map(key => [key, 'secret']), ['PATH', '/usr/bin']]);
    const env = childEnvironment({ HOME: '/home/x' }, base);
    for (const key of AGENT_SECRET_ENV_KEYS) expect(env[key]).toBeUndefined();
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/home/x' });
    expect(base['NODE_MANAGER_SECRET']).toBe('secret');
  });
});

describe('child timeout', () => {
  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)']);
    let timedOut = false;
    const disarm = armChildTimeout(child, 100, () => { timedOut = true; });
    const signal = await new Promise(resolve => child.on('close', (_code, sig) => resolve(sig)));
    disarm();
    expect(timedOut).toBe(true);
    expect(signal).toBe('SIGKILL');
  }, 15_000);
});
