/** Enrolled nodes use the agent's restricted PTY. Bytes stay in memory, never in audit records. */
import type { ShellChannel, PtySize } from './ssh.js';
import type { ParticipantRequest } from './participant.js';

export async function managedShell(workId: string, ownerId: string, size: PtySize, request: ParticipantRequest): Promise<ShellChannel> {
  const call = (operation: unknown) => request('/terminal/' + workId, { ownerId, operation });
  await call({ action: 'open', size });
  let ended = false; let paused = false; let polling = false; let pending = 0;
  let timer: NodeJS.Timeout | undefined; let writes = Promise.resolve();
  const dataListeners: Array<(value: Buffer) => void> = [];
  const closeListeners: Array<(code: number | null) => void> = [];
  function close(code: number | null) {
    if (ended) return; ended = true; clearTimeout(timer);
    for (const listener of closeListeners) listener(code);
  }
  function terminate() {
    // Closure is an instruction to stop the original group. Only the node's signed proof settles it.
    void call({ action: 'close' }).catch(() => undefined); close(null);
  }
  async function poll() {
    if (ended || paused || polling) return;
    polling = true;
    try {
      const value = await call({ action: 'read' });
      if (typeof value['dataBase64'] !== 'string' || value['dataBase64'].length > 32768
        || !['running', 'completed'].includes(String(value['state']))) throw new Error('Invalid terminal stream');
      const chunk = Buffer.from(value['dataBase64'], 'base64');
      if (!ended && chunk.length) for (const listener of dataListeners) listener(chunk);
      if (value['state'] === 'completed' && !chunk.length) close(0);
    } catch { terminate(); }
    finally { polling = false; if (!ended && !paused) { timer = setTimeout(() => void poll(), 100); timer.unref(); } }
  }
  const enqueue = (operation: unknown) => {
    if (ended) return false;
    pending++;
    writes = writes.then(async () => { if (!ended) await call(operation); }).catch(() => terminate()).finally(() => { pending--; });
    return pending < 16;
  };
  timer = setTimeout(() => void poll(), 10); timer.unref();
  return {
    write: data => enqueue({ action: 'input', data }),
    get congested() { return pending >= 16; },
    resize: next => { enqueue({ action: 'resize', size: next }); },
    pause: () => { paused = true; clearTimeout(timer); },
    resume: () => { paused = false; void poll(); },
    onData: listener => { dataListeners.push(listener); },
    onClose: listener => { if (ended) listener(null); else closeListeners.push(listener); },
    terminate,
  };
}
