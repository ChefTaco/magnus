import { describe, expect, it } from 'vitest';
import { ensureControlHostNodeNow, selectControlHostNodeAddress } from './control-host-node.js';

describe('control-host endpoint identity', () => {
  it('persists the hostname verified by the local HTTPS probe', () => {
    expect(
      selectControlHostNodeAddress('Magnus.Example.Com', '10.20.30.40'),
    ).toBe('magnus.example.com');
  });

  it('falls back to the resolved address when no TLS identity was proven', () => {
    expect(selectControlHostNodeAddress(undefined, '10.20.30.40')).toBe('10.20.30.40');
  });

  it('does not downgrade the configured TLS endpoint after an HTTP-only probe', () => {
    expect(
      selectControlHostNodeAddress(
        undefined,
        '10.20.30.40',
        'magnus.example.com',
        'magnus.example.com',
      ),
    ).toBe('magnus.example.com');
  });

  it('does not treat an arbitrary dotted database value as TLS-verified', () => {
    expect(
      selectControlHostNodeAddress(
        undefined,
        '10.20.30.40',
        'stale.attacker.invalid',
        'magnus.example.com',
      ),
    ).toBe('10.20.30.40');
  });

  it('propagates the HTTPS-proven hostname through the database update', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      node: {
        findFirst: async () => ({
          id: 'magnus-node',
          metadata: '{}',
          ipAddress: '10.20.30.40',
        }),
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          return data;
        },
      },
      agent: { upsert: async () => ({}) },
    };

    await ensureControlHostNodeNow({
      db: db as never,
      probeAgent: async () => ({
        port: 4100,
        version: '1.6.3',
        nodeStatus: 'ONLINE',
        agentStatus: 'RUNNING',
        verifiedTlsHostname: 'magnus.example.com',
      }),
      resolveAddress: async () => '10.20.30.40',
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]?.['hostname']).toBe('magnus.example.com');
    expect(updates[0]?.['ipAddress']).toBe('magnus.example.com');
  });

  it('preserves the stored verified endpoint when the local TLS probe is transiently unavailable', async () => {
    const priorServername = process.env['CONTROL_HOST_AGENT_TLS_SERVERNAME'];
    const priorRegisterOffline = process.env['CONTROL_HOST_NODE_REGISTER_OFFLINE'];
    process.env['CONTROL_HOST_AGENT_TLS_SERVERNAME'] = 'magnus.example.com';
    process.env['CONTROL_HOST_NODE_REGISTER_OFFLINE'] = 'true';
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      node: {
        findFirst: async () => ({
          id: 'magnus-node',
          metadata: '{}',
          hostname: 'magnus.example.com',
          ipAddress: 'magnus.example.com',
        }),
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          return data;
        },
      },
      agent: { upsert: async () => ({}) },
    };

    try {
      await ensureControlHostNodeNow({
        db: db as never,
        probeAgent: async () => null,
        resolveAddress: async () => '10.20.30.40',
      });
    } finally {
      if (priorServername === undefined) delete process.env['CONTROL_HOST_AGENT_TLS_SERVERNAME'];
      else process.env['CONTROL_HOST_AGENT_TLS_SERVERNAME'] = priorServername;
      if (priorRegisterOffline === undefined) delete process.env['CONTROL_HOST_NODE_REGISTER_OFFLINE'];
      else process.env['CONTROL_HOST_NODE_REGISTER_OFFLINE'] = priorRegisterOffline;
    }

    expect(updates).toHaveLength(1);
    expect(updates[0]?.['hostname']).toBe('magnus.example.com');
    expect(updates[0]?.['ipAddress']).toBe('magnus.example.com');
  });
});
