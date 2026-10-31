#!/usr/bin/env node
/** Verify a live TLS endpoint's CA chain, DNS identity, and rotation window. */
import { readFileSync } from 'node:fs';
import { connect } from 'node:tls';

const [hostname, portRaw = '443', caPath = '', minDaysRaw = '14'] = process.argv.slice(2);
if (!hostname) {
  console.error('usage: node scripts/check-tls-endpoint.mjs <hostname> [port] [ca.pem] [min-days]');
  process.exit(2);
}
const port = Number(portRaw);
const minDays = Number(minDaysRaw);
if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(minDays) || minDays < 0) {
  throw new Error('port and minimum days must be valid positive numbers');
}

const socket = connect({
  host: hostname,
  port,
  servername: hostname,
  rejectUnauthorized: true,
  ...(caPath ? { ca: readFileSync(caPath) } : {}),
  timeout: 8_000,
});

socket.once('secureConnect', () => {
  const certificate = socket.getPeerCertificate();
  const expiresAt = Date.parse(certificate.valid_to);
  const remainingDays = Math.floor((expiresAt - Date.now()) / 86_400_000);
  if (!Number.isFinite(expiresAt) || remainingDays < minDays) {
    socket.destroy(new Error(`certificate rotation window too short: ${remainingDays}d < ${minDays}d`));
    return;
  }
  console.log(JSON.stringify({
    hostname,
    port,
    authorized: socket.authorized,
    subject: certificate.subject?.CN ?? null,
    issuer: certificate.issuer?.CN ?? null,
    validTo: certificate.valid_to,
    remainingDays,
    minimumDays: minDays,
  }));
  socket.end();
});
socket.once('timeout', () => socket.destroy(new Error('TLS connection timed out')));
socket.once('error', (error) => {
  console.error(`TLS verification failed for ${hostname}:${port}: ${error.message}`);
  process.exitCode = 1;
});
