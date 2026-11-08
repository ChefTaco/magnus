import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe.skipIf(!process.env['TEST_DATABASE_URL'])('Ardent agent operations in PostgreSQL', () => {
  const nodeId = `ardent-operation-${randomUUID()}`;
  let db: ReturnType<typeof import('../db/index.js')['getDb']>;
  const base = () => ({ id: randomUUID(), kind: 'deploy', nodeId, profile: 'lead', requestJson: '{}', createdBy: 'alice' });

  beforeAll(async () => {
    const url = process.env['TEST_DATABASE_URL']!;
    if (!new URL(url).pathname.startsWith('/magnus_ideas')) throw new Error('Disposable magnus_ideas database required');
    process.env['DATABASE_URL'] = url;
    db = (await import('../db/index.js')).getDb();
  });
  afterAll(async () => { await db?.ardentAgentOperation.deleteMany({ where: { nodeId } }); });

  it('allows one running operation per profile, reported as a unique conflict', async () => {
    await db.ardentAgentOperation.create({ data: base() });
    expect(await db.ardentAgentOperation.create({ data: base() }).catch((error: unknown) => (error as { code?: unknown }).code)).toBe('P2002');
    // Settled operations do not block a new one.
    await db.ardentAgentOperation.create({ data: { ...base(), status: 'failed' } });
    await db.ardentAgentOperation.create({ data: { ...base(), profile: 'other' } });
  });

  it('refuses an unknown kind or status', async () => {
    await expect(db.ardentAgentOperation.create({ data: { ...base(), profile: 'kinds', kind: 'import' } })).rejects.toThrow();
    await expect(db.ardentAgentOperation.create({ data: { ...base(), profile: 'kinds', status: 'paused' } })).rejects.toThrow();
  });
});
