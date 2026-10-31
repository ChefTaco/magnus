#!/usr/bin/env node
/**
 * server-tls.mjs — HTTPS wrapper for the Next.js standalone server.
 *
 * Monkey-patches http.createServer so that when the Next.js standalone
 * server.js calls it, an HTTPS server is created instead. Certificates are
 * read from TLS_CERT_PATH / TLS_KEY_PATH. Without a certificate the process
 * refuses to start unless MAGNUS_UI_ALLOW_HTTP=true, in which case it serves
 * plain HTTP and prints a warning (local development or behind a TLS proxy).
 *
 * MAGNUS_UI_DATA_DIR, when set, becomes the working directory for runtime
 * state (.magnus/, terminal-audit/) instead of the installed package.
 */
import https from 'node:https';
import { beginManagedSshWork, observeManagedSshEnd } from './runtime-resource-participant.mjs';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { verifyLocalSession } from './runtime-local-sessions.mjs';
import { jwtVerify } from 'jose';
import { Client as SSHClient } from 'ssh2';
import { WebSocket, WebSocketServer } from 'ws';
import { parseCookieHeader } from './runtime-cookie.mjs';
import { createSshHostVerifier } from './runtime-host-key.mjs';
import {
  chooseHermesInstallation,
  cookieHeaderAllowed,
  controlApiResponseLimit,
  controlApiTlsOptions,
  createBoundedMessageQueue,
  createWebSocketBackpressureController,
  hermesWebsocketPathAllowed,
  normalizeHermesInstallations,
  resolveApprovedHermesSshTarget,
  resolveHermesDashboardForwardTarget,
  websocketOriginAllowed,
} from './runtime-hermes-security.mjs';
import { readDashboardEnvironment, validateDashboardEnvironment } from './runtime-environment.mjs';
import { recordHermesSecurityEvent } from './runtime-hermes-security-events.mjs';
import { resolveSessionSecret, sessionSecretDiagnostics } from './runtime-session-secret.mjs';
import { dashboardCredentialDiagnostics, resolveDashboardSshCredentials } from './runtime-dashboard-credentials.mjs';
import { hermesEnabled } from './runtime-integrations.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

function configuredPath(name, fallback) {
  const value = process.env[name]?.trim();
  if (value) return value;
  return existsSync(fallback) ? fallback : undefined;
}

const certPath = configuredPath('TLS_CERT_PATH', resolve(__dirname, '../../certs/server.crt'));
const keyPath = configuredPath('TLS_KEY_PATH', resolve(__dirname, '../../certs/server.key'));
const allowHttp = String(process.env['MAGNUS_UI_ALLOW_HTTP'] ?? '').trim().toLowerCase() === 'true';

let tlsOptions = null;
if (certPath && keyPath) {
  tlsOptions = { key: readFileSync(keyPath), cert: readFileSync(certPath) };
} else if (certPath || keyPath) {
  console.error('magnus-ui: TLS_CERT_PATH and TLS_KEY_PATH must be configured together.');
  process.exit(1);
} else if (!allowHttp) {
  console.error('magnus-ui: no TLS certificate configured. Set TLS_CERT_PATH and TLS_KEY_PATH, '
    + 'or set MAGNUS_UI_ALLOW_HTTP=true to serve plain HTTP (local development or behind a TLS-terminating proxy only).');
  process.exit(1);
} else {
  console.warn('magnus-ui: WARNING: serving plain HTTP because MAGNUS_UI_ALLOW_HTTP=true and no TLS certificate is configured. '
    + 'Session cookies are marked Secure, so browsers only keep them on https:// or http://localhost.');
}

const COOKIE_NAME = 'magnus_session';
const HERMES_PROXY_BASE = '/api/hermes/dashboard';
const HERMES_INSTALLATION_COOKIE = 'magnus_hermes_dashboard_installation_id';
const jwtSecret = resolveSessionSecret();
const sessionSecretState = sessionSecretDiagnostics();
if (sessionSecretState.legacyFallbackActive) {
  recordHermesSecurityEvent({ type: 'legacy_session_secret', reason: `migration_deadline_${sessionSecretState.migrationDeadline}` });
}
validateDashboardEnvironment(process.env);
const credentialState = dashboardCredentialDiagnostics();
if (credentialState.warning) console.error(credentialState.warning);
const sessionIssuer = readDashboardEnvironment('SESSION_ISSUER');
const sessionAudience = readDashboardEnvironment('SESSION_AUDIENCE');
const controlApiBase = readDashboardEnvironment('CONTROL_API_URL');
const controlApiTls = controlApiTlsOptions();
const maxControlApiBytes = controlApiResponseLimit();
const websocketAllowedOrigins = process.env['HERMES_WEBSOCKET_ALLOWED_ORIGINS']
  ?? readDashboardEnvironment('DASHBOARD_PUBLIC_ORIGIN')
  ?? '';

async function verifyDashboardSession(req) {
  if (!jwtSecret) return false;
  const token = parseCookieHeader(req.headers.cookie ?? '').get(COOKIE_NAME);
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(jwtSecret), {
      algorithms: ['HS256'],
      issuer: sessionIssuer,
      audience: sessionAudience,
    });
    return payload.provider !== 'hive' && await verifyLocalSession(payload);
  } catch {
    return false;
  }
}

function httpsJson(url, headers) {
  return new Promise((resolvePromise, reject) => {
    const req = httpsRequest(url, { method: 'GET', headers, ...controlApiTls, timeout: 10_000 }, (res) => {
      if ((res.statusCode ?? 500) >= 300 && (res.statusCode ?? 500) < 400) {
        res.resume();
        reject(new Error('Credentialed Control API redirects are forbidden'));
        return;
      }
      const chunks = [];
      let receivedBytes = 0;
      const declaredBytes = Number(res.headers['content-length'] ?? 0);
      if (declaredBytes > maxControlApiBytes) {
        req.destroy(new Error('Control API response exceeded configured size limit'));
        return;
      }
      res.on('data', (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes > maxControlApiBytes) {
          req.destroy(new Error('Control API response exceeded configured size limit'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        if ((res.statusCode ?? 500) >= 400) {
          reject(new Error(`Control API returned ${res.statusCode}: ${text.slice(0, 300)}`));
          return;
        }
        try { resolvePromise(JSON.parse(text)); }
        catch (err) { reject(err); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Control API request timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function fetchHermesInstallations() {
  const res = await httpsJson(`${controlApiBase}/api/v1/hermes/installations`, {
    'content-type': 'application/json',
    'x-api-secret': process.env['API_SECRET'] ?? '',
  });
  return normalizeHermesInstallations(res?.data);
}

function firstQuery(url, name) {
  const value = url.searchParams.get(name);
  return value && value.trim() ? value.trim() : null;
}

async function resolveHermesInstallation(req) {
  const url = new URL(req.url ?? '/', `https://${req.headers.host ?? 'localhost'}`);
  const cookies = parseCookieHeader(req.headers.cookie ?? '');
  const installations = await fetchHermesInstallations();
  return chooseHermesInstallation(
    installations,
    firstQuery(url, 'installationId'),
    firstQuery(url, 'nodeId'),
    cookies.get(HERMES_INSTALLATION_COOKIE) ?? null,
  );
}

function resolveSshCredentials() {
  return resolveDashboardSshCredentials();
}

function connectSsh(installation, address, authorization, correlationId) {
  const creds = resolveSshCredentials();
  return new Promise((resolvePromise, reject) => {
    const conn = new SSHClient();
    const timeout = setTimeout(() => {
      conn.end();
      reject(new Error(`Timed out connecting to ${installation.hostname} over SSH`));
    }, 15_000);
    conn.on('ready', () => {
      clearTimeout(timeout);
      resolvePromise(conn);
    });
    conn.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    conn.connect({
      host: address,
      port: installation.sshPort || 22,
      username: creds.username,
      ...(creds.privateKey ? { privateKey: creds.privateKey } : { password: creds.password }),
      readyTimeout: 12_000,
      hostVerifier: createSshHostVerifier(`${installation.id}:${installation.nodeId}`, {
        expectedFingerprints: authorization.hostKeySha256,
        onMismatch: ({ observedFingerprint }) => recordHermesSecurityEvent({
          type: 'host_key_mismatch',
          correlationId,
          installationId: installation.id,
          nodeId: installation.nodeId,
          hostname: installation.hostname,
          reason: `observed_${observedFingerprint}`,
          transport: 'websocket',
        }),
      }),
    });
  });
}

function openHermesDashboardTunnel(conn, target) {
  return new Promise((resolvePromise, reject) => {
    conn.forwardOut('127.0.0.1', 0, target.address, target.port, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      stream.setNoDelay ??= () => stream;
      stream.setKeepAlive ??= () => stream;
      stream.setTimeout ??= () => stream;
      resolvePromise(stream);
    });
  });
}

function websocketPathFor(req) {
  const url = new URL(req.url ?? '/', `https://${req.headers.host ?? 'localhost'}`);
  const upstreamPath = url.pathname.startsWith(HERMES_PROXY_BASE)
    ? url.pathname.slice(HERMES_PROXY_BASE.length) || '/'
    : url.pathname;
  url.searchParams.delete('installationId');
  url.searchParams.delete('nodeId');
  return `${upstreamPath}${url.search}`;
}

const hermesWss = new WebSocketServer({ noServer: true });

function isHermesWebSocketUpgrade(req) {
  const pathname = new URL(req.url ?? '/', `https://${req.headers.host ?? 'localhost'}`).pathname;
  if (!pathname.startsWith(`${HERMES_PROXY_BASE}/`)) return false;
  return hermesWebsocketPathAllowed(pathname.slice(HERMES_PROXY_BASE.length));
}

function isHermesUpgradeNamespace(req) {
  const pathname = new URL(req.url ?? '/', `https://${req.headers.host ?? 'localhost'}`).pathname;
  return pathname.startsWith(`${HERMES_PROXY_BASE}/`);
}

function attachHermesWebSocketBridge(server) {
  server.on('upgrade', (req, socket, head) => {
    if (!isHermesUpgradeNamespace(req)) return;
    if (!hermesEnabled()) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    void (async () => {
      const correlationId = randomUUID();
      const startedAt = Date.now();
      const path = websocketPathFor(req).split('?')[0];
      if (!isHermesWebSocketUpgrade(req)) {
        console.warn(`[hermes-ws:${correlationId}] rejected unknown endpoint ${path}`);
        recordHermesSecurityEvent({ type: 'rejected_endpoint', correlationId, path });
        socket.write(`HTTP/1.1 404 Not Found\r\nConnection: close\r\nX-Correlation-Id: ${correlationId}\r\n\r\n`);
        socket.destroy();
        return;
      }
      if (!cookieHeaderAllowed(req.headers.cookie)) {
        console.warn(`[hermes-ws:${correlationId}] rejected oversized Cookie header`);
        recordHermesSecurityEvent({ type: 'invalid_session', correlationId, path, reason: 'oversized_cookie' });
        socket.write('HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (!websocketOriginAllowed(req.headers.origin, websocketAllowedOrigins)) {
        console.warn(`[hermes-ws:${correlationId}] rejected Origin ${req.headers.origin ?? '<missing>'}`);
        recordHermesSecurityEvent({ type: 'rejected_origin', correlationId, path, origin: req.headers.origin ?? null });
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const ok = await verifyDashboardSession(req);
      if (!ok) {
        console.warn(`[hermes-ws:${correlationId}] rejected invalid dashboard session`);
        recordHermesSecurityEvent({ type: 'invalid_session', correlationId, path, reason: 'verification_failed' });
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      let installation;
      let ssh;
      let tunnel;
      let work;
      try {
        const selection = await resolveHermesInstallation(req);
        if (!selection.installation) {
          const status = selection.error === 'installation_required' ? '400 Bad Request' : '404 Not Found';
          socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n{"error":"${selection.error}"}`);
          socket.destroy();
          return;
        }
        installation = selection.installation;
        let approvedTarget;
        let dashboardTarget;
        try {
          approvedTarget = await resolveApprovedHermesSshTarget(installation);
          dashboardTarget = resolveHermesDashboardForwardTarget(installation, approvedTarget);
        } catch (err) {
          console.warn(`[hermes-ws:${correlationId}] blocked destination ${installation.hostname}`, err);
          recordHermesSecurityEvent({ type: 'blocked_destination', correlationId, installationId: installation.id, nodeId: installation.nodeId, hostname: installation.hostname, reason: err instanceof Error ? err.message : 'destination_denied' });
          socket.write(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: application/json\r\nX-Correlation-Id: ${correlationId}\r\n\r\n{"error":"destination_denied","correlationId":"${correlationId}"}`);
          socket.destroy();
          return;
        }
        work = await beginManagedSshWork(installation.hostname, 'hermes-ws');
        if (socket.destroyed) { observeManagedSshEnd(work, 'not-started'); return; }
        ssh = await connectSsh(installation, approvedTarget.address, approvedTarget.authorization, correlationId);
        ssh.once('close', () => observeManagedSshEnd(work));
        ssh.once('error', () => observeManagedSshEnd(work));
        tunnel = await openHermesDashboardTunnel(ssh, dashboardTarget);
      } catch (err) {
        if (work) observeManagedSshEnd(work);
        console.error(`[hermes-ws:${correlationId}] proxy connection failed`, err);
        recordHermesSecurityEvent({ type: 'connection_failed', correlationId, hostname: installation?.hostname ?? null });
        socket.write(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: application/json\r\nX-Correlation-Id: ${correlationId}\r\n\r\n{"error":"hermes_proxy_unavailable","correlationId":"${correlationId}"}`);
        socket.destroy();
        try { ssh?.end(); } catch {}
        return;
      }

      hermesWss.handleUpgrade(req, socket, head, (client) => {
        recordHermesSecurityEvent({ type: 'connection_started', correlationId, hostname: installation.hostname, path });
        const upstream = new WebSocket(
          `ws://127.0.0.1:${installation.dashboardPort || 9119}${websocketPathFor(req)}`,
          {
            createConnection: () => tunnel,
            headers: {
              host: `127.0.0.1:${installation.dashboardPort || 9119}`,
            },
          },
        );
        const pending = createBoundedMessageQueue();
        const toUpstream = createWebSocketBackpressureController();
        const toClient = createWebSocketBackpressureController();
        let upstreamDrainTimer;
        let clientDrainTimer;

        let closed = false;
        const closeBoth = (code = 1000, reason = 'Proxy connection closed') => {
          if (!closed) {
            closed = true;
            observeManagedSshEnd(work);
            const upstreamPressure = toUpstream.snapshot();
            const clientPressure = toClient.snapshot();
            recordHermesSecurityEvent({
              type: 'connection_closed', correlationId, installationId: installation.id, nodeId: installation.nodeId,
              hostname: installation.hostname, path, durationMs: Date.now() - startedAt,
              backpressureDurationMs: upstreamPressure.durationMs + clientPressure.durationMs,
              peakBufferedBytes: Math.max(upstreamPressure.peakBytes, clientPressure.peakBytes),
            });
          }
          clearTimeout(upstreamDrainTimer);
          clearTimeout(clientDrainTimer);
          try { if (client.readyState <= 1) client.close(code, reason); } catch {}
          try { if (upstream.readyState <= 1) upstream.close(code, reason); } catch {}
          try { ssh?.end(); } catch {}
        };

        const drain = (controller, destination, direction) => {
          if (closed || destination.readyState !== WebSocket.OPEN) return;
          const result = controller.drain(
            (data, isBinary) => destination.send(data, { binary: isBinary }),
            () => destination.bufferedAmount,
          );
          if (result.close) {
            recordHermesSecurityEvent({
              type: 'backpressure', correlationId, installationId: installation.id, nodeId: installation.nodeId,
              hostname: installation.hostname, path, direction,
              backpressureDurationMs: result.durationMs, peakBufferedBytes: result.peakBytes,
            });
            closeBoth(1013, 'Sustained proxy backpressure');
            return;
          }
          if (result.pending) {
            const timer = setTimeout(() => drain(controller, destination, direction), 25);
            if (direction === 'client_to_upstream') upstreamDrainTimer = timer;
            else clientDrainTimer = timer;
          }
        };

        const enqueue = (controller, destination, direction, data, isBinary) => {
          if (!controller.push(data, isBinary)) {
            const pressure = controller.snapshot();
            recordHermesSecurityEvent({
              type: 'backpressure', correlationId, installationId: installation.id, nodeId: installation.nodeId,
              hostname: installation.hostname, path, direction, queuedBytes: pressure.queuedBytes,
              backpressureDurationMs: pressure.durationMs, peakBufferedBytes: pressure.peakBytes,
              reason: 'bounded_direction_queue_exceeded',
            });
            closeBoth(1013, 'Proxy backpressure queue exceeded');
            return;
          }
          drain(controller, destination, direction);
        };

        client.on('message', (data, isBinary) => {
          if (upstream.readyState === WebSocket.OPEN) {
            enqueue(toUpstream, upstream, 'client_to_upstream', data, isBinary);
          } else if (!pending.push(data, isBinary)) {
            recordHermesSecurityEvent({ type: 'queue_pressure', correlationId, hostname: installation.hostname, path, queuedBytes: pending.bytes });
            closeBoth(1009, 'Upstream connection queue exceeded');
          }
        });
        upstream.on('open', () => pending.flush((data, isBinary) => enqueue(toUpstream, upstream, 'client_to_upstream', data, isBinary)));
        upstream.on('message', (data, isBinary) => {
          if (client.readyState === WebSocket.OPEN) enqueue(toClient, client, 'upstream_to_client', data, isBinary);
        });
        client.on('close', closeBoth);
        client.on('error', (err) => {
          console.error(`[hermes-ws:${correlationId}] client socket failed`, err);
          closeBoth();
        });
        upstream.on('close', closeBoth);
        upstream.on('error', (err) => {
          console.error(`[hermes-ws:${correlationId}] upstream socket failed`, err);
          closeBoth();
        });
      });
    })();
  });
}

// Patch http.createServer — Next.js standalone calls this to start listening
const _orig = http.createServer.bind(http);
http.createServer = (optOrHandler, maybeHandler) => {
  const handler = typeof optOrHandler === 'function' ? optOrHandler : maybeHandler;
  const normalizedHandler = (req, res) => {
    // This is the trusted edge for the standalone dashboard. Discard any
    // caller-provided forwarding chain and rebuild it from the peer socket.
    const address = req.socket?.remoteAddress ?? 'unverified';
    delete req.headers['forwarded'];
    delete req.headers['x-forwarded-for'];
    delete req.headers['x-real-ip'];
    delete req.headers['x-magnus-edge-normalized'];
    req.headers['x-forwarded-for'] = address;
    req.headers['x-real-ip'] = address;
    req.headers['x-magnus-edge-normalized'] = '1';
    return handler(req, res);
  };
  const server = tlsOptions ? https.createServer(tlsOptions, normalizedHandler) : _orig(normalizedHandler);
  attachHermesWebSocketBridge(server);
  // Next registers its own upgrade listener after createServer() returns. Let
  // that listener handle framework WebSockets, but keep it away from Hermes
  // paths so it cannot destroy the socket while the SSH bridge is connecting.
  const originalOn = server.on;
  server.on = function on(event, listener) {
    if (event !== 'upgrade') return originalOn.call(this, event, listener);
    return originalOn.call(this, event, function nextUpgradeListener(req, socket, head) {
      if (isHermesUpgradeNamespace(req)) return;
      return listener.call(this, req, socket, head);
    });
  };
  return server;
};

// Boot the Next.js standalone server (CJS)
const require = createRequire(import.meta.url);
const nextServer = existsSync(resolve(__dirname, 'server.js'))
  ? './server.js'
  : './apps/dashboard/server.js';
const dataDir = process.env['MAGNUS_UI_DATA_DIR']?.trim();
if (dataDir) {
  // server.js changes into its own directory; keep mutable state in the data
  // directory instead. Next.js resolves its build output from `dir`, not cwd.
  const absoluteDataDir = resolve(dataDir);
  mkdirSync(absoluteDataDir, { recursive: true, mode: 0o700 });
  process.chdir(absoluteDataDir);
  const chdir = process.chdir;
  process.chdir = () => {};
  try {
    require(nextServer);
  } finally {
    process.chdir = chdir;
  }
} else {
  require(nextServer);
}
