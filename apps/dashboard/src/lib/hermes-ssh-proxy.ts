import { beginManagedSshWork, observeManagedSshEnd } from '../../runtime-resource-participant.mjs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { Client as SSHClient } from 'ssh2';
import type { ClientChannel } from 'ssh2';
import type { NextRequest } from 'next/server';
import type { HermesInstallation } from '@/types/orchestra';
import { createSshHostVerifier } from '../../runtime-host-key.mjs';
import { resolveApprovedHermesSshTarget, resolveHermesDashboardForwardTarget } from '../../runtime-hermes-security.mjs';
import { recordHermesSecurityEvent } from '../../runtime-hermes-security-events.mjs';
import { resolveDashboardSshCredentials } from '../../runtime-dashboard-credentials.mjs';

export interface HermesSshHttpResponse {
  status: number;
  statusText: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface SshCredentials {
  username: string;
  password?: string;
  privateKey?: string;
}

function resolveSshCredentials(): SshCredentials {
  const { username, password, privateKey } = resolveDashboardSshCredentials();
  return { username, password, privateKey };
}

async function connectSsh(installation: HermesInstallation, dashboard = false): Promise<{ conn: SSHClient; dashboardTarget?: { address: string; port: number } }> {
  const credentials = resolveSshCredentials();
  let target: Awaited<ReturnType<typeof resolveApprovedHermesSshTarget>>;
  let dashboardTarget: { address: string; port: number } | undefined;
  try {
    target = await resolveApprovedHermesSshTarget(installation);
    if (dashboard) dashboardTarget = resolveHermesDashboardForwardTarget(installation, target);
  } catch (error) {
    const correlationId = crypto.randomUUID();
    recordHermesSecurityEvent({
      type: 'blocked_destination',
      correlationId,
      installationId: installation.id,
      nodeId: installation.nodeId,
      hostname: installation.hostname,
      reason: error instanceof Error ? error.message : 'destination_denied',
      transport: 'http',
    });
    throw new Error(`Hermes SSH destination denied (correlation ${correlationId})`, { cause: error });
  }

  const work = await beginManagedSshWork(installation.hostname, 'hermes-http');
  return new Promise((resolvePromise, reject) => {
    const conn = new SSHClient();
    conn.once('close', () => observeManagedSshEnd(work));
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      observeManagedSshEnd(work);
      conn.end();
      reject(new Error(`Timed out connecting to ${installation.hostname} over SSH`));
    }, 15_000);

    conn.on('ready', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise({ conn, dashboardTarget });
    });

    conn.on('error', (err) => {
      observeManagedSshEnd(work);
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });

    try { conn.connect({
      host: target.address,
      port: installation.sshPort || 22,
      username: credentials.username,
      ...(credentials.privateKey ? { privateKey: credentials.privateKey } : { password: credentials.password ?? '' }),
      readyTimeout: 12_000,
      hostVerifier: createSshHostVerifier(`${installation.id}:${installation.nodeId}`, {
        expectedFingerprints: target.authorization.hostKeySha256,
        onMismatch: ({ observedFingerprint }: { observedFingerprint: string }) => {
          recordHermesSecurityEvent({
            type: 'host_key_mismatch',
            correlationId: crypto.randomUUID(),
            installationId: installation.id,
            nodeId: installation.nodeId,
            hostname: installation.hostname,
            reason: `observed_${observedFingerprint}`,
            transport: 'http',
          });
        },
      }),
    }); } catch (error) { clearTimeout(timeout); observeManagedSshEnd(work); reject(error); }
  });
}

function openLocalServiceStream(conn: SSHClient, port: number, address = '127.0.0.1'): Promise<ClientChannel> {
  return new Promise((resolvePromise, reject) => {
    conn.forwardOut('127.0.0.1', 0, address, port, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      const socketLike = stream as ClientChannel & {
        setNoDelay?: () => ClientChannel;
        setKeepAlive?: () => ClientChannel;
        setTimeout?: () => ClientChannel;
      };
      socketLike.setNoDelay ??= () => stream;
      socketLike.setKeepAlive ??= () => stream;
      socketLike.setTimeout ??= () => stream;
      resolvePromise(stream);
    });
  });
}

function requestHeadersFrom(req: NextRequest, port: number, extraHeaders?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    host: `127.0.0.1:${port}`,
    connection: 'close',
    'accept-encoding': 'identity',
    'x-forwarded-host': req.headers.get('host') ?? 'magnus',
    'x-forwarded-proto': req.nextUrl.protocol.replace(':', ''),
  };

  for (const name of ['accept', 'content-type', 'user-agent', 'origin', 'referer']) {
    const value = req.headers.get(name);
    if (value) headers[name] = value;
  }

  return { ...headers, ...(extraHeaders ?? {}) };
}

export async function requestHermesDashboardOverSsh(params: {
  installation: HermesInstallation;
  req: NextRequest;
  upstreamPath: string;
  search: string;
  body?: string;
  headers?: Record<string, string>;
}): Promise<HermesSshHttpResponse> {
  const { conn, dashboardTarget } = await connectSsh(params.installation, true);

  try {
    const stream = await openLocalServiceStream(conn, dashboardTarget!.port, dashboardTarget!.address);

    return await new Promise<HermesSshHttpResponse>((resolvePromise, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port: params.installation.dashboardPort,
        path: `${params.upstreamPath}${params.search ? `?${params.search}` : ''}`,
        method: params.req.method,
        headers: requestHeadersFrom(params.req, params.installation.dashboardPort, params.headers),
        createConnection: () => stream,
        timeout: 30_000,
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolvePromise({
            status: response.statusCode ?? 502,
            statusText: response.statusMessage ?? '',
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      });

      request.on('timeout', () => {
        request.destroy(new Error('Hermes dashboard request timed out'));
      });
      request.on('error', reject);

      if (params.body) request.write(params.body);
      request.end();
    });
  } finally {
    conn.end();
  }
}


export async function requestHermesLocalHttpOverSsh(params: {
  installation: HermesInstallation;
  port: number;
  req: NextRequest;
  upstreamPath: string;
  search: string;
  body?: string;
  headers?: Record<string, string>;
}): Promise<HermesSshHttpResponse> {
  const { conn } = await connectSsh(params.installation);

  try {
    const stream = await openLocalServiceStream(conn, params.port);

    return await new Promise<HermesSshHttpResponse>((resolvePromise, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port: params.port,
        path: `${params.upstreamPath}${params.search ? `?${params.search}` : ''}`,
        method: params.req.method,
        headers: requestHeadersFrom(params.req, params.port, params.headers),
        createConnection: () => stream,
        timeout: 120_000,
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolvePromise({
            status: response.statusCode ?? 502,
            statusText: response.statusMessage ?? '',
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      });

      request.on('timeout', () => {
        request.destroy(new Error('Hermes local service request timed out'));
      });
      request.on('error', reject);

      if (params.body) request.write(params.body);
      request.end();
    });
  } finally {
    conn.end();
  }
}

export async function streamHermesLocalHttpOverSsh(params: {
  installation: HermesInstallation;
  port: number;
  req: NextRequest;
  upstreamPath: string;
  search: string;
  body?: string;
  headers?: Record<string, string>;
}): Promise<{ status: number; statusText: string; headers: IncomingHttpHeaders; body: ReadableStream<Uint8Array> }> {
  const { conn } = await connectSsh(params.installation);
  const stream = await openLocalServiceStream(conn, params.port);

  return await new Promise((resolvePromise, reject) => {
    let settled = false;
    const request = httpRequest({
      host: '127.0.0.1',
      port: params.port,
      path: `${params.upstreamPath}${params.search ? `?${params.search}` : ''}`,
      method: params.req.method,
      headers: requestHeadersFrom(params.req, params.port, params.headers),
      createConnection: () => stream,
      timeout: 0,
    }, (response) => {
      settled = true;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          response.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
          response.on('end', () => {
            controller.close();
            conn.end();
          });
          response.on('error', (err) => {
            controller.error(err);
            conn.end();
          });
        },
        cancel() {
          request.destroy();
          conn.end();
        },
      });
      resolvePromise({
        status: response.statusCode ?? 502,
        statusText: response.statusMessage ?? '',
        headers: response.headers,
        body,
      });
    });

    request.on('error', (err) => {
      conn.end();
      if (!settled) reject(err);
    });

    if (params.body) request.write(params.body);
    request.end();
  });
}
