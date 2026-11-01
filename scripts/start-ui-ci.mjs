// Disposable browser harness: imports the real API without startup collectors or
// remote command workers, and runs an isolated copy of the standalone dashboard.
import { mkdtemp, cp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { serve } from '@hono/node-server';
const root = resolve(import.meta.dirname, '..');
const url = new URL(process.env.TEST_DATABASE_URL ?? '');
if (
  !['localhost', '127.0.0.1'].includes(url.hostname) ||
  !url.pathname.startsWith('/magnus_ideas')
)
  throw new Error('Disposable local magnus_ideas database required');
const redisUrl = process.env.UI_TEST_REDIS_URL ?? 'redis://127.0.0.1:55440';
if (!['localhost', '127.0.0.1'].includes(new URL(redisUrl).hostname))
  throw new Error('Local disposable Redis required');
const scratch = await mkdtemp(join(tmpdir(), 'magnus-ui-ci-'));
const testEnv = {
  PATH: process.env.PATH,
  HOME: scratch,
  NODE_ENV: 'test',
  DATABASE_URL: url.toString(),
  REDIS_URL: redisUrl,
  REDIS_PREFIX: 'magnus-ui-ci-',
  API_SECRET: 'ci-only-api-secret-0123456789abcdef0123456789',
  JWT_SECRET: 'ci-only-api-jwt-0123456789abcdef0123456789',
  CREDENTIAL_ROTATION_KEY: 'ci-only-rotation-key-0123456789abcdef0123456789',
  CREDENTIAL_ROTATION_STATE_PATH: join(scratch, 'rotations.json'),
  // Security Fusion export is off by default; the browser suite covers its local mode.
  SECURITY_FUSION_MODE: 'local',
  SECURITY_FUSION_RECEIPT_SIGNING_KEY: 'ci-only-receipt-key-0123456789abcdef0123456789',
  SECURITY_FUSION_EVIDENCE_DIR: join(scratch, 'security-fusion/evidence'),
  NODE_MANAGER_SECRET: 'ci-only-node-secret-0123456789abcdef0123456789',
  AUDIT_HMAC_SECRET: 'ci-only-audit-secret-0123456789abcdef0123456789',
  WEBHOOK_ENCRYPTION_KEY: 'ci-only-webhook-key-0123456789abcdef0123456789',
  SESSION_SECRET: 'ci-only-session-secret-0123456789abcdef0123456789',
  CONTROL_NODE_CREDENTIAL_KEY:
    'ci-only-registry-key-0123456789abcdef0123456789',
  CONTROL_API_URL: 'http://localhost:55441',
  DASHBOARD_PUBLIC_ORIGIN: 'http://localhost:55442',
  DASHBOARD_ADMIN_USERNAME: 'ci-admin',
  DASHBOARD_ADMIN_PASSWORD: 'ci-only-browser-password',
  AUDIT_LOG_DIR: join(scratch, 'audit'),
  UI_SECURITY_LOG_PATH: join(scratch, 'ui-security/events.jsonl'),
  CORS_ORIGIN: 'http://localhost:55442',
  // Hermetic: no npm registry reads from the browser suite.
  MAGNUS_UPDATE_CHECK: 'false',
  AUTH_TRUST_PROXY: 'false',
  HOSTNAME: '127.0.0.1',
  PORT: '55442',
};
// Avoid inheriting fleet credentials or loading the checkout's .env files.
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, testEnv);
process.chdir(scratch);
const { app } = await import(`${root}/services/control-api/dist/server.js`);
const { getDb } = await import(`${root}/services/control-api/dist/db/index.js`);
const db = getDb();
for (const id of ['__control-api__', '__dashboard__'])
  await db.node.upsert({
    where: { id },
    create: {
      id,
      name: id,
      hostname: id,
      ipAddress: '127.0.0.1',
      token: `ci-sentinel-${id}`,
      os: 'virtual',
      arch: 'virtual',
      metadata: '{"sentinel":true}',
    },
    update: {},
  });
await db.node.upsert({
  where: { id: 'browser-ci-node' },
  create: {
    id: 'browser-ci-node',
    name: 'Browser CI node',
    hostname: 'browser-ci.invalid',
    ipAddress: '127.0.0.1',
    port: 9,
    token: 'ci-only-inert-node-token',
    os: 'linux',
    arch: 'x64',
    status: 'ONLINE',
    lastHeartbeatAt: new Date(),
  },
  update: { lastHeartbeatAt: new Date() },
});
// A node whose agent reports that it can upgrade itself, one release behind.
await db.node.upsert({
  where: { id: 'browser-ci-upgradable' },
  create: {
    id: 'browser-ci-upgradable',
    name: 'Browser CI upgradable',
    hostname: 'browser-ci-upgradable.invalid',
    // Distinct from browser-ci-node, so address-based lookups stay unambiguous.
    ipAddress: '127.0.0.2',
    port: 9,
    token: 'ci-only-inert-upgradable-token',
    os: 'linux',
    arch: 'x64',
    status: 'ONLINE',
    lastHeartbeatAt: new Date(),
    metadata: JSON.stringify({ agentSelfUpgrade: { protocol: 1, launcherProtocol: 1, layout: 'versioned', enabled: true, reason: null,
      upgrade: { state: 'idle', from: null, to: '1.0.0' }, nodeVersion: 'v24.22.1', observedAt: new Date().toISOString() } }),
    agent: { create: { version: '1.0.0', status: 'RUNNING', capabilities: '[]' } },
  },
  update: { lastHeartbeatAt: new Date() },
});
await db.executionRun.upsert({
  where: { id: 'browser-ci-rollout' },
  create: {
    id: 'browser-ci-rollout',
    type: 'command',
    status: 'running',
    rolloutStrategy: 'one_at_a_time',
    createdBy: 'browser-ci',
    totalNodes: 1,
    metadata: '{}',
  },
  update: { status: 'running' },
});
// Named bearer fixtures still need current users: the API rechecks active
// status and role rather than trusting the signed role snapshot alone.
for (const [id, role] of [['browser-viewer', 'VIEWER'], ['browser-operator', 'OPERATOR']]) {
  await db.user.upsert({ where: { id }, create: { id, email: `${id}@fixture.invalid`, name: id,
    password: 'fixture-has-no-password-login', role, active: true }, update: { role, active: true } });
}
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 55441 });
await cp(
  join(root, 'apps/dashboard/.next/standalone'),
  join(scratch, 'standalone'),
  {
    recursive: true,
    filter: (source) => !/(?:^|\/)(?:\.env(?:\..*)?|\.magnus)$/.test(source),
  },
);
const dashboard = join(scratch, 'standalone/apps/dashboard');
await mkdir(join(dashboard, '.next'), { recursive: true });
await cp(
  join(root, 'apps/dashboard/.next/static'),
  join(dashboard, '.next/static'),
  { recursive: true },
);
await cp(join(root, 'apps/dashboard/public'), join(dashboard, 'public'), {
  recursive: true,
}).catch((e) => {
  if (e.code !== 'ENOENT') throw e;
});
// Runtime helpers are deliberately inspected and shipped by deployment tooling.
const { readdir } = await import('node:fs/promises');
for (const file of await readdir(join(root, 'apps/dashboard')))
  if (/^runtime-.*\.(mjs|json)$/.test(file))
    await cp(join(root, 'apps/dashboard', file), join(dashboard, file));
const child = spawn(process.execPath, [join(dashboard, 'server.js')], {
  cwd: dashboard,
  env: { ...testEnv, NODE_ENV: 'production' },
  stdio: 'inherit',
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise(resolveExit => {
      if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => { clearTimeout(timer); resolveExit(); });
      child.kill('SIGTERM');
    });
  }
  await new Promise(resolveClose => server.close(resolveClose));
  await db.$disconnect();
  await rm(scratch, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
child.on('exit', (code) => {
  if (code) process.exit(code);
});
console.log(`Disposable browser harness: ${scratch}`);
