import { afterEach, describe, expect, it, vi } from 'vitest';

async function freshEnv(values: Record<string, string>) {
  vi.resetModules();
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
  return import('./env.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('a former external-IAM server', () => {
  it('is refused with the removal explained before any missing secret', async () => {
    const env = await freshEnv({ NODE_ENV: 'production', IAM_CORE_URL: 'https://iam.example.com', JWT_SECRET: '' });
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((message: unknown) => { errors.push(String(message)); });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    expect(() => env.validateSecrets()).toThrow('exit 1');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/IAM_CORE_URL \(external IAM token verification\) was removed in Magnus 4\.0\.0/);
    expect(errors[0]).toContain('JWT_SECRET');
    expect(errors[0]).not.toContain('Missing required secrets');
  });

  it('is told why JWT_SECRET is now required by magnus-server check', async () => {
    const env = await freshEnv({ IAM_CORE_URL: 'https://iam.example.com', JWT_SECRET: '' });
    expect(env.listMissingSecrets()).toContainEqual(expect.stringMatching(/^JWT_SECRET .*external IAM mode was removed in 4\.0\.0/));
    const plain = await freshEnv({ IAM_CORE_URL: '', JWT_SECRET: '' });
    expect(plain.listMissingSecrets()).toContain('JWT_SECRET (dedicated, min 32 chars)');
  });
});
