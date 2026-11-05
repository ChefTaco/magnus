#!/usr/bin/env node
/**
 * magnus-fleet-gateway start | check | healthcheck | trust ...
 * Only a TLS listener exists: there is no plain HTTP mode to switch on by accident.
 */
import { readFileSync } from 'node:fs';
import { request as httpsRequest, createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { isIP } from 'node:net';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { createOathweaveVerifier, OATHWEAVE_AUDIENCE, OATHWEAVE_STREAM_RECHECK_MS } from '@hivemagnus/magnus-oathweave';
import { createApp } from './app.js';
import { createAuditor, createRefusalAuditor } from './audit.js';
import { createAuthorizer } from './authorize.js';
import { loadConfig, type GatewayConfig } from './config.js';
import { createConnect } from './connect.js';
import { createControlApi, httpsTransport, type AuditEvent } from './control-api.js';
import {
  approveNewNode, createKnownHosts, FINGERPRINT, listNodes, removeNode, rotateKey,
} from './known-hosts.js';
import { createResourceParticipant } from './participant.js';
import { createSessionManager } from './sessions.js';
import { loadSshIdentity, scanHostKey, sshConnector } from './ssh.js';
import { isUsableHostSyntax, lookupAddresses, NODE_ID } from './target.js';

const SHUTDOWN_GRACE_MS = 3_000;

function apiFor(config: GatewayConfig) {
  return createControlApi(httpsTransport(config.CONTROL_API_URL, config.CONTROL_API_CA_PATH), config.FLEET_GATEWAY_API_TOKEN, config.RESOURCE_ENROLLMENT_DASHBOARD_SECRET);
}

async function start(): Promise<void> {
  const config = loadConfig();
  const identity = loadSshIdentity(config.FLEET_GATEWAY_SSH_USERNAME, config.FLEET_GATEWAY_SSH_PRIVATE_KEY_PATH);
  const api = apiFor(config);
  const verify = createOathweaveVerifier({
    issuer: config.OATHWEAVE_ISSUER, jwksUrl: config.OATHWEAVE_JWKS_URL, userinfoUrl: config.OATHWEAVE_USERINFO_URL, audience: OATHWEAVE_AUDIENCE,
  });
  const authorizer = createAuthorizer(verify, config.links);
  const participant = createResourceParticipant(config.RESOURCE_ENROLLMENT_DASHBOARD_SECRET, api.participant);
  const auditor = createAuditor(api);
  const sessions = createSessionManager({
    authorizer,
    auditor,
    connect: createConnect({ api, knownHosts: createKnownHosts(config.FLEET_GATEWAY_KNOWN_HOSTS_FILE), participant, shell: sshConnector(identity) }),
    limits: {
      idleTimeoutMs: config.FLEET_GATEWAY_IDLE_TIMEOUT_SECONDS * 1000,
      maxLifetimeMs: config.FLEET_GATEWAY_MAX_LIFETIME_SECONDS * 1000,
      detachGraceMs: 60_000,
      recheckMs: OATHWEAVE_STREAM_RECHECK_MS,
      maxPerSubject: config.FLEET_GATEWAY_MAX_SESSIONS_PER_SUBJECT,
      maxTotal: config.FLEET_GATEWAY_MAX_SESSIONS,
      maxBufferedBytes: 1024 * 1024,
      opensPerMinute: 10,
    },
  });
  const app = createApp({
    publicOrigin: config.FLEET_GATEWAY_PUBLIC_ORIGIN, trustForwardedFor: config.FLEET_GATEWAY_TRUST_FORWARDED_FOR,
    authorizer, sessions, participant, auditRefusal: createRefusalAuditor(auditor),
  });
  const server = serve({
    fetch: app.fetch,
    hostname: config.FLEET_GATEWAY_BIND_HOST,
    port: config.FLEET_GATEWAY_PORT,
    createServer: createHttpsServer,
    serverOptions: {
      cert: readFileSync(config.TLS_CERT_PATH),
      key: readFileSync(config.TLS_KEY_PATH),
      minVersion: 'TLSv1.2',
      maxHeaderSize: 16 * 1024,
    },
  }, ({ port }) => console.log(JSON.stringify({ type: 'listening', port })));
  const listener = server as HttpsServer;
  listener.headersTimeout = 10_000;
  listener.requestTimeout = 30_000;
  listener.maxConnections = 1_024;
  const stop = () => {
    sessions.shutdown();
    server.close();
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

/** Validate configuration, the key and the API link without opening a port. */
async function check(): Promise<void> {
  const config = loadConfig();
  loadSshIdentity(config.FLEET_GATEWAY_SSH_USERNAME, config.FLEET_GATEWAY_SSH_PRIVATE_KEY_PATH);
  createKnownHosts(config.FLEET_GATEWAY_KNOWN_HOSTS_FILE).lookup('startup-check');
  const data = await apiFor(config).participant('/readiness', {});
  if (data['ready'] !== true) throw new Error('The Magnus API did not report durable participant readiness');
  console.log('magnus-fleet-gateway: configuration, key, trust store and Magnus API are usable');
}

function healthcheck(): Promise<void> {
  const port = Number(process.env['FLEET_GATEWAY_PORT'] ?? 4310);
  const caPath = process.env['NODE_EXTRA_CA_CERTS'] ?? process.env['TLS_CERT_PATH'];
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 4_000,
      servername: process.env['FLEET_GATEWAY_TLS_NAME'] ?? 'localhost',
      ...(caPath ? { ca: readFileSync(caPath) } : {}),
    }, (response) => {
      response.resume();
      if (response.statusCode === 200) resolve();
      else reject(new Error('The gateway is not healthy'));
    });
    request.on('timeout', () => request.destroy(new Error('The gateway health check timed out')));
    request.on('error', reject);
    request.end();
  });
}

const TRUST_USAGE = `Usage:
  trust scan   --node-id ID --host HOST [--port 22]
  trust add    --node-id ID --host HOST [--port 22] --fingerprint SHA256:... --approved-by NAME --approval-ref REF
  trust rotate --node-id ID --previous SHA256:... --fingerprint SHA256:... --approved-by NAME --approval-ref REF
  trust extra  --node-id ID --fingerprint SHA256:... --approved-by NAME --approval-ref REF
  trust remove --node-id ID --approved-by NAME --approval-ref REF
  trust list

Read the expected fingerprint on the node itself: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
Scan output comes over the network, so it is what you compare, never what you approve on its own.`;

async function dialable(host: string): Promise<string> {
  if (isIP(host)) return host;
  const addresses = await lookupAddresses(host);
  if (!addresses[0]) throw new Error('The host does not resolve');
  return addresses[0];
}

/** The command's connection must present the fingerprint the operator named. */
async function assertPresented(host: string, port: number, username: string, fingerprint: string): Promise<void> {
  const observed = await scanHostKey(await dialable(host), port, username);
  if (observed !== fingerprint) {
    throw new Error(`The node presented ${observed}, not the approved fingerprint. Nothing was changed.`);
  }
}

async function auditTrustChange(config: GatewayConfig, action: AuditEvent['action'], nodeId: string, approvedBy: string, approvalRef: string, fingerprint: string | null): Promise<void> {
  await createAuditor(apiFor(config)).bestEffort({
    action, subject: approvedBy, actorId: approvedBy, nodeId, sessionId: null, outcome: approvalRef, at: new Date().toISOString(), durationMs: null, ipAddress: null, fingerprint,
  });
}

async function trust(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      'node-id': { type: 'string' }, host: { type: 'string' }, port: { type: 'string' }, fingerprint: { type: 'string' },
      previous: { type: 'string' }, 'approved-by': { type: 'string' }, 'approval-ref': { type: 'string' },
    },
    strict: true,
  });
  const need = (name: keyof typeof values): string => {
    const value = values[name];
    if (typeof value !== 'string' || !value) throw new Error(`--${name} is required\n\n${TRUST_USAGE}`);
    return value;
  };
  const fingerprintOf = (name: 'fingerprint' | 'previous'): string => {
    const value = need(name);
    if (!FINGERPRINT.test(value)) throw new Error(`--${name} must be an OpenSSH SHA256 fingerprint`);
    return value;
  };
  if (values['node-id'] !== undefined && !NODE_ID.test(values['node-id'])) throw new Error('--node-id is not a valid node id');
  if (values.host !== undefined && !isUsableHostSyntax(values.host)) throw new Error('--host is not a hostname or address a terminal may reach');
  const port = Number(values.port ?? 22);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('--port is not a valid port');
  const approval = () => ({
    fingerprint: fingerprintOf('fingerprint'), approvedBy: need('approved-by'), approvalRef: need('approval-ref'), approvedAt: new Date().toISOString(),
  });

  if (command === 'scan') {
    const username = process.env['FLEET_GATEWAY_SSH_USERNAME'] ?? 'deploy';
    console.log(await scanHostKey(await dialable(need('host')), port, username));
    console.log('Compare this with the fingerprint read on the node itself before approving it.');
    return;
  }
  const config = loadConfig();
  const file = config.FLEET_GATEWAY_KNOWN_HOSTS_FILE;
  const username = config.FLEET_GATEWAY_SSH_USERNAME;
  switch (command) {
    case 'add': {
      const entry = approval();
      const nodeId = need('node-id');
      const host = need('host');
      await assertPresented(host, port, username, entry.fingerprint);
      approveNewNode(file, nodeId, host, port, entry);
      await auditTrustChange(config, 'terminal.host-key.approve', nodeId, entry.approvedBy, entry.approvalRef, entry.fingerprint);
      break;
    }
    case 'rotate':
    case 'extra': {
      const entry = approval();
      const nodeId = need('node-id');
      const previous = command === 'rotate' ? fingerprintOf('previous') : undefined;
      const record = listNodes(file).find((item) => item.nodeId === nodeId)?.trust;
      if (!record) throw new Error('This node has no approved host key; use trust add');
      await assertPresented(record.host, record.port, username, entry.fingerprint);
      rotateKey(file, nodeId, previous, entry);
      await auditTrustChange(config, 'terminal.host-key.approve', nodeId, entry.approvedBy, entry.approvalRef, entry.fingerprint);
      break;
    }
    case 'remove': {
      const nodeId = need('node-id');
      const approvedBy = need('approved-by');
      const approvalRef = need('approval-ref');
      if (!removeNode(file, nodeId)) throw new Error('This node has no approved host key');
      await auditTrustChange(config, 'terminal.host-key.remove', nodeId, approvedBy, approvalRef, null);
      break;
    }
    case 'list':
      for (const { nodeId, trust: record } of listNodes(file)) {
        console.log(JSON.stringify({ nodeId, host: record.host, port: record.port, fingerprints: record.keys.map((key) => key.fingerprint) }));
      }
      return;
    default:
      throw new Error(TRUST_USAGE);
  }
  console.log('Approved host key store updated.');
}

async function main(): Promise<void> {
  const [command = 'start', ...rest] = process.argv.slice(2);
  if (command === 'start') return start();
  if (command === 'check') return check();
  if (command === 'healthcheck') return healthcheck();
  if (command === 'trust') return trust(rest);
  throw new Error(`Usage: magnus-fleet-gateway start | check | healthcheck | trust\n\n${TRUST_USAGE}`);
}

main().catch((error: unknown) => {
  console.error(`magnus-fleet-gateway: ${error instanceof Error ? error.message : 'failed'}`);
  process.exit(1);
});
