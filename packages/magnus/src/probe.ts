/**
 * The health probe behind Io.probe. It only reads a status code and sends no
 * credentials. Each project's server and console run on this machine, usually
 * behind a self-signed certificate that does not name the address probed.
 *
 * With the project's certificate, the served certificate must chain to it. That
 * pins the identity, so the hostname check is skipped: the certificate names the
 * public host while the probe connects to a bind address.
 *
 * Verification is switched off only for an address that belongs to this machine
 * (loopback or a local interface), where traffic stays in the kernel, and only
 * when no certificate is known or the known one does not verify (say it renewed
 * and the running server still serves the old one). Answering null there would
 * read as "the port is closed" while waiting for a stop, and as "unhealthy" after
 * a restart, rolling back a working upgrade. Any other address is always verified.
 */
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

export interface ProbeOptions {
  /** PEM of the certificate the project's server or console is configured with. */
  ca?: string;
}

export interface ProbeEnvironment {
  isLocalAddress?: (host: string) => Promise<boolean>;
  warn?: (line: string) => void;
}

export function isLoopbackAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = bare.startsWith('::ffff:') ? bare.slice(7) : bare;
  return mapped === '::1' || mapped === 'localhost' || (isIP(mapped) === 4 && mapped.startsWith('127.'));
}

export async function isLocalAddress(host: string): Promise<boolean> {
  const bare = host.replace(/^\[|\]$/g, '');
  if (isLoopbackAddress(bare)) return true;
  const local = new Set(Object.values(networkInterfaces()).flatMap((rows) => (rows ?? []).map((row) => row.address.toLowerCase())));
  if (isIP(bare)) return local.has(bare.toLowerCase());
  try {
    const resolved = await lookup(bare, { all: true });
    return resolved.length > 0 && resolved.every((row) => isLoopbackAddress(row.address) || local.has(row.address.toLowerCase()));
  } catch {
    return false;
  }
}

type Outcome = { status: number; certificateRejected?: never } | { status: null; certificateRejected: boolean };

function isCertificateError(error: NodeJS.ErrnoException): boolean {
  return /CERT|SELF_SIGNED|UNABLE_TO_(?:GET_ISSUER|VERIFY|DECRYPT)|INVALID_CA|INVALID_PURPOSE|PATH_LENGTH/.test(error.code ?? '');
}

function attempt(target: URL, tls: RequestOptions): Promise<Outcome> {
  return new Promise((resolve) => {
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const failed = (error: NodeJS.ErrnoException) => resolve({ status: null, certificateRejected: isCertificateError(error) });
    try {
      const req = send(target, { method: 'GET', timeout: 5_000, ...tls }, (res) => {
        res.resume();
        resolve(res.statusCode === undefined ? { status: null, certificateRejected: false } : { status: res.statusCode });
      });
      req.on('timeout', () => req.destroy());
      req.on('error', failed);
      req.end();
    } catch (error) {
      // An unusable PEM throws while the request is created.
      failed(Object.assign(error instanceof Error ? error : new Error(String(error)), { code: 'CERT_UNUSABLE' }));
    }
  });
}

let warned = false;

export async function probeStatus(url: string, options: ProbeOptions = {}, environment: ProbeEnvironment = {}): Promise<number | null> {
  const target = new URL(url);
  const verified: RequestOptions = { rejectUnauthorized: true };
  if (target.protocol === 'https:' && options.ca) {
    Object.assign(verified, { ca: options.ca, allowPartialTrustChain: true, checkServerIdentity: () => undefined });
  }
  const first = await attempt(target, verified);
  if (first.status !== null || !first.certificateRejected) return first.status;
  const local = await (environment.isLocalAddress ?? isLocalAddress)(target.hostname);
  if (!local) return null;
  if (options.ca && !warned) {
    warned = true;
    (environment.warn ?? console.error)(`The certificate at ${target.host} does not match the project's TLS certificate; continuing with an unverified local status probe.`);
  }
  const verifyLocalAnswer = !local;
  return (await attempt(target, { rejectUnauthorized: verifyLocalAnswer })).status;
}
