import { describe, expect, it } from 'vitest';
import { PARTICIPANT_RECEIPT_LIMITS, ParticipantEvidenceError, readParticipantReceipt } from './resource-enrollment.js';

const blocker = (index: number) => ({ identityVersion: 2, kind: 'SYSTEM_TIMER_DEFINITION'.padEnd(80, '_'), sourceSha256: index.toString(16).padStart(64, '0'), count: 1_000_000 });

describe('participant receipt bounds', () => {
  it('reads a scheduler receipt with the schema maximum of external blockers', async () => {
    const body = JSON.stringify({ externalBlockers: Array.from({ length: 1024 }, (_, index) => blocker(index)), padding: 'x'.repeat(1024) });
    expect(body.length).toBeGreaterThan(PARTICIPANT_RECEIPT_LIMITS.default);
    expect(body.length).toBeLessThan(PARTICIPANT_RECEIPT_LIMITS.scheduler);
    await expect(readParticipantReceipt(new Response(body), PARTICIPANT_RECEIPT_LIMITS.scheduler)).resolves.toMatchObject({ padding: expect.any(String) });
    await expect(readParticipantReceipt(new Response(body))).rejects.toMatchObject({ code: 'participant-response-too-large' });
  });

  it('keeps only a fixed cause and a well-formed participant code from failures', async () => {
    const failed = await readParticipantReceipt(new Response(JSON.stringify({ error: { code: 'LEDGER_UNAVAILABLE', message: 'secret detail' } }), { status: 503 }))
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(ParticipantEvidenceError);
    expect(failed).toMatchObject({ code: 'participant-http-503', agentCode: 'LEDGER_UNAVAILABLE' });
    expect(JSON.stringify(failed)).not.toContain('secret detail');
    await expect(readParticipantReceipt(new Response(JSON.stringify({ error: { code: 'bad code; rm' } }), { status: 500 })))
      .rejects.toMatchObject({ agentCode: null });
    await expect(readParticipantReceipt(new Response('not json'))).rejects.toMatchObject({ code: 'participant-response-invalid' });
  });
});
