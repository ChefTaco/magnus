import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { logAuditEvent, queryAuditEvents, verifyAuditIntegrity } from './audit-service.js';
let dir: string, file: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'audit-v2-'));
  file = path.join(dir, new Date().toISOString().slice(0, 10) + '.jsonl');
  vi.stubEnv('AUDIT_LOG_DIR', dir);
  vi.stubEnv('AUDIT_HMAC_SECRET', 'a'.repeat(64));
  await logAuditEvent({
    action: 'log.retention',
    actorId: 'actor',
    actorType: 'system',
    targetType: 'case',
    targetId: 'case-1',
    details: { z: [1, { b: 2, a: 1 }], a: 'evidence' },
    ipAddress: '127.0.0.1',
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
it.each([
  'id',
  'action',
  'actorId',
  'actorType',
  'targetType',
  'targetId',
  'details',
  'ipAddress',
  'timestamp',
  'prevHash',
  'chainVersion',
  'integrity',
])('detects mutation of %s', async (field) => {
  const entry = JSON.parse(await readFile(file, 'utf8'));
  entry[field] =
    field === 'details' ? { tampered: true } : field === 'chainVersion' ? 1 : 'changed';
  await writeFile(file, JSON.stringify(entry) + '\n');
  expect(await verifyAuditIntegrity()).toMatchObject({
    valid: false,
    state: 'invalid',
    brokenAtIndex: 0,
  });
  expect((await queryAuditEvents({})).events[0]?.verificationState).toBe('invalid');
});
it('canonicalizes nested object keys but preserves array order', async () => {
  const entry = JSON.parse(await readFile(file, 'utf8'));
  entry.details = { a: 'evidence', z: [1, { a: 1, b: 2 }] };
  await writeFile(file, JSON.stringify(entry));
  expect((await verifyAuditIntegrity()).state).toBe('verified');
  entry.details.z.reverse();
  await writeFile(file, JSON.stringify(entry));
  expect((await verifyAuditIntegrity()).valid).toBe(false);
});
it('labels historical v1 signatures partial and appends v2 across restart', async () => {
  const entry = JSON.parse(await readFile(file, 'utf8'));
  delete entry.chainVersion;
  entry.integrity = createHmac('sha256', 'a'.repeat(64))
    .update(`${entry.prevHash}|${entry.id}|${entry.action}|${entry.actorId}|${entry.timestamp}`)
    .digest('hex');
  await writeFile(file, JSON.stringify(entry) + '\n');
  vi.resetModules();
  const restarted = await import('./audit-service.js');
  await restarted.logAuditEvent({
    action: 'log.retention',
    actorId: 'new',
    targetType: 'case',
    targetId: '2',
  });
  const result = await restarted.queryAuditEvents({});
  expect(result.verification).toMatchObject({
    valid: true,
    state: 'legacy-partial',
    legacyEntries: 1,
    totalEntries: 2,
  });
  expect(result.events.map((e) => e.verificationState)).toEqual(['verified', 'legacy-partial']);
});
it('detects malformed and filtered-out corrupt records', async () => {
  await writeFile(file, (await readFile(file, 'utf8')) + '{broken\n');
  expect((await queryAuditEvents({ action: 'no-match' })).verification.state).toBe('invalid');
});
