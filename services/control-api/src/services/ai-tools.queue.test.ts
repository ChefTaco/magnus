import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(), findUnique: vi.fn(), enqueue: vi.fn(), audit: vi.fn(), nodeFind: vi.fn(), skill: vi.fn(), agentCalls: 0,
}));
vi.mock('../db/index.js', () => ({
  getDb: () => ({ remoteCommand: { create: mocks.create, findUnique: mocks.findUnique }, node: { findUnique: mocks.nodeFind } }),
}));
vi.mock('../queue/workers.js', () => ({ enqueueCommand: mocks.enqueue }));
vi.mock('./audit-service.js', () => ({ logAuditEvent: mocks.audit }));
vi.mock('./skill-service.js', async (original) => ({ ...(await original<object>()), getSkill: mocks.skill }));
vi.mock('../sdk/node-api-client.js', async (original) => ({
  ...(await original<object>()),
  NodeApiClient: class { constructor() { mocks.agentCalls += 1; } },
}));
// Poll without waiting.
vi.stubGlobal('setTimeout', ((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout);

const { executeAiTool, blockedAiCommand } = await import('./ai-tools.js');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.agentCalls = 0;
  mocks.nodeFind.mockResolvedValue({ id: 'node-1', name: 'node-1', status: 'ONLINE', ipAddress: '192.0.2.10', port: 4100 });
  mocks.create.mockImplementation(async ({ data }: { data: object }) => ({ id: 'cmd-row-1', ...data }));
  mocks.enqueue.mockResolvedValue(undefined);
  mocks.findUnique.mockResolvedValueOnce({ status: 'RUNNING', result: null })
    .mockResolvedValue({ status: 'COMPLETED', result: { exitCode: 0, stdout: 'ok api_key=sk-livefixture000000000000 done', stderr: '', durationMs: 12 } });
  mocks.skill.mockResolvedValue({ name: 'disk-cleaner' });
});

describe('AI command tools', () => {
  it('run execCommand through the durable queue as the approving user, with redacted output', async () => {
    const outcome = await executeAiTool({ name: 'execCommand', arguments: { nodeId: 'node-1', command: 'df', args: ['-h'] } },
      { actorId: 'user-7', conversationId: 'conv-1' });

    expect(mocks.agentCalls).toBe(0);
    expect(mocks.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      nodeId: 'node-1', command: 'df', args: '["-h"]', status: 'QUEUED', createdBy: 'user-7', approvedBy: 'user-7', correlationId: 'conv-1',
    }) });
    expect(mocks.enqueue).toHaveBeenCalledWith('cmd-row-1');
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'command.ai_exec', actorId: 'user-7', actorType: 'user',
      details: expect.objectContaining({ commandId: 'cmd-row-1' }) }));
    expect(outcome.result).toMatchObject({ commandId: 'cmd-row-1', status: 'COMPLETED', exitCode: 0 });
    expect(JSON.stringify(outcome)).not.toContain('sk-livefixture');
  });

  it('run runSkill through the queue too', async () => {
    await executeAiTool({ name: 'runSkill', arguments: { nodeId: 'node-1', skillName: 'disk-cleaner', action: 'report' } }, { actorId: 'user-7' });
    expect(mocks.agentCalls).toBe(0);
    expect(mocks.create).toHaveBeenCalledWith({ data: expect.objectContaining({ command: 'bash', createdBy: 'user-7' }) });
  });

  it.each([
    ['shutdown', ['-h', 'now']], ['/sbin/reboot', []], ['systemctl', ['poweroff']], ['mkfs.ext4', ['/dev/sdb']],
    ['dd', ['if=/dev/zero', 'of=/dev/sda']], ['bash', ['-c', 'rm -rf /']], ['init', ['0']], ['bash', ['-c', ':(){ :|:& };:']],
  ])('blocks %s %j', (command, args) => {
    expect(blockedAiCommand(command, args)).toBe(true);
  });

  it.each([
    ['grep', ['halted', '/var/log/syslog']], ['journalctl', ['-u', 'shutdown-notifier']], ['dd', ['if=/dev/sda', 'of=/tmp/mbr', 'count=1']],
    ['rm', ['-rf', '/tmp/build']], ['systemctl', ['status', 'nginx']],
  ])('allows %s %j', (command, args) => {
    expect(blockedAiCommand(command, args)).toBe(false);
  });
});
