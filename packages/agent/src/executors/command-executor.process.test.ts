import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyCommandResult } from '../security/command-result-signature.js';

const secret = 'executor-process-test-signing-key-at-least-32-bytes';
let root: string;
let executor: typeof import('./command-executor.js');
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'magnus-command-process-'));
  vi.resetModules(); vi.stubEnv('AGENT_INSTALL_DIR', root); vi.stubEnv('RESULT_SIGNING_SECRET', secret);
  executor = await import('./command-executor.js');
});
afterEach(async () => {
  await executor.drainRunningCommands(0);
  vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
});

describe('real command execution and durable results', () => {
  it('executes once and serves exactly the signed durable result on replay and receipt lookup', async () => {
    const script = join(root, 'effect.cjs'); const output = join(root, 'effects');
    await writeFile(script, `require('node:fs').appendFileSync(${JSON.stringify(output)}, 'once\\n'); console.log('finished');`);
    const request = { commandId: 'execute-once', command: process.execPath, args: [script], timeoutSeconds: 5 };
    const result = await executor.executeCommand(request);
    expect(result).toMatchObject({ exitCode: 0, stdout: 'finished\n' });
    expect(verifyCommandResult(result, secret)).toBe(true);
    expect(await executor.executeCommand(request)).toEqual(result);
    const response = await executor.commandRoutes.request('/receipts/execute-once');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { state: 'completed', result } });
    expect(await readFile(output, 'utf8')).toBe('once\n');
  });

  it('refuses a managed command before any effect when the supervisor is disabled', async () => {
    const script = join(root, 'managed-effect.cjs'); const output = join(root, 'managed-effects');
    await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(output)}, 'ran');`);
    const request = { commandId: 'managed-no-supervisor', command: process.execPath, args: [script], timeoutSeconds: 5,
      coordination: { version: 1 as const, resourceKey: 'node:fixture', fence: '1', expiresAt: Date.now() + 60_000 } };
    await expect(executor.executeCommand(request)).rejects.toMatchObject({ code: 'LEDGER_UNAVAILABLE' });
    await expect(readFile(output, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await executor.commandLedger.receipt(request.commandId)).toBeNull();
  });

  it('kills the command process group on timeout, including a descendant ignoring SIGTERM', async () => {
    const heartbeat = join(root, 'heartbeat'); const script = join(root, 'tree.cjs');
    const descendant = `process.on('SIGTERM',()=>{}); setInterval(()=>require('node:fs').writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),20);`;
    await writeFile(script, `process.on('SIGTERM',()=>{}); require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'}); setInterval(()=>{},100);`);
    const result = await executor.executeCommand({ commandId: 'timeout-tree', command: process.execPath, args: [script], timeoutSeconds: 1 });
    expect(result.exitCode).toBe(124); expect(verifyCommandResult(result, secret)).toBe(true);
    const stopped = await readFile(heartbeat, 'utf8');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(await readFile(heartbeat, 'utf8')).toBe(stopped);
    expect(await executor.commandLedger.receipt('timeout-tree')).toMatchObject({ state: 'completed', result: { exitCode: 124 } });
  }, 15_000);

  it('drains the child and persists its receipt before shutdown, refusing new executions', async () => {
    const started = join(root, 'started'); const script = join(root, 'wait.cjs');
    await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(started)},'started'); setInterval(()=>{},100);`);
    const pending = executor.executeCommand({ commandId: 'shutdown', command: process.execPath, args: [script], timeoutSeconds: 60 });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await readFile(started, 'utf8').catch(() => '') === 'started') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(await readFile(started, 'utf8')).toBe('started');
    await executor.drainRunningCommands(0);
    const result = await pending;
    expect(verifyCommandResult(result, secret)).toBe(true);
    expect(await executor.commandLedger.receipt('shutdown')).toMatchObject({ state: 'completed', result });
    await expect(executor.executeCommand({ commandId: 'after-drain', command: 'true', args: [], timeoutSeconds: 1 })).rejects.toMatchObject({ code: 'LEDGER_UNAVAILABLE' });
  });

  it('produces a signed terminal spawn-error receipt without repeating the failed start', async () => {
    const input = { commandId: 'spawn-error', command: 'true', args: [], workingDirectory: join(root, 'missing'), timeoutSeconds: 1 };
    const result = await executor.executeCommand(input);
    expect(result.exitCode).toBe(127); expect(verifyCommandResult(result, secret)).toBe(true);
    expect(await executor.executeCommand(input)).toEqual(result);
  });
});
