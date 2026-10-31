import { describe, expect, it } from 'vitest';
import { heartbeatRequestSchema } from './heartbeat.js';

const agentHeartbeat = {
  agentVersion: '2.3.15', uptimeSeconds: 12.5, status: 'healthy', fqdn: 'node-one.example.net',
  platform: 'linux', arch: 'x64',
  health: {
    cpu: { usagePercent: 3, cores: 8, loadAverage: [0.1, 0.2, 0.3] },
    network: [{ interface: 'eth0', rxBytes: 1, txBytes: 2, rxErrors: 0, txErrors: 0, ipAddress: '10.0.0.5' }],
    disks: [], services: [], futureField: { nested: true },
  },
  securityCapabilities: { isolation: false, serviceRestart: true },
  hermes: { installed: true },
  newerAgentField: 'kept',
};

describe('heartbeat request envelope', () => {
  it('accepts the payload the agent sends, including unknown fields', () => {
    const parsed = heartbeatRequestSchema.parse(agentHeartbeat);
    expect(parsed).toMatchObject({ newerAgentField: 'kept', health: { futureField: { nested: true } } });
    expect(heartbeatRequestSchema.safeParse({}).success).toBe(true);
  });

  it.each([
    { fqdn: 42 },
    { fqdn: 'a'.repeat(254) },
    { agentVersion: 'v'.repeat(65) },
    { health: { network: 'eth0' } },
    { securityCapabilities: { isolation: 'yes' } },
  ])('rejects mistyped fields the route reads: %j', (body) => {
    expect(heartbeatRequestSchema.safeParse(body).success).toBe(false);
  });
});
