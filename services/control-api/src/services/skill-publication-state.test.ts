import { describe, expect, it } from 'vitest';
import { isExactInstalledPublication, nextSkillPublicationCommandId, skillPublicationCommandId,
  type SkillPublicationIdentity } from './skill-publication-state.js';

const identity = (overrides: Partial<SkillPublicationIdentity> = {}): SkillPublicationIdentity => ({
  nodeId: 'node-one', skillName: 'maps', version: '2.0.0',
  versionHash: '1'.repeat(64), bundleSha256: '2'.repeat(64), treeSha256: '3'.repeat(64),
  ...overrides,
});

describe('skill publication successor identity', () => {
  it('is stable only for the exact node, skill, version and immutable source digests', () => {
    const expected = skillPublicationCommandId(identity());
    expect(expected).toMatch(/^skill-[a-f0-9]{64}$/);
    expect(skillPublicationCommandId(identity())).toBe(expected);
    for (const changed of [
      identity({ nodeId: 'node-two' }), identity({ skillName: 'writing' }), identity({ version: '2.0.1' }),
      identity({ versionHash: '4'.repeat(64) }), identity({ bundleSha256: '5'.repeat(64) }),
      identity({ treeSha256: '6'.repeat(64) }),
    ]) expect(skillPublicationCommandId(changed)).not.toBe(expected);
    const retry = nextSkillPublicationCommandId(identity(), expected);
    expect(retry).toMatch(/^skill-[a-f0-9]{64}$/);
    expect(retry).not.toBe(expected);
    expect(nextSkillPublicationCommandId(identity(), expected)).toBe(retry);
    expect(nextSkillPublicationCommandId(identity(), retry)).not.toBe(retry);
  });

  it('accepts replay only when the installed identity and all receipt bindings match', () => {
    const exact = identity();
    const evidence = { commandId: skillPublicationCommandId(exact), commandSha256: '7'.repeat(64),
      receiptSha256: '8'.repeat(64) };
    const state = { version: exact.version, status: 'installed', versionHash: exact.versionHash,
      bundleSha256: exact.bundleSha256, treeSha256: exact.treeSha256,
      workflowCommandId: evidence.commandId, workflowRequestSha256: evidence.commandSha256,
      workflowReceiptSha256: evidence.receiptSha256 };
    expect(isExactInstalledPublication(state, exact, evidence)).toBe(true);
    expect(isExactInstalledPublication({ ...state, workflowReceiptSha256: '9'.repeat(64) }, exact, evidence)).toBe(false);
    expect(isExactInstalledPublication({ ...state, status: 'failed' }, exact, evidence)).toBe(false);
  });
});
