import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createOathweaveVerifier, OATHWEAVE_SESSION_CACHE_TTL_MS, type OathweaveIdentityLink } from '@hivemagnus/magnus-oathweave';
import { createApp } from '../src/app.js';
import { createAuditor, createRefusalAuditor } from '../src/audit.js';
import { createAuthorizer } from '../src/authorize.js';
import { createConnect } from '../src/connect.js';
import type { AuditEvent, ControlApi, NodeRecord } from '../src/control-api.js';
import { approveNewNode, createKnownHosts } from '../src/known-hosts.js';
import { createResourceParticipant, type ManagedWork, type ParticipantRequest } from '../src/participant.js';
import { createSessionManager, type SessionLimits } from '../src/sessions.js';
import type { PtySize, ShellChannel, ShellConnector } from '../src/ssh.js';
import type { SshTarget } from '../src/target.js';

export const ISSUER = 'https://identity.example.com';
export const ORIGIN = 'https://console.example.com';
export const ALICE = 'subject-alice';
export const BOB = 'subject-bob';
export const NODE = 'node-1';
export const NODE_HOST = 'node-1.example.com';
export const FINGERPRINT = `SHA256:${'A'.repeat(43)}`;
export const DRAIN_KEY = 'fixture-resource-participant-secret-32';

export const LINKS: OathweaveIdentityLink[] = [
  { issuer: ISSUER, subject: ALICE, localUserId: 'alice', role: 'ADMIN' },
  { issuer: ISSUER, subject: BOB, localUserId: 'bob', role: 'ADMIN' },
  { issuer: ISSUER, subject: 'subject-operator', localUserId: 'olivia', role: 'OPERATOR' },
  { issuer: ISSUER, subject: 'subject-viewer', localUserId: 'victor', role: 'VIEWER' },
  { issuer: ISSUER, subject: 'subject-duplicate', localUserId: 'dana', role: 'ADMIN' },
  { issuer: ISSUER, subject: 'subject-duplicate', localUserId: 'dana-2', role: 'ADMIN' },
];

const signing = await generateKeyPair('RS256');
export const foreignKey = (await generateKeyPair('RS256')).privateKey;
export const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(signing.publicKey), kid: 'fixture', alg: 'RS256', use: 'sig' }] });

export const clock = { offset: 0 };
export const now = () => Date.now() + clock.offset;

export interface TokenOptions {
  subject?: string; issuer?: string; audience?: string; permissions?: string[]; authAge?: number | null; authTime?: unknown;
  lifetime?: number; sessionId?: string; actorType?: string; key?: CryptoKey; claims?: Record<string, unknown>;
}

export function mint(options: TokenOptions = {}): Promise<string> {
  const at = Math.floor(now() / 1000);
  const authAge = options.authAge === undefined ? 30 : options.authAge;
  const authTime = 'authTime' in options ? options.authTime : authAge === null ? undefined : at - authAge;
  return new SignJWT({
    actorType: options.actorType ?? 'USER', sessionId: options.sessionId ?? `oath-${options.subject ?? ALICE}`, clientId: 'hivexui-magnus', roles: [],
    permissions: options.permissions ?? ['magnus:terminal', 'magnus:view'],
    ...(authTime !== undefined ? { auth_time: authTime } : {}), ...options.claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? 'magnus')
    .setSubject(options.subject ?? ALICE)
    .setJti(randomUUID())
    .setIssuedAt(at)
    .setExpirationTime(at + (options.lifetime ?? 600))
    .sign(options.key ?? signing.privateKey);
}

/** Identity service double. Userinfo answers from the revoked set, as Oathweave does. */
export function identityService() {
  const revoked = new Set<string>();
  const fetcher: typeof fetch = async (_input, init) => {
    const token = new Headers(init?.headers).get('authorization')?.slice(7) ?? '';
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { sub: string; sessionId: string };
    return revoked.has(claims.sessionId) ? new Response('{}', { status: 401 }) : Response.json({ sub: claims.sub });
  };
  return {
    revoked,
    verify: createOathweaveVerifier(
      { issuer: ISSUER, jwksUrl: `${ISSUER}/jwks`, userinfoUrl: `${ISSUER}/userinfo`, audience: 'magnus' },
      { keys, fetch: fetcher, now },
    ),
  };
}

export class FakeShell implements ShellChannel {
  written: string[] = [];
  sizes: PtySize[] = [];
  paused = false;
  terminated = 0;
  congested = false;
  private data = new EventEmitter();
  private closers: Array<(code: number | null) => void> = [];
  write(value: string) { this.written.push(value); return true; }
  resize(size: PtySize) { this.sizes.push(size); }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  onData(listener: (chunk: Buffer) => void) { this.data.on('data', listener); }
  onClose(listener: (code: number | null) => void) { this.closers.push(listener); }
  terminate() { this.terminated += 1; this.remoteClose(null); }
  emit(text: string | Buffer) { this.data.emit('data', Buffer.from(text)); }
  remoteClose(code: number | null) { for (const listener of this.closers.splice(0)) listener(code); }
}

export interface Harness {
  app: ReturnType<typeof createApp>;
  appDependencies: Parameters<typeof createApp>[0];
  shells: FakeShell[];
  targets: SshTarget[];
  calls: string[];
  audits: AuditEvent[];
  lines: string[];
  inventory: Map<string, NodeRecord>;
  revoked: Set<string>;
  sessions: ReturnType<typeof createSessionManager>;
  knownHostsFile: string;
  addresses: Map<string, string[]>;
  shellError: { value: Error | null };
  gate: { value: Promise<void> | null };
  /** Make the next reservations refuse, as the Magnus API does during a drain. */
  refuseAdmission(error: Error | null): void;
  auditFailure: { value: boolean };
  dispose(): void;
}

export const LIMITS: SessionLimits = {
  idleTimeoutMs: 900_000, maxLifetimeMs: 3_600_000, detachGraceMs: 3_600_000, recheckMs: 3_600_000, maxPerSubject: 3, maxTotal: 5,
  maxBufferedBytes: 1024 * 1024, opensPerMinute: 100,
};

/** The real app, authorizer, trust store, target rules and participant, with fake SSH and a fake API. */
export function harness(overrides: Partial<SessionLimits> = {}): Harness {
  const directory = mkdtempSync(join(tmpdir(), 'fleet-gateway-test-'));
  const trustDirectory = join(directory, 'known-hosts');
  mkdirSync(trustDirectory, { mode: 0o700 });
  chmodSync(trustDirectory, 0o700);
  const knownHostsFile = join(trustDirectory, 'known-hosts.json');
  approveNewNode(knownHostsFile, NODE, NODE_HOST, 22, { fingerprint: FINGERPRINT, approvedBy: 'admin', approvalRef: 'fixture-1', approvedAt: new Date().toISOString() });

  const shells: FakeShell[] = [];
  const targets: SshTarget[] = [];
  const calls: string[] = [];
  const audits: AuditEvent[] = [];
  const lines: string[] = [];
  const inventory = new Map<string, NodeRecord>([[NODE, { nodeId: NODE, hostname: NODE_HOST, ipAddress: '10.0.0.5', status: 'ONLINE' }]]);
  const addresses = new Map<string, string[]>([[NODE_HOST, ['10.0.0.5']]]);
  const shellError = { value: null as Error | null };
  const gate = { value: null as Promise<void> | null };
  const auditFailure = { value: false };
  const { revoked, verify } = identityService();
  const authorizer = createAuthorizer(verify, LINKS, now);

  let refusal: Error | null = null;
  const participantRequest: ParticipantRequest = async (path, body) => {
    calls.push(`participant:${path.split('/').pop()}`);
    if (refusal && path === '/work/reserve') throw refusal;
    const input = body as Record<string, unknown>;
    if (path === '/work/reserve') {
      return { ...input, participant: 'dashboard', nodeId: NODE, nodeFqdn: NODE_HOST, state: 'reserved', epoch: 0, barrierId: null, requestSha256: 'b'.repeat(64), fence: '1' };
    }
    if (path.endsWith('/start')) {
      const workId = path.split('/')[2]!;
      return { ...input, workId, participant: 'dashboard', kind: 'terminal-http', nodeId: NODE, nodeFqdn: NODE_HOST, state: 'running' };
    }
    return { state: 'unknown' };
  };
  const api: ControlApi = {
    resolveNode: async (nodeId) => { calls.push('resolve'); return inventory.get(nodeId) ?? null; },
    audit: async (event) => {
      if (auditFailure.value) throw new Error('audit down');
      audits.push(event);
    },
    participant: (path, body) => participantRequest(path, body),
  };
  const shell: ShellConnector = async (target, size) => {
    calls.push('shell');
    targets.push(target);
    if (gate.value) await gate.value;
    if (shellError.value) throw shellError.value;
    const fake = new FakeShell();
    fake.sizes.push(size);
    shells.push(fake);
    return fake;
  };
  const auditor = createAuditor(api, (line) => lines.push(line));
  const participant = createResourceParticipant(DRAIN_KEY, (path, body) => api.participant(path, body));
  const sessions = createSessionManager({
    authorizer,
    auditor,
    limits: { ...LIMITS, ...overrides },
    now,
    connect: createConnect({
      api, knownHosts: createKnownHosts(knownHostsFile), participant, shell,
      lookup: async (host) => {
        const found = addresses.get(host);
        if (!found) throw new Error('no such host');
        return found;
      },
    }),
  });
  const appDependencies = { publicOrigin: ORIGIN, authorizer, sessions, participant, auditRefusal: createRefusalAuditor(auditor, now) };
  const app = createApp(appDependencies);
  return {
    app, appDependencies, shells, targets, calls, audits, lines, inventory, revoked, sessions, knownHostsFile, addresses, shellError, gate, auditFailure,
    refuseAdmission(error) { refusal = error; },
    dispose() {
      sessions.shutdown();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export const post = (app: Harness['app'], path: string, token: string | null, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

export const get = (app: Harness['app'], path: string, token: string | null, headers: Record<string, string> = {}) =>
  app.request(path, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });

export async function openSession(h: Harness, token: string, nodeId = NODE): Promise<string> {
  const response = await post(h.app, '/terminal/open', token, { nodeId });
  if (response.status !== 201) throw new Error(`open failed: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { sessionId: string }).sessionId;
}

/** Past the verifier's cached session answer, so the next check really asks the identity service. */
export function passSessionCache(): void { clock.offset += OATHWEAVE_SESSION_CACHE_TTL_MS + 1; }
export const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
export type { ManagedWork };
