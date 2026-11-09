import { describe, expect, it, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { managedTerminalRoutes, terminalMemoryExpired, terminalUnit, terminalUnitProperties, terminalUnitMatches, terminalUnitRetired, terminalFailureReason, type ManagedTerminals } from './managed-terminal.js';

const authority = () => ({ workId: randomUUID(), ownerId: randomUUID(), nodeId: 'node-1', nodeFqdn: 'node-1.example.com',
  epoch: 1, barrierId: randomUUID(), operationSha256: 'a'.repeat(64), requestSha256: 'b'.repeat(64), fence: '1', deadline: Date.now() + 60000 });
afterEach(() => vi.unstubAllEnvs());
describe('managed terminal boundary', () => {
  it('expires unread output after settled cleanup while retaining unacknowledged owners', () => {
    const receipt = { terminalAt: 1000 };
    expect(terminalMemoryExpired({ settled: true, receipt }, 301001)).toBe(true);
    expect(terminalMemoryExpired({ settled: true, receipt }, 301000)).toBe(false);
    for (const intent of [{}, { receipt }, { settled: false, receipt }, { settled: true }])
      expect(terminalMemoryExpired(intent, 999999999)).toBe(false);
  });
  it('accepts only an absent or fully unloaded unit as retired, and never logs provider content', () => {
    expect(terminalUnitRetired(null)).toBe(true);
    const retired = { ActiveState: 'inactive', SubState: 'dead', InvocationID: '', ControlGroup: '' };
    expect(terminalUnitRetired(retired)).toBe(true);
    for (const patch of [{ ActiveState: 'activating' }, { SubState: 'running' }, { InvocationID: 'a'.repeat(32) }, { ControlGroup: '/system.slice/other.service' }])
      expect(terminalUnitRetired({ ...retired, ...patch })).toBe(false);
    expect(terminalFailureReason(new Error('private-terminal-input-must-never-be-logged'))).toBe('authority-or-supervision-unavailable');
  });
  it('uses a dedicated bounded cgroup, read-only host and no privileged or scheduler escape', () => {
    const value = authority(); const file = '/run/magnus-terminals/' + 'a'.repeat(64) + '/pty';
    const properties = terminalUnitProperties('terminal', value.deadline, file);
    expect(properties).toEqual(expect.arrayContaining(['User=terminal', 'Group=terminal', 'SupplementaryGroups=',
      'KillMode=control-group', 'ExitType=cgroup', 'NoNewPrivileges=yes', 'ProtectSystem=strict',
      'ProtectHome=read-only', 'PrivateTmp=yes', 'ProtectControlGroups=yes', 'RestrictNamespaces=yes',
      'RestrictSUIDSGID=yes', 'CapabilityBoundingSet=', 'RestrictAddressFamilies=AF_INET AF_INET6 AF_NETLINK']));
    expect(properties.some(value => value.startsWith('RuntimeMaxSec='))).toBe(true);
    expect(terminalUnit(value)).toMatch(/^magnus-terminal-[a-f0-9]{64}\.service$/);
    for (const user of ['root;id', 'a\nUser=root', '']) expect(() => terminalUnitProperties(user, value.deadline, file)).toThrow();
    expect(() => terminalUnitProperties('terminal', Date.now() - 1, file)).toThrow();
    expect(() => terminalUnitProperties('terminal', value.deadline, '/etc/passwd')).toThrow();
  });
  it('never turns changed invocation, cgroup or cleanup properties into completion evidence', () => {
    const value = authority(); const intent = { authority: value, user: 'terminal', uid: 1001, unit: terminalUnit(value), bootId: randomUUID(), startedAt: Date.now(),
      invocationId: 'a'.repeat(32), cgroup: '/system.slice/' + terminalUnit(value) };
    const observed = { User: 'terminal', Group: 'terminal', NoNewPrivileges: 'yes', ProtectSystem: 'strict', ProtectHome: 'read-only', PrivateTmp: 'yes', InvocationID: intent.invocationId, ControlGroup: intent.cgroup, KillMode: 'control-group',
      ExitType: 'cgroup', RemainAfterExit: 'yes', Restart: 'no' };
    expect(terminalUnitMatches(observed, intent)).toBe(true);
    expect(terminalUnitMatches({ ...observed, ControlGroup: '', ActiveState: 'active', SubState: 'exited' }, intent)).toBe(true);
    expect(terminalUnitMatches({ ...observed, ControlGroup: '', ActiveState: 'active', SubState: 'running' }, intent)).toBe(false);
    for (const patch of [{ InvocationID: 'b'.repeat(32) }, { ControlGroup: '/system.slice/other.service' },
      { KillMode: 'process' }, { ExitType: 'main' }, { Restart: 'always' }, { User: 'root' }, { NoNewPrivileges: 'no' }, { ProtectSystem: 'no' }, { ProtectHome: 'no' }]) expect(terminalUnitMatches({ ...observed, ...patch }, intent)).toBe(false);
  });
  it('denies unprivileged nodes and rejects injected commands or environment before calling the executor', async () => {
    const action = vi.fn().mockResolvedValue({ state: 'running' });
    const app = new Hono().route('/terminal', managedTerminalRoutes({ action } as unknown as ManagedTerminals));
    const send = (body: unknown) => app.request('/terminal/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    vi.stubEnv('MAGNUS_AGENT_PRIVILEGED', 'false');
    expect((await send({ authority: authority(), action: 'open', size: { cols: 100, rows: 30 } })).status).toBe(403);
    vi.stubEnv('MAGNUS_AGENT_PRIVILEGED', 'true');
    for (const patch of [{ command: '/bin/sh' }, { environment: { USER: 'root' } }, { host: 'other.example.com' }, { size: { cols: -1, rows: 30 } }])
      expect((await send({ authority: authority(), action: 'open', size: { cols: 100, rows: 30 }, ...patch })).status).toBe(400);
    expect(action).not.toHaveBeenCalled();
    expect((await send({ authority: authority(), action: 'open', size: { cols: 100, rows: 30 } })).status).toBe(200);
    expect(action).toHaveBeenCalledTimes(1);
  });
});
