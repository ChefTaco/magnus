#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isIP } from 'node:net';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--') && all[index + 1] && !all[index + 1].startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
if (!args.inventory || !args.output) throw new Error('Usage: generate-hermes-ssh-authorizations.mjs --inventory FILE --output FILE');

const payload = JSON.parse(readFileSync(args.inventory, 'utf8'));
const installations = Array.isArray(payload) ? payload : payload.data;
if (!Array.isArray(installations)) throw new Error('Inventory JSON must contain an installation array');

function prohibited(address) {
  return address === '::' || address === '::1' || address.startsWith('127.') || address.startsWith('169.254.')
    || /^fe[89ab]/i.test(address) || /^ff/i.test(address) || address.startsWith('0.');
}

function fingerprints(address, port) {
  const output = execFileSync('ssh-keyscan', ['-T', '5', '-p', String(port), address], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return [...new Set(output.split('\n').flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3 || fields[0].startsWith('#')) return [];
    try {
      const raw = Buffer.from(fields[2], 'base64');
      const fingerprint = `SHA256:${createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')}`;
      return [{ fingerprint, evidenceSha256: createHash('sha256').update(line.trim()).digest('hex') }];
    } catch { return []; }
  }))];
}

const generatedAt = new Date().toISOString();
const document = { version: 2, generatedAt, installations: {} };
for (const installation of installations) {
  if (!installation?.id || !installation?.nodeId || !installation?.hostname) continue;
  try {
    const records = await lookup(installation.hostname, { all: true, verbatim: true });
    const addresses = [...new Set(records.map((record) => record.address))].filter((address) => isIP(address) && !prohibited(address));
    if (addresses.length === 0) throw new Error('no safe resolved address');
    const observedKeys = addresses.flatMap((address) => fingerprints(address, installation.sshPort || 22));
    const keys = [...new Map(observedKeys.map((key) => [key.fingerprint, key])).values()]
      .map((key) => ({
        ...key,
        state: 'active',
        firstSeenAt: generatedAt,
        source: 'ssh-keyscan',
      }));
    if (keys.length === 0) throw new Error('no SSH host key');
    document.installations[installation.id] = {
      nodeId: installation.nodeId,
      hostname: installation.hostname,
      sshPort: installation.sshPort || 22,
      addresses,
      keys,
    };
  } catch (error) {
    console.error(`[hermes-auth] skipped ${installation.id}:${installation.nodeId} (${installation.hostname}): ${error instanceof Error ? error.message : error}`);
  }
}
if (Object.keys(document.installations).length === 0) throw new Error('No Hermes installations could be explicitly authorized');
const temporary = `${args.output}.tmp`;
writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
const temporaryFd = openSync(temporary, constants.O_RDONLY);
try { fsyncSync(temporaryFd); } finally { closeSync(temporaryFd); }
renameSync(temporary, args.output);
const directoryFd = openSync(dirname(args.output), constants.O_RDONLY);
try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
console.log(`Authorized ${Object.keys(document.installations).length} Hermes installations`);
