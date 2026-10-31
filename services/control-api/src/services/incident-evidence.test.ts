import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentReleaseEvidence, evidenceEnvelope } from './incident-evidence.js';
import { lessonSchema } from './incident-lessons.js';
describe('incident review artifacts', () => {
  it('exports repeatable checksums and enforces the byte ceiling', () => {
    expect(evidenceEnvelope({ incidentId: 'one' })).toEqual(
      evidenceEnvelope({ incidentId: 'one' }),
    );
    expect(() => evidenceEnvelope({ incidentId: 'one' }, 2)).toThrow('Narrow');
    expect(evidenceEnvelope({ incidentId: 'one' }).markdown).toContain('not causality');
  });
  it('requires explicit review, expiry, and sanitized lesson text', () => {
    const lesson = {
      incidentId: 'one',
      symptom: 'Worker unavailable',
      cause: 'Worker service stopped',
      runbookVersion: 'restart-service.v1',
      evidenceIds: ['execution1'],
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      reviewed: true,
    };
    expect(lessonSchema.safeParse(lesson).success).toBe(true);
    expect(lessonSchema.safeParse({ ...lesson, reviewed: false }).success).toBe(false);
    expect(lessonSchema.safeParse({ ...lesson, cause: 'password=exposed-secret' }).success).toBe(
      false,
    );
  });
  it('includes only validated release digests and rejects missing provenance', () => {
    const directory=mkdtempSync(join(tmpdir(),'magnus-release-evidence-'));const file=join(directory,'manifest.json');
    try {
      writeFileSync(file,JSON.stringify({commit:'a'.repeat(40),sourceTreeSha256:'b'.repeat(64),releaseTreeSha256:'c'.repeat(64),distTreeSha256:'d'.repeat(64),prismaSchemaSha256:'e'.repeat(64),secret:'private-excluded'}));
      expect(currentReleaseEvidence(file)?.commit).toBe('a'.repeat(40));expect(JSON.stringify(currentReleaseEvidence(file))).not.toContain('private-excluded');
      writeFileSync(file,'{}');expect(currentReleaseEvidence(file)).toBeNull();
    } finally {rmSync(directory,{recursive:true,force:true});}
  });

});
