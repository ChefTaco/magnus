// SSH side of the browser harness's Hermes fixture (scripts/start-ui-ci.mjs).
//
// The console reaches a Hermes dashboard the way it does in production: it resolves the
// installation from the Control API, checks the node's address against HERMES_SSH_ALLOWED_CIDRS
// and the reviewed authorizations file, verifies the pinned host key, signs in with its dedicated
// SSH identity, and opens a direct-tcpip channel to the dashboard listener on the node's loopback.
// This module plays the node: an SSH server with its own host key that accepts only that identity
// and forwards only to the one dashboard port. The dashboard itself (HTTP and WebSocket) is served
// by tests/embedded-isolation.spec.ts on 127.0.0.1, so each test controls what the page does.
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ssh2 from 'ssh2';

const { Server, utils } = ssh2;

/**
 * The address the fixture node listens on. Production refuses loopback SSH targets, so this is
 * the first non-internal IPv4 address of the host (a CI runner or container always has one).
 */
export function fixtureNodeAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  throw new Error('The Hermes fixture needs a non-loopback IPv4 address');
}

function fingerprint(publicKey) {
  const parsed = utils.parseKey(publicKey);
  if (parsed instanceof Error) throw parsed;
  return `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
}

/**
 * Start the fixture node and write what an operator would review for it: the authorizations
 * file (installation, node, address, pinned host key) and the console's SSH identity.
 * @param {{ directory: string, address: string, sshPort: number, dashboardPort: number,
 *   installationId: string, nodeId: string, username: string }} options
 */
export async function startHermesSshFixture(options) {
  const hostKey = utils.generateKeyPairSync('ed25519');
  const clientKey = utils.generateKeyPairSync('ed25519');
  const allowed = utils.parseKey(clientKey.public);
  if (allowed instanceof Error) throw allowed;

  const clientKeyPath = join(options.directory, 'dashboard-proxy-ed25519');
  writeFileSync(clientKeyPath, clientKey.private, { mode: 0o600 });
  const authorizationsPath = join(options.directory, 'hermes-ssh-authorizations.json');
  writeFileSync(authorizationsPath, `${JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    installations: {
      [options.installationId]: {
        nodeId: options.nodeId,
        hostname: options.address,
        addresses: [options.address],
        hostKeySha256: [fingerprint(hostKey.public)],
      },
    },
  }, null, 2)}\n`, { mode: 0o600 });

  const forwarded = [];
  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    client.on('error', () => undefined);
    client.on('authentication', (ctx) => {
      const keyMatches = ctx.method === 'publickey'
        && ctx.username === options.username
        && ctx.key.algo === allowed.type
        && Buffer.compare(ctx.key.data, allowed.getPublicSSH()) === 0;
      if (!keyMatches) return ctx.reject(['publickey']);
      // Without a signature the client only asks whether the key would be accepted.
      if (ctx.signature && allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject(['publickey']);
      return ctx.accept();
    });
    client.on('ready', () => {
      client.on('session', (_accept, reject) => reject());
      client.on('tcpip', (accept, reject, info) => {
        // A node forwards only to its own dashboard listener: never anywhere else.
        if (info.destIP !== '127.0.0.1' || info.destPort !== options.dashboardPort) {
          reject();
          return;
        }
        forwarded.push(`${info.destIP}:${info.destPort}`);
        const channel = accept();
        const socket = createConnection(info.destPort, info.destIP);
        channel.pipe(socket).pipe(channel);
        socket.on('error', () => channel.destroy());
        channel.on('error', () => socket.destroy());
        channel.on('close', () => socket.destroy());
      });
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.sshPort, options.address, resolveListen);
  });
  return {
    clientKeyPath,
    authorizationsPath,
    forwarded,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}
