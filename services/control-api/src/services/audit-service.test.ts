import { appendFile, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  logAuditEvent,
  resolveAuditHmacSecret,
  verifyAuditIntegrity,
} from './audit-service.js';

const originalAuditDir = process.env['AUDIT_LOG_DIR'];
const originalAuditSecret = process.env['AUDIT_HMAC_SECRET'];
const originalMagnusSecret = process.env['MAGNUS_SECRET'];

function event(targetId: string) {
  return {
    action: 'log.retention' as const,
    actorId: 'audit-test',
    actorType: 'system' as const,
    targetType: 'audit-chain',
    targetId,
  };
}

afterEach(() => {
  if (originalAuditDir === undefined) delete process.env['AUDIT_LOG_DIR'];
  else process.env['AUDIT_LOG_DIR'] = originalAuditDir;
  if (originalAuditSecret === undefined) delete process.env['AUDIT_HMAC_SECRET'];
  else process.env['AUDIT_HMAC_SECRET'] = originalAuditSecret;
  if (originalMagnusSecret === undefined) delete process.env['MAGNUS_SECRET'];
  else process.env['MAGNUS_SECRET'] = originalMagnusSecret;
});

describe('audit HMAC chain', () => {
  it('fails closed without a dedicated secret and never uses MAGNUS_SECRET', () => {
    delete process.env['AUDIT_HMAC_SECRET'];
    process.env['MAGNUS_SECRET'] = 'master-secret-that-must-not-sign-audit-events';
    expect(() => resolveAuditHmacSecret()).toThrow(/AUDIT_HMAC_SECRET/);
  });

  it('recovers the verified chain head after an audit-directory switch', async () => {
    const firstDir = await mkdtemp(path.join(tmpdir(), 'magnus-audit-a-'));
    const secondDir = await mkdtemp(path.join(tmpdir(), 'magnus-audit-b-'));
    process.env['AUDIT_HMAC_SECRET'] = 'a'.repeat(64);

    process.env['AUDIT_LOG_DIR'] = firstDir;
    await logAuditEvent(event('first'));
    process.env['AUDIT_LOG_DIR'] = secondDir;
    await logAuditEvent(event('other-directory'));
    process.env['AUDIT_LOG_DIR'] = firstDir;
    await logAuditEvent(event('after-restart'));

    const result = await verifyAuditIntegrity();
    expect(result).toMatchObject({ valid: true, totalEntries: 2, brokenAtIndex: -1 });
    const day = new Date().toISOString().slice(0, 10);
    expect((await readFile(path.join(firstDir, `${day}.jsonl`), 'utf8')).trim().split('\n')).toHaveLength(2);
    expect((await stat(firstDir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(firstDir, `${day}.jsonl`))).mode & 0o777).toBe(0o600);
  });

  it('serializes concurrent appends into one valid chain', async () => {
    process.env['AUDIT_LOG_DIR'] = await mkdtemp(path.join(tmpdir(), 'magnus-audit-concurrent-'));
    process.env['AUDIT_HMAC_SECRET'] = 'b'.repeat(64);
    await Promise.all(Array.from({ length: 12 }, (_, index) => logAuditEvent(event(String(index)))));
    expect(await verifyAuditIntegrity()).toMatchObject({
      valid: true,
      totalEntries: 12,
      brokenAtIndex: -1,
    });
  });

  it('reports malformed chain input instead of silently skipping it', async () => {
    const auditDir = await mkdtemp(path.join(tmpdir(), 'magnus-audit-malformed-'));
    process.env['AUDIT_LOG_DIR'] = auditDir;
    process.env['AUDIT_HMAC_SECRET'] = 'c'.repeat(64);
    await logAuditEvent(event('valid'));
    const day = new Date().toISOString().slice(0, 10);
    await appendFile(path.join(auditDir, `${day}.jsonl`), '{malformed\n');
    expect(await verifyAuditIntegrity()).toMatchObject({ valid: false, brokenAtIndex: 1 });
  });
});
