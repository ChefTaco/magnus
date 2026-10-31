import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { magnusObservationSchema } from '@hivemagnus/magnus-contracts';
const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../../../packages/contracts/fixtures/magnus-observations-v1.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
describe('Magnus observation wire v1', () => {
  it('accepts the provider and consumer fixture and additive optional fields', () => {
    expect(
      magnusObservationSchema.parse({ ...fixture, futureOptional: true }).deployments,
    ).toHaveLength(1);
  });
  it('rejects incompatible versions and malformed deployment status', () => {
    expect(magnusObservationSchema.safeParse({ ...fixture, schemaVersion: 2 }).success).toBe(false);
    expect(
      magnusObservationSchema.safeParse({
        ...fixture,
        deployments: [{ ...fixture.deployments[0], status: 'good-ish' }],
      }).success,
    ).toBe(false);
  });
});
