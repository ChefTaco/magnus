// Disposable browser harness: imports the real API without startup collectors or
// remote command workers, and runs an isolated copy of the standalone dashboard behind its
// production wrapper (server-tls.mjs, which carries the Hermes WebSocket bridge). The Control API
// answers over TLS from a throwaway CA, and a fixture node serves one Hermes installation over SSH
// (scripts/ci-hermes-ssh-fixture.mjs), so the console reaches it the way it does in production.
import { mkdtemp, cp, mkdir, rm, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { fixtureNodeAddress, startHermesSshFixture } from './ci-hermes-ssh-fixture.mjs';
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

// A throwaway CA and a certificate for the Control API (the console verifies it, never skips).
const tls = join(scratch, 'tls');
await mkdir(tls, { recursive: true, mode: 0o700 });
const openssl = (args) => execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1',
  '-subj', '/CN=Magnus browser harness CA', '-addext', 'basicConstraints=critical,CA:TRUE',
  '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', join(tls, 'ca.key'), '-out', join(tls, 'ca.pem')]);
openssl(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', '/CN=localhost',
  '-keyout', join(tls, 'api.key'), '-out', join(tls, 'api.csr')]);
await writeFile(join(tls, 'api.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n'
  + 'keyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n');
openssl(['x509', '-req', '-in', join(tls, 'api.csr'), '-CA', join(tls, 'ca.pem'), '-CAkey', join(tls, 'ca.key'),
  '-CAcreateserial', '-days', '1', '-extfile', join(tls, 'api.ext'), '-out', join(tls, 'api.pem')]);

// The Hermes fixture node: one installation on the inert browser-ci-node, reached over SSH.
const HERMES_INSTALLATION_ID = 'browser-ci-hermes';
const HERMES_SSH_PORT = 55444;
// tests/embedded-isolation.spec.ts serves the dashboard here, on the node's loopback.
const HERMES_DASHBOARD_PORT = 55443;
const hermesAddress = fixtureNodeAddress();
const hermesDirectory = join(scratch, 'hermes');
await mkdir(hermesDirectory, { recursive: true, mode: 0o700 });
const hermesNode = await startHermesSshFixture({
  directory: hermesDirectory,
  address: hermesAddress,
  sshPort: HERMES_SSH_PORT,
  dashboardPort: HERMES_DASHBOARD_PORT,
  installationId: HERMES_INSTALLATION_ID,
  nodeId: 'browser-ci-node',
  username: 'magnus-proxy',
});

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
  // The external console is unavailable; fleet operations must remain usable.
  SECURITY_FUSION_MODE: 'remote',
  MAGNUS_SECURITY_CONSOLE_URL: 'https://security.example.invalid',
  SECURITY_FUSION_API_URL: 'https://security.example.invalid',
  SECURITY_EXPORT_ENABLED: 'false',
  NODE_MANAGER_SECRET: 'ci-only-node-secret-0123456789abcdef0123456789',
  AUDIT_HMAC_SECRET: 'ci-only-audit-secret-0123456789abcdef0123456789',
  WEBHOOK_ENCRYPTION_KEY: 'ci-only-webhook-key-0123456789abcdef0123456789',
  SESSION_SECRET: 'ci-only-session-secret-0123456789abcdef0123456789',
  CONTROL_NODE_CREDENTIAL_KEY:
    'ci-only-registry-key-0123456789abcdef0123456789',
  CONTROL_API_URL: 'https://localhost:55441',
  CONTROL_API_CA_PATH: join(tls, 'ca.pem'),
  // The Hermes fixture node (see above); the dashboard itself is the spec's.
  MAGNUS_HERMES_ENABLED: 'true',
  HERMES_SSH_ALLOWED_CIDRS: `${hermesAddress}/32`,
  HERMES_SSH_AUTHORIZATIONS_FILE: hermesNode.authorizationsPath,
  DASHBOARD_SSH_USERNAME: 'magnus-proxy',
  DASHBOARD_SSH_PRIVATE_KEY_PATH: hermesNode.clientKeyPath,
  MAGNUS_UI_ALLOW_HTTP: 'true',
  // The console announces its SSH work to the Control API before it opens a connection to a node.
  RESOURCE_ENROLLMENT_DASHBOARD_SECRET: 'ci-only-dashboard-participant-0123456789abcdef',
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
    // The Hermes fixture node's address: the console's SSH work must name an inventory node.
    // Nothing answers on port 9 there, so the node stays inert to agent calls.
    ipAddress: hermesAddress,
    port: 9,
    token: 'ci-only-inert-node-token',
    os: 'linux',
    arch: 'x64',
    status: 'ONLINE',
    lastHeartbeatAt: new Date(),
  },
  update: { lastHeartbeatAt: new Date(), ipAddress: hermesAddress },
});
// A same-major prerelease remains behind even at the first stable major release.
const targetVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const fixtureAgentVersion = `${targetVersion.split('-')[0]}-0`;
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
      upgrade: { state: 'idle', from: null, to: fixtureAgentVersion }, nodeVersion: 'v24.22.3', observedAt: new Date().toISOString() } }),
    agent: { create: { version: fixtureAgentVersion, status: 'RUNNING', capabilities: '[]' } },
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
await db.hermesInstallation.upsert({
  where: { id: HERMES_INSTALLATION_ID },
  create: {
    id: HERMES_INSTALLATION_ID,
    nodeId: 'browser-ci-node',
    hostname: hermesAddress,
    sshPort: HERMES_SSH_PORT,
    displayName: 'Browser CI Hermes',
    installMode: 'existing',
    status: 'running',
    gatewayStatus: 'running',
    dashboardHost: '127.0.0.1',
    dashboardPort: HERMES_DASHBOARD_PORT,
    dashboardStatus: 'running',
  },
  update: { hostname: hermesAddress, sshPort: HERMES_SSH_PORT, dashboardPort: HERMES_DASHBOARD_PORT },
});
const server = serve({
  fetch: app.fetch,
  hostname: '127.0.0.1',
  port: 55441,
  createServer: createHttpsServer,
  serverOptions: { key: readFileSync(join(tls, 'api.key')), cert: readFileSync(join(tls, 'api.pem')) },
});
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
  if (file === 'server-tls.mjs' || /^runtime-.*\.(mjs|json)$/.test(file))
    await cp(join(root, 'apps/dashboard', file), join(dashboard, file));
// The wrapper's own dependencies (ws, jose, …) are runtime dependencies of the published package;
// here they resolve from the checkout, as from an install's node_modules.
await symlink(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
const startConsole = (env) => spawn(process.execPath, [join(dashboard, 'server-tls.mjs')], {
  cwd: dashboard,
  env: { ...env, NODE_ENV: 'production' },
  stdio: 'inherit',
});
const consoles = [
  startConsole(testEnv),
  // The same build without the Hermes integration (tests/hermes-disabled.spec.ts). It shares the
  // session store, so the signed-in browser state works on both.
  startConsole({ ...Object.fromEntries(Object.entries(testEnv).filter(([name]) => name !== 'MAGNUS_HERMES_ENABLED')),
    PORT: '55452', DASHBOARD_PUBLIC_ORIGIN: 'http://localhost:55452', CORS_ORIGIN: 'http://localhost:55452' }),
];
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await Promise.all(consoles.map((child) => new Promise(resolveExit => {
    if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(timer); resolveExit(); });
    child.kill('SIGTERM');
  })));
  await new Promise(resolveClose => server.close(resolveClose));
  await hermesNode.close();
  await db.$disconnect();
  await rm(scratch, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
for (const child of consoles) {
  child.on('exit', (code) => {
    if (code) process.exit(code);
  });
}
console.log(`Disposable browser harness: ${scratch}`);
