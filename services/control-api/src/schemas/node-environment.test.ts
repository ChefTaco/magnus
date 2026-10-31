import { describe, expect, it } from 'vitest';
import { dispatchCommandSchema } from './commands.js';
import { createCronSchema, updateCronSchema } from './cron.js';

describe('node-bound environment', () => {
  it('rejects secret-named keys that would otherwise be dispatched as a redaction marker', () => {
    const command = dispatchCommandSchema.safeParse({ nodeIds: ['n1'], command: 'run', environment: { API_KEY: 'value' } });
    expect(command.success).toBe(false);
    expect(command.error?.issues[0]?.message).toMatch(/secret-named/);
    expect(createCronSchema.safeParse({ nodeId: 'n1', name: 'job', schedule: '* * * * *', command: 'run',
      environment: { password: 'value' } }).success).toBe(false);
    expect(updateCronSchema.safeParse({ environment: { TOKEN: 'value' } }).success).toBe(false);
  });

  it('keeps ordinary environment values intact', () => {
    const parsed = dispatchCommandSchema.parse({ nodeIds: ['n1'], command: 'run', environment: { LOG_LEVEL: 'debug' } });
    expect(parsed.environment).toEqual({ LOG_LEVEL: 'debug' });
  });
});
