import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('./hermes-registry-service.js', () => ({ registryRolloutStages: () => new Map() }));

const { isStableHermesTag } = await import('./hermes-core-rollout.js');

describe('isStableHermesTag', () => {
  it.each(['v2026.9.24', 'v2026.10.1.2', 'v0.23.4', 'v1.0.0'])('accepts %s', (tag) => expect(isStableHermesTag(tag)).toBe(true));
  it.each(['', '0.23.4', 'v0.23', 'v0.23.4-rc.1', 'v0.23.4 --upload-pack=x', 'main', 'v2026.9.24/../x'])('refuses %s', (tag) =>
    expect(isStableHermesTag(tag)).toBe(false));
});
