import { describe, expect, it } from 'vitest';
import { userRoutes } from './user-manager.js';

const post = (path: string, body: unknown) => userRoutes.request(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('user routes validation', () => {
  it('rejects passwords that would append chpasswd records', async () => {
    for (const password of ['x\nroot:owned', 'x\rroot:owned', 'x\0y'])
      expect((await post('/change-password', { username: 'bob', password })).status).toBe(400);
  });

  it('rejects shell metacharacters and privileged groups', async () => {
    for (const group of ['x; id', '$(id)', 'sudo', 'root', 'docker'])
      expect((await post('/provision', { username: 'bob', password: 'secret', group })).status).toBe(400);
  });
});
