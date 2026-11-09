/** Restricted PTYs live in systemd cgroups. Socket closure is never completion evidence. */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chown, lstat, mkdir, open, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Hono } from 'hono';
import { managedTerminalActionSchema, managedTerminalAuthoritySchema, managedTerminalReceiptPayload,
  managedTerminalReceiptSchema, type ManagedTerminalAuthority, type ManagedTerminalAction,
  type ManagedTerminalReceipt, type ManagedTerminalSize } from '@hivemagnus/magnus-contracts';
import { CONTROL_API_URL, HOST_FQDN, NODE_MANAGER_SECRET, RESULT_SIGNING_SECRET, MAGNUS_EXECUTION_SUPERVISOR_ENABLED } from '../env.js';
import { controlApiFetch } from '../tls.js';
import { requirePrivileged } from '../privileged.js';
import { logger } from '../utils/logger.js';
import { SystemdSupervisorBackend, type UnitObservation } from './execution-supervisor.js';
import { privateDirectory, readJson, writeJson } from './execution-supervisor-state.js';

const exec = promisify(execFile);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const CLEAN_ENV = { PATH: '/usr/bin:/bin', LANG: 'C', SYSTEMD_COLORS: '0' };
const MAX_BUFFER = 256 * 1024;
interface Intent { authority: ManagedTerminalAuthority; user: string; uid: number; unit: string; bootId: string; startedAt: number;
  invocationId?: string; cgroup?: string; receipt?: ManagedTerminalReceipt; settled?: boolean }
interface Live { intent: Intent; child?: ChildProcessWithoutNullStreams; chunks: Buffer[]; bytes: number;
  closing?: Promise<void>; busy: boolean; pendingResize?: ManagedTerminalSize }

/** Closed clients may leave unread bytes. Expire those buffers only after acknowledged cleanup. */
export function terminalMemoryExpired(intent: { settled?: boolean; receipt?: { terminalAt: number } }, now = Date.now()): boolean {
  return intent.settled === true && intent.receipt !== undefined && now - intent.receipt.terminalAt > 300000;
}
export function terminalUnit(authority: ManagedTerminalAuthority): string { return 'magnus-terminal-' + sha(authority.workId) + '.service'; }
export function terminalUnitProperties(user: string, deadline: number, ptyFile: string): string[] {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user) || deadline <= Date.now()
    || !/^\/run\/magnus-terminals\/[a-f0-9]{64}\/pty$/.test(ptyFile)) throw new Error('Invalid terminal supervisor configuration');
  return ['Type=exec', 'ExitType=cgroup', 'RemainAfterExit=yes', 'Restart=no', 'KillMode=control-group',
    'SendSIGKILL=yes', 'TimeoutStopSec=2s', 'RuntimeMaxSec=' + Math.max(1, deadline - Date.now()) + 'ms',
    'User=' + user, 'Group=' + user, 'SupplementaryGroups=', 'NoNewPrivileges=yes', 'UMask=0077',
    'ProtectSystem=strict', 'ProtectHome=read-only', 'PrivateTmp=yes', 'PrivateIPC=yes',
    'ProtectControlGroups=yes', 'ProtectKernelTunables=yes', 'ProtectKernelModules=yes', 'ProtectKernelLogs=yes',
    'RestrictNamespaces=yes', 'RestrictSUIDSGID=yes', 'CapabilityBoundingSet=', 'LockPersonality=yes',
    // No user-manager or cron/at IPC; setuid programs cannot install future work outside this group.
    'RestrictAddressFamilies=AF_INET AF_INET6 AF_NETLINK', 'InaccessiblePaths=-/run/user -/run/dbus/system_bus_socket',
    'ReadWritePaths=' + ptyFile, 'WorkingDirectory=/tmp'];
}
export function terminalUnitMatches(unit: UnitObservation, intent: Intent): boolean {
  return unit['User'] === intent.user && unit['Group'] === intent.user
    && unit['NoNewPrivileges'] === 'yes' && unit['ProtectSystem'] === 'strict' && unit['ProtectHome'] === 'read-only' && unit['PrivateTmp'] === 'yes'
    && unit['InvocationID'] === intent.invocationId && (unit['ControlGroup'] === intent.cgroup
      || (unit['ControlGroup'] === '' && unit['ActiveState'] === 'active' && unit['SubState'] === 'exited'))
    && unit['KillMode'] === 'control-group' && unit['ExitType'] === 'cgroup'
    && unit['RemainAfterExit'] === 'yes' && unit['Restart'] === 'no';
}
/** systemd clears transient properties while unloading an already stopped unit. */
export function terminalUnitRetired(unit: UnitObservation | null): boolean {
  return unit === null || (unit['ActiveState'] === 'inactive' && unit['SubState'] === 'dead'
    && unit['InvocationID'] === '' && unit['ControlGroup'] === '');
}
export function terminalFailureReason(error: unknown): string {
  const reasons: Record<string, string> = {
    'Terminal authority unavailable': 'authority-unavailable',
    'Original terminal supervisor evidence is incomplete': 'supervisor-evidence-incomplete',
    'Original terminal supervisor differs': 'supervisor-changed',
    'Terminal supervisor properties differ': 'supervisor-changed',
    'Terminal group still populated': 'group-populated',
    'Terminal PTY unavailable': 'pty-unavailable', 'Terminal PTY identity differs': 'pty-identity-changed',
    'Managed terminal needs a privileged supervisor and an explicit restricted user': 'not-configured',
    'Restricted terminal identity required': 'restricted-owner-invalid',
  };
  return error instanceof Error ? reasons[error.message] ?? 'authority-or-supervision-unavailable' : 'unknown-failure';
}

async function authorityRequest(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await controlApiFetch(CONTROL_API_URL.replace(/\/$/, '') + '/api/v1/resource-leases/enrollment/' + path,
    { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', 'x-node-token': NODE_MANAGER_SECRET }, body: JSON.stringify(body) });
  if (response.status !== 200) throw new Error('Terminal authority unavailable');
  const envelope = await response.json() as { success?: boolean; data?: Record<string, unknown> };
  if (!envelope.success || !envelope.data) throw new Error('Terminal authority unavailable');
  return envelope.data;
}

export class ManagedTerminals {
  private readonly live = new Map<string, Live>();
  private readonly backend = new SystemdSupervisorBackend();
  private initialized?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private readonly root = resolve(process.env['AGENT_INSTALL_DIR'] ?? process.cwd(), '.magnus/terminals');
  private uid = 0;
  constructor(private readonly user = process.env['MAGNUS_AGENT_MANAGED_TERMINAL_USER'] ?? '',
    private readonly request = authorityRequest) {}

  private directory(authority: ManagedTerminalAuthority) { return join(this.root, sha(authority.workId)); }
  private async save(intent: Intent) { await writeJson(this.directory(intent.authority), 'intent.json', intent); }
  private async initialize() {
    this.initialized ??= (async () => {
      if (!MAGNUS_EXECUTION_SUPERVISOR_ENABLED || process.geteuid?.() !== 0 || !/^[a-z_][a-z0-9_-]{0,31}$/.test(this.user))
        throw new Error('Managed terminal needs a privileged supervisor and an explicit restricted user');
      this.uid = Number((await exec('/usr/bin/id', ['-u', this.user], { env: CLEAN_ENV })).stdout.trim());
      const groups = (await exec('/usr/bin/id', ['-G', this.user], { env: CLEAN_ENV })).stdout.trim().split(/\s+/);
      if (!Number.isSafeInteger(this.uid) || this.uid <= 0 || groups.length !== 1) throw new Error('Restricted terminal identity required');
      await this.backend.probe(); await exec('/usr/bin/script', ['--version'], { env: CLEAN_ENV });
      await privateDirectory(this.root);
      for (const name of await readdir(this.root)) {
        if (!/^[a-f0-9]{64}$/.test(name)) throw new Error('Unknown terminal journal');
        const intent = await readJson<Intent>(join(this.root, name), 'intent.json', 16384);
        if (!intent) throw new Error('Incomplete terminal journal');
        managedTerminalAuthoritySchema.parse(intent.authority);
        if (intent.user !== this.user || intent.uid !== this.uid || terminalUnit(intent.authority) !== intent.unit || sha(intent.authority.workId) !== name) throw new Error('Invalid terminal journal identity');
        if (intent.receipt) { managedTerminalReceiptSchema.parse(intent.receipt); if (intent.settled) continue; }
        const live: Live = { intent, chunks: [], bytes: 0, busy: false };
        this.live.set(intent.authority.workId, live);
        // A daemon restart never reconnects or replays a shell. Retain uncertainty until the original group is proven empty.
        await this.finish(live).catch(() => { logger.warn('Managed terminal recovery held', { reason: 'completion-unverified' }); });
      }
      this.timer = setInterval(() => { for (const live of this.live.values()) {
        if (terminalMemoryExpired(live.intent)) {
          this.live.delete(live.intent.authority.workId); continue;
        }
        if (live.busy || live.intent.settled) continue;
        live.busy = true;
        void this.observe(live).catch(() => { logger.warn('Managed terminal observation held', { reason: 'completion-unverified' }); })
          .finally(() => { live.busy = false; });
      } }, 500); this.timer.unref();
    })();
    return this.initialized;
  }
  async shutdown() {
    clearInterval(this.timer);
    const results = await Promise.allSettled([...this.live.values()].map(live => this.finish(live)));
    if (results.some(result => result.status === 'rejected')) logger.warn('Managed terminal shutdown held', { reason: 'completion-unverified' });
  }
  private async settle(intent: Intent) {
    if (intent.receipt && !intent.settled) {
      const result = await this.request('terminal-receipt', intent.receipt);
      if (result['state'] !== 'released') throw new Error('Terminal settlement not acknowledged');
      intent.settled = true; await this.save(intent);
    }
  }
  private async observe(live: Live) {
    if (live.intent.receipt) return this.settle(live.intent);
    const unit = await this.backend.inspect(live.intent.unit);
    if (Date.now() >= live.intent.authority.deadline || terminalUnitRetired(unit) || (unit && ['exited', 'dead', 'failed'].includes(unit['SubState'] ?? '')))
      await this.finish(live);
  }
  private async finish(live: Live): Promise<void> {
    if (live.intent.receipt) return this.settle(live.intent);
    live.closing ??= (async () => {
      const intent = live.intent;
      if (!intent.cgroup || !intent.invocationId || (await this.backend.probe()).bootId !== intent.bootId)
        throw new Error('Original terminal supervisor evidence is incomplete');
      let unit = await this.backend.inspect(intent.unit);
      if (!terminalUnitRetired(unit) && (!unit || !terminalUnitMatches(unit, intent))) throw new Error('Original terminal supervisor differs');
      if (unit && !terminalUnitRetired(unit)) {
        // Stop even an empty, activating group: a queued start must not race a completion receipt.
        await exec('/usr/bin/systemctl', ['stop', intent.unit], { env: CLEAN_ENV, timeout: 8000 });
        unit = await this.backend.inspect(intent.unit);
      }
      // Stopped transient units can unload. The retained invocation and exact cgroup still bind this observation.
      if ((!terminalUnitRetired(unit) && (!unit || !terminalUnitMatches(unit, intent))) || !await this.backend.empty(intent.cgroup)) throw new Error('Terminal group still populated');
      const unsigned = { ...intent.authority, version: 1 as const, boundary: 'restricted-terminal-process-v1' as const,
        bootId: intent.bootId, unit: intent.unit, invocationId: intent.invocationId, cgroup: intent.cgroup,
        startedAt: intent.startedAt, terminalAt: Date.now(), groupEmpty: true as const };
      const receipt = managedTerminalReceiptSchema.parse({ ...unsigned, signature: createHmac('sha256', RESULT_SIGNING_SECRET)
        .update(managedTerminalReceiptPayload(unsigned)).digest('hex') });
      intent.receipt = receipt; await this.save(intent);
      live.child?.kill();
      await this.settle(intent);
    })();
    try { await live.closing; } catch (error) { live.closing = undefined; throw error; }
  }

  private async resize(live: Live, size: ManagedTerminalSize) {
    const ptyFile = '/run/magnus-terminals/' + sha(live.intent.authority.workId) + '/pty';
    const tty = (await readFile(ptyFile, 'utf8')).trim();
    if (!/^\/dev\/pts\/[0-9]+$/.test(tty)) throw new Error('Terminal PTY unavailable');
    const info = await lstat(tty);
    if (!info.isCharacterDevice() || info.uid !== this.uid) throw new Error('Terminal PTY identity differs');
    await exec('/usr/bin/stty', ['--file', tty, 'cols', String(size.cols), 'rows', String(size.rows)], { env: CLEAN_ENV, timeout: 2000 });
  }
  async action(authority: ManagedTerminalAuthority, action: ManagedTerminalAction): Promise<Record<string, unknown>> {
    if (authority.nodeFqdn !== HOST_FQDN) throw new Error('Terminal target differs');
    await this.initialize();
    if (action.action === 'open') {
      if (authority.deadline <= Date.now() || authority.deadline > Date.now() + 3_600_000 || this.live.has(authority.workId))
        throw new Error('Terminal start is single use and bounded');
      if ([...this.live.values()].some(value => !value.intent.receipt)) throw new Error('Another terminal needs completion evidence');
      const nonce = randomUUID();
      const claim = await this.request('terminal-claim', { authority, nonce });
      if (claim['admitted'] !== true || claim['nonce'] !== nonce
        || Object.entries(authority).some(([key, value]) => claim[key] !== value)) throw new Error('Terminal grant differs');
      const intent: Intent = { authority, user: this.user, uid: this.uid, unit: terminalUnit(authority), bootId: (await this.backend.probe()).bootId, startedAt: Date.now() };
      await privateDirectory(this.directory(authority)); await this.save(intent);
      const runtime = '/run/magnus-terminals'; await mkdir(runtime, { recursive: true, mode: 0o711 });
      const parent = await lstat(runtime); if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || parent.mode & 0o022) throw new Error('Unsafe terminal runtime');
      const directory = join(runtime, sha(authority.workId)); await mkdir(directory, { mode: 0o711 });
      const ptyFile = join(directory, 'pty'); const file = await open(ptyFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await file.close(); await chown(ptyFile, this.uid, Number((await exec('/usr/bin/id', ['-g', this.user], { env: CLEAN_ENV })).stdout.trim()));
      const command = '/usr/bin/tty > ' + ptyFile + '; exec /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp HISTFILE=/dev/null HISTSIZE=0 HISTFILESIZE=0 TERM=xterm-256color USER=' + this.user + ' LOGNAME=' + this.user + ' /bin/bash --noprofile --norc';
      const child = spawn('/usr/bin/systemd-run', ['--quiet', '--pipe', '--wait', '--unit=' + intent.unit,
        ...terminalUnitProperties(this.user, authority.deadline, ptyFile).map(value => '--property=' + value),
        '--', '/usr/bin/script', '--quiet', '--return', '--flush', '--command', command, '/dev/null'], { env: CLEAN_ENV, stdio: 'pipe' });
      const live: Live = { intent, child, chunks: [], bytes: 0, busy: false }; this.live.set(authority.workId, live);
      child.on('error', () => { logger.warn('Managed terminal launch held', { reason: 'supervisor-unavailable' }); });
      child.stdout.on('data', (chunk: Buffer) => {
        if (live.bytes + chunk.length > MAX_BUFFER) { void this.finish(live).catch(() => undefined); return; }
        live.chunks.push(chunk); live.bytes += chunk.length;
        if (live.bytes >= MAX_BUFFER / 2) child.stdout.pause();
      });
      // systemd diagnostics are neither terminal content nor safe public error messages.
      child.stderr.resume();
      for (let attempt = 0; attempt < 50; attempt++) {
        const unit = await this.backend.inspect(intent.unit);
        if (unit && /^[a-f0-9]{32}$/.test(unit['InvocationID'] ?? '') && unit['ControlGroup'] === '/system.slice/' + intent.unit) {
          intent.invocationId = unit['InvocationID']; intent.cgroup = unit['ControlGroup'];
          if (!terminalUnitMatches(unit, intent)) throw new Error('Terminal supervisor properties differ');
          await this.save(intent);
          try { await this.resize(live, action.size); } catch { live.pendingResize = action.size; }
          return { state: 'running' };
        }
        await new Promise(resolveWait => setTimeout(resolveWait, 100));
      }
      throw new Error('Terminal supervisor did not become observable');
    }
    const live = this.live.get(authority.workId);
    if (!live || JSON.stringify(live.intent.authority) !== JSON.stringify(authority)) throw new Error('Terminal owner differs');
    if (action.action === 'close') await this.finish(live);
    else if (action.action === 'input' || action.action === 'resize') {
      if (live.intent.receipt || authority.deadline <= Date.now()) throw new Error('Terminal authority expired');
      if (action.action === 'input') { if (!live.child?.stdin.write(action.data)) throw new Error('Terminal input busy'); }
      else await this.resize(live, action.size);
    } else {
      if (live.pendingResize) { try { await this.resize(live, live.pendingResize); live.pendingResize = undefined; } catch { /* PTY may still be starting. */ } }
      await this.observe(live);
      const first = live.chunks.shift() ?? Buffer.alloc(0); const chunk = first.subarray(0, 24 * 1024);
      if (first.length > chunk.length) live.chunks.unshift(first.subarray(chunk.length));
      live.bytes -= chunk.length; if (live.bytes < MAX_BUFFER / 2) live.child?.stdout.resume();
      return { state: live.intent.receipt ? 'completed' : 'running', dataBase64: chunk.toString('base64'), ...(live.intent.receipt ? { receipt: live.intent.receipt } : {}) };
    }
    return { state: live.intent.receipt ? 'completed' : 'running', ...(live.intent.receipt ? { receipt: live.intent.receipt } : {}) };
  }
}

let service: ManagedTerminals | undefined;
export async function stopManagedTerminals() { await service?.shutdown(); }
export function managedTerminalRoutes(terminals = (service ??= new ManagedTerminals())) {
  const app = new Hono(); app.use('*', requirePrivileged('managed-terminal'));
  app.post('/session', async c => {
    const input = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const authority = managedTerminalAuthoritySchema.safeParse(input?.['authority']);
    const operation = managedTerminalActionSchema.safeParse(input && Object.fromEntries(
      Object.entries(input).filter(([key]) => key !== 'authority')));
    if (!authority.success || !operation.success) return c.json({ success: false, error: { code: 'INVALID_TERMINAL_OPERATION' } }, 400);
    try { return c.json({ success: true, data: await terminals.action(authority.data, operation.data) }); }
    catch (error) { logger.warn('Managed terminal operation held', { reason: terminalFailureReason(error) });
      return c.json({ success: false, error: { code: 'MANAGED_TERMINAL_UNAVAILABLE' } }, 409); }
  });
  return app;
}
