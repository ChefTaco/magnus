import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Run with a migrated disposable PostgreSQL DB and the real HiveMem package (or built checkout).
// No substitute receipt/digest implementation: the real HTTP handler/store signs and checks access.
const enabled = process.env['TEST_DATABASE_URL'] && process.env['HIVEMEM_CONTRACT_ROOT'];
const secret = 'synthetic-hivemem-integration-key-'.repeat(3);
const HOUR = 3_600_000;
type Store = { actorCredentials(owner: unknown, id: string, body: unknown, key: string): Record<string, unknown>;
  snapshot(): unknown; credentialGeneration(agent: string): number; assertCredentialActive(principal: unknown): void };
type Native = { InMemoryHiveMemStore: new (options?: { snapshot: unknown }) => Store;
  createHiveMemHandler(options: { store: Store; jwtSecret: string }): (req: unknown, res: unknown) => void;
  signToken(secret: string, claims: Record<string, unknown>): string; verifyBearerToken(header: string, secret: string): unknown };

describe.skipIf(!enabled)('durable renewal against PostgreSQL and native HiveMem receipts', () => {
  let native: Native;
  let db: ReturnType<typeof import('../db/index.js')['getDb']>;
  let disconnect: () => Promise<void>;
  let server: Server;
  let origin: string;
  let now = Date.now();
  let store: Store;
  let dropReceipt = false;
  let dropDelivery = false;
  let pauseReceipt: Promise<void> | null = null;
  let receiptArrived: (() => void) | null = null;
  let delivered: string[] = [];
  const owner = { agentId: 'fixture-owner', scopes: ['admin:all'], rawClaims: { role: 'admin' } };
  const prefix = `renewal-${randomUUID()}`;
  const nodes: string[] = [];
  let ownerToken: string;

  beforeAll(async () => {
    const url = process.env['TEST_DATABASE_URL']!;
    if (!new URL(url).pathname.startsWith('/magnus_ideas_')) throw new Error('Disposable magnus_ideas_ database required');
    vi.stubEnv('DATABASE_URL', url);
    const root = resolve(process.env['HIVEMEM_CONTRACT_ROOT']!, 'dist/src');
    const modules = await Promise.all(['store', 'server', 'auth'].map(name => import(/* @vite-ignore */ pathToFileURL(resolve(root, `${name}.js`)).href)));
    native = Object.assign({}, ...modules) as Native;
    const client = await import('../db/index.js'); db = client.getDb(); disconnect = client.disconnectDb;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    ownerToken = native.signToken(secret, { sub: owner.agentId, role: 'admin', scope: 'admin:all', exp: Math.floor(now / 1000) + 7 * 86_400 });
    server = createServer((req, res) => {
      if (req.url === '/delivery') {
        let text = ''; req.on('data', chunk => { text += String(chunk); });
        req.on('end', () => {
          const input = JSON.parse(text) as { action: string; body: { token?: string } };
          if (input.action === 'hivemem-credential-set') delivered.push(input.body.token!);
          if (dropDelivery) { dropDelivery = false; res.destroy(); } else { res.end('{}'); }
        });
        return;
      }
      if (req.method === 'POST' && req.url?.startsWith('/v1/actor-credentials/')) {
        const end = res.end.bind(res);
        // The real handler commits, encrypts its receipt and flushes persistence before end().
        res.end = ((...args: Parameters<typeof res.end>) => {
          receiptArrived?.(); receiptArrived = null;
          const finish = () => { if (dropReceipt) { dropReceipt = false; res.destroy(); } else end(...args); };
          if (pauseReceipt) void pauseReceipt.then(finish); else finish();
          return res;
        }) as typeof res.end;
      }
      native.createHiveMemHandler({ store, jwtSecret: secret })(req, res);
    }).listen(0, '127.0.0.1');
    await once(server, 'listening'); const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    origin = `http://127.0.0.1:${address.port}/`;
  });
  afterAll(async () => {
    if (!enabled) return;
    server?.closeAllConnections(); await new Promise<void>(resolve => server?.close(() => resolve()));
    if (db) { await db.ardentHiveMemCredential.deleteMany({ where: { nodeId: { in: nodes } } }); await disconnect(); }
    vi.restoreAllMocks(); vi.unstubAllEnvs();
  });

  async function seed() {
    await db.ardentHiveMemCredential.deleteMany({ where: { nodeId: { in: nodes } } });
    delivered = []; store = new native.InMemoryHiveMemStore();
    const nodeId = `${prefix}-${nodes.length}`; nodes.push(nodeId);
    const policy = { action: 'enroll', agent_id: 'fixture-agent', display_name: 'Ardent lead on fixture',
      description: 'Ardent profile managed by Magnus', scopes: ['memories:read', 'memories:write', 'sessions:read', 'sessions:write'],
      workspace_id: 'default', expires_at: new Date(now + 23 * HOUR).toISOString() };
    const original = store.actorCredentials(owner, 'a'.repeat(64), policy, secret).token as string;
    const row = await db.ardentHiveMemCredential.create({ data: { nodeId, profile: 'lead', agentId: policy.agent_id, workspaceId: 'default',
      issuedAt: new Date(now - 25 * HOUR), expiresAt: new Date(policy.expires_at), nextAttemptAt: new Date(now - HOUR) } });
    return { row, original };
  }
  function worker(nodeId: string) {
    return new Promise<Record<string, number>>((resolveWorker, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', resolve(import.meta.dirname, 'ardent-hivemem-renewal-test-fixture.ts')], {
        env: { ...process.env, DATABASE_URL: process.env['TEST_DATABASE_URL'], HIVEMEM_TEST_ORIGIN: origin, HIVEMEM_TEST_NOW: new Date(now).toISOString(),
          AUDIT_HMAC_SECRET: 'synthetic-dedicated-audit-integrity-key-for-tests-only',
          HIVEMEM_TEST_NODE: nodeId, HIVEMEM_TEST_OWNER_TOKEN: ownerToken }, stdio: ['ignore', 'pipe', 'pipe'] });
      let text = ''; child.stdout.on('data', chunk => { text += String(chunk); }); child.stderr.on('data', chunk => { text += String(chunk); });
      child.on('error', reject);
      child.on('exit', code => {
        // Report only sanitized worker output. Tokens are never intentionally printed.
        const counts = /^COUNTS=(.+)$/m.exec(text);
        if (code !== 0 || !counts) reject(new Error(text.replace(/[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted]')));
        else resolveWorker(JSON.parse(counts[1]!));
      });
    });
  }

  it('migrates pristine and completed rows while holding legacy failed and in-flight attempts', async () => {
    const old = readFileSync(new URL('../../prisma/migrations/20261108040000_ardent_hivemem_credentials/migration.sql', import.meta.url), 'utf8');
    const migration = readFileSync(new URL('../../prisma/migrations/20261108060000_ardent_hivemem_retry/migration.sql', import.meta.url), 'utf8');
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe(old.slice(0, old.indexOf('CREATE UNIQUE INDEX')).replace('CREATE TABLE', 'CREATE TEMP TABLE')
        .replaceAll('"ardent_hivemem_credentials"', '"renewal_migration_fixture"'));
      await tx.$executeRawUnsafe(`INSERT INTO "renewal_migration_fixture"
        ("id", "nodeId", "profile", "agentId", "workspaceId", "issuedAt", "expiresAt", "nextAttemptAt", "updatedAt", "lastAttemptAt", "failures", "leaseUntil", "renewals")
        SELECT name, name, 'lead', 'fixture-agent', 'default', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '48 hours', CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP, CASE WHEN name = 'pristine' THEN NULL ELSE CURRENT_TIMESTAMP END,
          CASE WHEN name = 'failed' THEN 1 ELSE 0 END,
          CASE WHEN name = 'inflight' THEN CURRENT_TIMESTAMP + INTERVAL '10 minutes' ELSE NULL END,
          CASE WHEN name = 'completed' THEN 1 ELSE 0 END
        FROM (VALUES ('pristine'), ('completed'), ('failed'), ('inflight')) AS cases(name)`);
      // Each migration statement goes through PostgreSQL; Prisma rejects a multi-command prepared query.
      for (const sql of migration.replaceAll('"ardent_hivemem_credentials"', '"renewal_migration_fixture"').split(/;\s*\n/)) {
        if (sql.trim()) await tx.$executeRawUnsafe(sql);
      }
      const rows = await tx.$queryRawUnsafe<Array<{ id: string; recoveryRequired: boolean; pendingJson: string | null; renewals: number }>>(
        'SELECT "id", "recoveryRequired", "pendingJson", "renewals" FROM "renewal_migration_fixture" ORDER BY "id"');
      expect(rows).toEqual([
        { id: 'completed', recoveryRequired: false, pendingJson: null, renewals: 1 },
        { id: 'failed', recoveryRequired: true, pendingJson: null, renewals: 0 },
        { id: 'inflight', recoveryRequired: true, pendingJson: null, renewals: 0 },
        { id: 'pristine', recoveryRequired: false, pendingJson: null, renewals: 0 },
      ]);
      await tx.$executeRawUnsafe('DROP TABLE "renewal_migration_fixture"');
    });
  });

  it('commits, loses the response, restarts both stores, advances time and replays without 409 or lost access', async () => {
    const { row, original } = await seed();
    dropReceipt = true;
    expect(await worker(row.nodeId)).toMatchObject({ failed: 1 });
    const pending = await db.ardentHiveMemCredential.findUniqueOrThrow({ where: { id: row.id } });
    expect(pending.pendingJson).toBeTruthy(); expect(store.credentialGeneration('fixture-agent')).toBe(1);
    // A changed digest really is a 409 at this boundary.
    const plan = JSON.parse(pending.pendingJson!).plan;
    const { createHash } = await import('node:crypto');
    const id = createHash('sha256').update(`magnus-ardent:${plan.key}`).digest('hex');
    const conflict = await fetch(new URL(`v1/actor-credentials/${id}`, origin), { method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...plan.request, expires_at: new Date(now + 47 * HOUR).toISOString() }) });
    expect(conflict.status).toBe(409);
    store = new native.InMemoryHiveMemStore({ snapshot: structuredClone(store.snapshot()) });
    now += 2 * 60_000;
    const result = await worker(row.nodeId);
    expect((await db.ardentHiveMemCredential.findUniqueOrThrow({ where: { id: row.id } })).lastError).toBeNull();
    expect(result).toMatchObject({ renewed: 1 });
    expect(store.credentialGeneration('fixture-agent')).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(() => store.assertCredentialActive(native.verifyBearerToken(`Bearer ${original}`, secret))).not.toThrow();
    now += 25 * HOUR;
    expect(() => store.assertCredentialActive(native.verifyBearerToken(`Bearer ${delivered[0]}`, secret))).not.toThrow();
    expect(() => store.assertCredentialActive(native.verifyBearerToken(`Bearer ${original}`, secret))).toThrow();
    expect(await db.ardentHiveMemCredential.findUnique({ where: { id: row.id } })).toMatchObject({ renewals: 1, pendingJson: null, recoveryRequired: false });
  });

  it('retries a committed node write with the same token instead of rotating it', async () => {
    const { row } = await seed(); dropDelivery = true;
    expect(await worker(row.nodeId)).toMatchObject({ failed: 1 });
    now += 2 * 60_000;
    expect(await worker(row.nodeId)).toMatchObject({ renewed: 1 });
    expect(delivered).toHaveLength(2); expect(delivered[0] === delivered[1]).toBe(true);
    expect(store.credentialGeneration('fixture-agent')).toBe(1);
  });

  it('holds an expired receipt for explicit recovery without issuing another credential or extending grace', async () => {
    const { row } = await seed(); dropReceipt = true;
    await worker(row.nodeId); const snapshot = structuredClone(store.snapshot());
    now += 16 * 60_000;
    expect(await worker(row.nodeId)).toMatchObject({ failed: 1 });
    expect(await db.ardentHiveMemCredential.findUnique({ where: { id: row.id } })).toMatchObject({ renewals: 0, recoveryRequired: true });
    now += HOUR;
    expect(await worker(row.nodeId)).toMatchObject({ renewed: 0, failed: 0 });
    expect(store.credentialGeneration('fixture-agent')).toBe(1); expect(delivered).toEqual([]);
    expect(store.snapshot()).toEqual(snapshot);
  });

  it('only one concurrent process claims an operation; a stale claim cannot complete after takeover', async () => {
    const { row } = await seed();
    let release!: () => void; pauseReceipt = new Promise<void>(resolve => { release = resolve; });
    const arrived = new Promise<void>(resolve => { receiptArrived = resolve; });
    const first = worker(row.nodeId); await arrived;
    expect(await worker(row.nodeId)).toMatchObject({ skipped: 1 });
    now += 11 * 60_000;
    pauseReceipt = null;
    expect(await worker(row.nodeId)).toMatchObject({ renewed: 1 });
    release(); expect(await first).toMatchObject({ skipped: 1 });
    expect(delivered).toHaveLength(1); expect(store.credentialGeneration('fixture-agent')).toBe(1);
    expect(await db.ardentHiveMemCredential.findUnique({ where: { id: row.id } })).toMatchObject({ renewals: 1, pendingJson: null });
  });
});
