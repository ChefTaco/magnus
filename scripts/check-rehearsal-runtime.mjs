#!/usr/bin/env node
// Real server boot and restored Redis queue preservation, using only new fixture
// resources. No existing installation, database, queue or agent is selected.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import https from 'node:https';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { bullQueueIdentity } from '../services/control-api/dist/queue/names.js';
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  assert(['--image', '--redis-image', '--output'].includes(process.argv[index]) && process.argv[index + 1]);
  options[process.argv[index].slice(2)] = process.argv[index + 1];
}
for (const image of [options.image, options['redis-image']]) assert(/^(?:sha256:|[a-z0-9./:_-]+@sha256:)[a-f0-9]{64}$/.test(image), 'Exact local image IDs or registry digests are required');
assert(options.output, '--output NEW_PRIVATE_DIRECTORY is required');
const output = resolve(options.output); assert(!existsSync(output)); mkdirSync(output, { mode: 0o700, recursive: true }); chmodSync(output, 0o700);
const put = (name, data) => { const path = join(output, name); writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data, null, 2), { mode: 0o600 }); chmodSync(path, 0o600); return path; };
const execute = (program, args) => execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 }).trim();
const docker = (...args) => execute('docker', args);
const id = 'magnus-rehearsal-' + randomBytes(6).toString('hex'), redisName = id + '-redis', apiName = id + '-api';
async function port() { const server = createServer().listen(0, '127.0.0.1'); await new Promise(done => server.once('listening', done)); const selected = server.address().port; await new Promise(done => server.close(done)); return selected; }
const redisPort = await port(), apiPort = await port(), password = randomBytes(32).toString('hex');
let connection, queues = [];
try {
  const authority = join(output, 'authority.pem'), authorityKey = join(output, 'authority.key'), cert = join(output, 'server.pem'), key = join(output, 'server.key');
  execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', authorityKey, '-out', authority, '-subj', '/CN=Synthetic rehearsal authority', '-days', '1']);
  execute('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', join(output, 'server.csr'), '-subj', '/CN=localhost']);
  put('leaf.extensions', 'basicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n');
  execute('openssl', ['x509', '-req', '-in', join(output, 'server.csr'), '-CA', authority, '-CAkey', authorityKey, '-set_serial', '10001', '-out', cert, '-days', '1', '-extfile', join(output, 'leaf.extensions')]);
  for (const name of ['authority.pem', 'authority.key', 'server.pem', 'server.key', 'server.csr']) chmodSync(join(output, name), 0o600);
  const redisConfig = put('redis.conf', `bind 0.0.0.0\nprotected-mode yes\nrequirepass ${password}\nsave ""\nappendonly no\n`);
  docker('network', 'create', id);
  docker('run', '-d', '--name', redisName, '--network', id, '--user', `${process.getuid()}:${process.getgid()}`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', `/data:rw,uid=${process.getuid()},gid=${process.getgid()},mode=0700`, '-p', `127.0.0.1:${redisPort}:6379`, '-v', redisConfig + ':/run/redis.conf:ro', '--entrypoint', 'redis-server', options['redis-image'], '/run/redis.conf');
  const redisUrl = `redis://:${password}@127.0.0.1:${redisPort}`;
  connection = new Redis(redisUrl, { maxRetriesPerRequest: 1 }); connection.on('error', () => undefined);
  await connection.ping();
  for (const kind of ['commands', 'webhooks']) {
    const identity = bullQueueIdentity('synthetic-rehearsal:', kind);
    const queue = new Queue(identity.name, { prefix: identity.prefix, connection: { host: '127.0.0.1', port: redisPort, password } });
    queues.push(queue);
    await queue.add('synthetic-restored-work', kind === 'commands' ? { commandId: 'synthetic-retained-command' } : { endpointId: 'synthetic-retained-endpoint' }, { jobId: 'retained-' + kind });
    await queue.close();
  }
  async function snapshot() {
    const result = {};
    for (const key of (await connection.keys('*')).sort()) result[key] = createHash('sha256').update(await connection.dumpBuffer(key)).digest('hex');
    return result;
  }
  const before = await snapshot(); put('queues-before.json', before);
  const environment = {
    NODE_ENV: 'production', LOG_LEVEL: 'error', HIVE_REHEARSAL: 'true', MAGNUS_AUTO_MIGRATE: 'false',
    CONTROL_API_BIND_HOST: '0.0.0.0', CONTROL_API_PORT: '4000', CONTROL_API_URL: 'https://localhost:' + apiPort,
    DATABASE_URL: 'postgresql://fixture:synthetic@unconfigured.invalid:5432/magnus_fixture',
    REDIS_URL: `redis://:${password}@${redisName}:6379`, REDIS_PREFIX: 'synthetic-rehearsal:',
    CORS_ORIGIN: 'https://console.example.com', TLS_CERT_PATH: '/config/server.pem', TLS_KEY_PATH: '/config/server.key',
    AUDIT_LOG_DIR: '/state/audit', CREDENTIAL_ROTATION_STATE_FILE: '/state/credential-rotations.json',
  };
  for (const name of ['JWT_SECRET', 'API_SECRET', 'NODE_MANAGER_SECRET', 'AUDIT_HMAC_SECRET', 'RESULT_SIGNING_SECRET', 'LOG_INGEST_SIGNING_SECRET', 'CREDENTIAL_ROTATION_KEY', 'METRICS_TOKEN', 'WEBHOOK_ENCRYPTION_KEY']) environment[name] = randomBytes(32).toString('hex');
  const envFile = put('server.env', Object.entries(environment).map(([name, value]) => `${name}=${value}`).join('\n') + '\n');
  docker('run', '-d', '--name', apiName, '--network', id, '--user', `${process.getuid()}:${process.getgid()}`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', `/state:rw,uid=${process.getuid()},gid=${process.getgid()},mode=0700`, '--tmpfs', '/tmp:rw,mode=1777', '-p', `127.0.0.1:${apiPort}:4000`, '-v', output + ':/config:ro', '--env-file', envFile, options.image);
  const request = (path, method = 'GET') => new Promise((done, reject) => {
    const req = https.request({ hostname: 'localhost', port: apiPort, path, method, ca: readFileSync(authority), timeout: 2000 }, res => {
      let body = ''; res.on('data', bytes => body += bytes); res.on('end', () => done({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(Error('Fixture request timeout'))); req.end();
  });
  let ready = false;
  for (let index = 0; index < 120; index++) {
    try { if ((await request('/api/v1/health')).status === 200) { ready = true; break; } } catch {}
    await new Promise(done => setTimeout(done, 500));
  }
  assert(ready, 'Isolated API did not become ready; inspect its protected log');
  for (const path of ['/api/v1/commands', '/api/v1/heartbeat', '/api/v1/auth/login', '/api/v1/terminal/tickets']) {
    const response = await request(path, 'POST'); assert.equal(response.status, 503); assert.equal(response.body.error.code, 'REHEARSAL_READ_ONLY');
  }
  await new Promise(done => setTimeout(done, 6500)); // Longer than queue reconciliation and dispatch ticks.
  const after = await snapshot(); put('queues-after.json', after); assert.deepEqual(after, before);
  put('result.json', { schema: 1, result: 'passed', productionCutover: false, restoredCommandsDormant: true, restoredWebhooksDormant: true,
    exactRedisValuePreservation: true, mutationHandlersHeld: true, image: options.image,
    limitation: 'No application database or production state selected; full database/identity restore acceptance is separate' });
  console.log('PASS: real isolated API keeps restored command/webhook queues unchanged and holds mutations.');
} finally {
  try { put('server.log', docker('logs', apiName)); } catch {}
  for (const queue of queues) await queue.close().catch(() => undefined);
  if (connection) await connection.quit().catch(() => undefined);
  for (const name of [apiName, redisName]) try { docker('rm', '-f', name); } catch {}
  try { docker('network', 'rm', id); } catch {}
}
