import { createHmac, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { resolveSessionSecret } from './runtime-session-secret.mjs';
const COOKIE_NAME = 'magnus_session';
const SESSION_DURATION = 86400;
const getSecretKey = () => new TextEncoder().encode(resolveSessionSecret());
import { resolveDashboardLoginCredentials } from './runtime-dashboard-credentials.mjs';

let client;
async function redis() {
  if (!client) {
    client = new Redis(process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      commandTimeout: 2500,
      enableOfflineQueue: false,
    });
    client.on('error', () => undefined);
  }
  if (client.status === 'connecting' || client.status === 'connect')
    await new Promise((resolve, reject) => {
      const ready = () => {
        client.off('error', failed);
        resolve();
      };
      const failed = (error) => {
        client.off('ready', ready);
        reject(error);
      };
      client.once('ready', ready);
      client.once('error', failed);
    });
  return client;
}
function userKey(username) {
  return `${COOKIE_NAME}:local:${createHmac('sha256', getSecretKey()).update(username).digest('hex')}`;
}
function credentialGeneration() {
  const credentials = resolveDashboardLoginCredentials();
  return createHmac('sha256', getSecretKey())
    .update(
      JSON.stringify([
        credentials.username,
        credentials.passwordHash ?? credentials.password,
        process.env['LOCAL_SESSION_GENERATION'] ?? '',
      ]),
    )
    .digest('hex');
}
const CREATE = `
local generation = redis.call('GET', KEYS[1]) or ARGV[1]
redis.call('SET', KEYS[1], generation, 'EX', ARGV[4])
local time = redis.call('TIME')
local now = time[1] * 1000000 + time[2]
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local oldest = redis.call('ZRANGE', KEYS[2], 0, -50)
for _, id in ipairs(oldest) do redis.call('DEL', ARGV[6] .. id); redis.call('ZREM', KEYS[2], id) end
redis.call('ZADD', KEYS[2], now + ARGV[4] * 1000000, ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[4])
redis.call('SET', KEYS[3], generation .. ':' .. ARGV[3], 'EX', ARGV[4])
return generation
`;
export async function createLocalSession(username) {
  const id = randomUUID(),
    key = userKey(username);
  await (
    await redis()
  ).eval(
    CREATE,
    3,
    `${key}:generation`,
    `${key}:sessions`,
    `${key}:session:${id}`,
    randomUUID(),
    id,
    credentialGeneration(),
    SESSION_DURATION,
    Math.floor(Date.now() / 1000),
    `${key}:session:`,
  );
  return id;
}
export async function verifyLocalSession(session) {
  if (session.provider === 'hive') return true;
  if (
    typeof session.username !== 'string' ||
    !session.sessionId ||
    !/^[a-f0-9-]{36}$/.test(session.sessionId)
  )
    return false;
  const key = userKey(session.username);
  const [generation, record] = await (
    await redis()
  ).mget(`${key}:generation`, `${key}:session:${session.sessionId}`);
  return Boolean(generation && record === `${generation}:${credentialGeneration()}`);
}
export async function revokeLocalSession(session, all = false) {
  if (session.provider === 'hive') return;
  const key = userKey(session.username);
  if (all) await (await redis()).set(`${key}:generation`, randomUUID(), 'EX', SESSION_DURATION);
  else if (session.sessionId) await (await redis()).del(`${key}:session:${session.sessionId}`);
}
