import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { digest } from './files.js';
import { NativeSnapshots } from './index.js';

const absolute = z.string().refine(value => value.startsWith('/'), 'Use an absolute path');
const agentUnit = z.string().optional();
const schemas = {
  inspect: z.object({ agentUnit }).strict(),
  quiesce: z.object({ session: z.string().uuid(), state: absolute, agentUnit, expectedInventorySha256: digest.optional() }).strict(),
  'recover-quiesce': z.object({ session: z.string().uuid(), state: absolute, expectedCurrent: digest, expectedJournalSHA256: digest.optional() }).strict(),
  capture: z.object({ state: absolute, destination: absolute }).strict(),
  verify: z.object({ source: absolute }).strict(),
  restore: z.object({ state: absolute, source: absolute, expectedCurrent: digest }).strict(),
  resume: z.object({ state: absolute }).strict(),
};
export const NATIVE_SNAPSHOT_USAGE = 'native-snapshot inspect --json | quiesce --session UUID --state ABS | recover-quiesce --session UUID --state ABS --expected-current SHA | capture --state ABS --destination ABS | verify --source ABS | restore --state ABS --source ABS --expected-current SHA | resume --state ABS (or ACTION --request-file - with JSON on stdin)';
export async function runNativeSnapshot(args: string[], product = new NativeSnapshots(), readInput?: (path: string) => Promise<string>): Promise<Record<string, unknown>> {
  const action = args[0];
  if (!action || !(action in schemas)) throw new Error('Unsupported native snapshot command; update Magnus agent or use ' + NATIVE_SNAPSHOT_USAGE);
  const input = readInput ?? (async path => {
    if (path !== '-') return readFile(path, 'utf8');
    let value = '';
    for await (const chunk of process.stdin) { value += String(chunk); if (Buffer.byteLength(value) > 64 * 1024) throw new Error('Native snapshot request exceeds bounds'); }
    return value;
  });
  const options: Record<string, unknown> = {};
  if (args[1] === '--request-file') {
    if (args.length !== 3 || !args[2]) throw new Error('Use ACTION --request-file PATH|-');
    const value = await input(args[2]);
    if (Buffer.byteLength(value) > 64 * 1024) throw new Error('Native snapshot request exceeds bounds');
    Object.assign(options, z.record(z.string(), z.unknown()).parse(JSON.parse(value) as unknown));
  } else {
    const names: Record<string, string> = { '--session': 'session', '--state': 'state', '--destination': 'destination', '--source': 'source', '--expected-current': 'expectedCurrent', '--expected-journal': 'expectedJournalSHA256', '--expected-inventory': 'expectedInventorySha256', '--agent-unit': 'agentUnit' };
    for (let i = 1; i < args.length; i++) {
      const key = args[i]!;
      if (key === '--json') continue;
      const field = names[key], value = args[++i];
      if (!field || !value || value.startsWith('--') || field in options) throw new Error('Invalid or repeated native snapshot option');
      options[field] = value;
    }
  }
  switch (action) {
    case 'inspect': { const value = schemas.inspect.parse(options); return product.inspect(value.agentUnit); }
    case 'quiesce': { const value = schemas.quiesce.parse(options); return product.quiesce(value.session, value.state, value.agentUnit, value.expectedInventorySha256); }
    case 'recover-quiesce': { const value = schemas['recover-quiesce'].parse(options); return product.recoverQuiesce(value.state, value.session, value.expectedCurrent, value.expectedJournalSHA256); }
    case 'capture': { const value = schemas.capture.parse(options); return product.capture(value.state, value.destination); }
    case 'verify': { const value = schemas.verify.parse(options); return product.verify(value.source); }
    case 'restore': { const value = schemas.restore.parse(options); return product.restore(value.state, value.source, value.expectedCurrent); }
    case 'resume': { const value = schemas.resume.parse(options); return product.resume(value.state); }
    default: throw new Error(NATIVE_SNAPSHOT_USAGE);
  }
}
