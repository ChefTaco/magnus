import { describe, expect, expectTypeOf, it } from 'vitest';
import { discoveredAgentSchema } from '@hivemagnus/magnus-contracts/browser';
import type { DiscoveredAgent } from './contracts';

// POST /discovery/scan answers each agent's `version`; the console once typed it as `agentVersion`.
describe('discovery scan result type', () => {
  it('matches the published browser contract', () => {
    expectTypeOf<DiscoveredAgent>().toEqualTypeOf<ReturnType<typeof discoveredAgentSchema.parse>>();
    const sample: DiscoveredAgent = { hostname: 'node-1', fqdn: 'node-1.example.com', ip: '192.0.2.10', port: 4100, version: '3.6.0', registered: false };
    expect(discoveredAgentSchema.parse(sample)).toEqual(sample);
  });
});
