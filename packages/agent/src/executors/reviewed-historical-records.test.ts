import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadReviewedHistoricalRecords, REVIEWED_RECORDS_MAX_BYTES } from './reviewed-historical-records.js';

// The test account stands in for root: ownerUid is the uid the file and its directory must have.
const uid = process.getuid!();
const node = 'node-1.example.com';
const id = '0b6f1c2e-6d3a-4f6e-9c1d-2a7b8e9f0a1b';
const other = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const digest = 'a'.repeat(64);
const valid = { version: 1, records: { [id]: { nodeFqdn: node, recordSha256: digest }, [other]: { nodeFqdn: 'node-2.example.com', recordSha256: 'b'.repeat(64) } } };

function file(content: unknown, mode = 0o644): string {
  const dir = mkdtempSync(join(tmpdir(), 'magnus-reviewed-'));
  chmodSync(dir, 0o755);
  const path = join(dir, 'reviewed-historical-records.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  chmodSync(path, mode);
  return path;
}
const load = (path: string, ownerUid = uid) => loadReviewedHistoricalRecords({ path, hostname: node, ownerUid });

describe('reviewed historical records', () => {
  it('is empty without a file', () => {
    expect(load(join(tmpdir(), 'magnus-reviewed-absent', 'none.json'))).toMatchObject({ records: {}, count: 0, problem: null });
  });

  it('honours this node\'s entries from a root-controlled file, ignores other nodes and freezes the result', () => {
    const result = load(file(valid));
    expect(result).toMatchObject({ count: 1, problem: null, records: { [id]: { nodeFqdn: node, recordSha256: digest } } });
    expect(result.records[other]).toBeUndefined();
    expect(Object.isFrozen(result.records)).toBe(true);
    expect(Object.isFrozen(result.records[id])).toBe(true);
  });

  it('refuses a file root does not control', () => {
    expect(load(file(valid, 0o664)).problem).toMatch(/group- or world-writable/);
    expect(load(file(valid, 0o646)).problem).toMatch(/group- or world-writable/);
    expect(load(file(valid), uid + 1).problem).toMatch(/owned by uid \d+, not/);
    const writableDir = file(valid);
    chmodSync(join(writableDir, '..'), 0o777);
    expect(load(writableDir).problem).toMatch(/-reviewed-.* is group- or world-writable/);
    chmodSync(join(writableDir, '..'), 0o755);
    const target = file(valid);
    const link = join(target, '..', 'link.json');
    symlinkSync(target, link);
    expect(load(link)).toMatchObject({ records: {}, problem: expect.stringMatching(/is a symlink/) });
    const dir = join(target, '..', 'dir.json');
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    expect(load(dir).problem).toMatch(/not a regular file/);
  });

  it('refuses a file that does not match the schema, or is too large', () => {
    expect(load(file('{')).problem).toMatch(/not valid JSON/);
    expect(load(file({ ...valid, extra: true })).problem).toMatch(/schema/);
    expect(load(file({ version: 2, records: {} })).problem).toMatch(/schema/);
    expect(load(file({ version: 1, records: { 'not-a-uuid': { nodeFqdn: node, recordSha256: digest } } })).problem).toMatch(/schema/);
    expect(load(file({ version: 1, records: { [id]: { nodeFqdn: node, recordSha256: 'A'.repeat(64) } } })).problem).toMatch(/schema/);
    expect(load(file({ version: 1, records: { [id]: { nodeFqdn: node, recordSha256: digest, note: 'x' } } })).problem).toMatch(/schema/);
    expect(load(file(' '.repeat(REVIEWED_RECORDS_MAX_BYTES + 1))).problem).toMatch(/larger than/);
  });
});
