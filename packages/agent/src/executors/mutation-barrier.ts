/** Durable legacy-mutation tracking. A process crash never proves work stopped. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { HOST_FQDN } from '../env.js';
import { commandRequestDigest, type CommandIdentity, type CommandLedger } from './command-ledger.js';
import { historicalHash, signHistoricalObservation, signHistoricalReceipt, verifyHistoricalAssertion,
  verifyHistoricalReceipt, readHostBoot, reviewedHistoricalRecords, type ReviewedHistoricalRecords,
  type HistoricalKeys, type HistoricalReceipt, type HostBoot } from './historical-mutation.js';

const identitySchema = z.object({ nodeId: z.string().min(1).max(128), nodeFqdn: z.string().min(1).max(253),
  epoch: z.number().int().positive(), barrierId: z.string().guid() }).strict();
export type DrainIdentity = z.infer<typeof identitySchema>;
const commandBindingSchema = z.object({ commandId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  requestSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const recordSchema = z.object({ version: z.literal(1), id: z.string().guid(), nonce: z.string().guid(),
  routeSha256: z.string().regex(/^[a-f0-9]{64}$/), acceptedAt: z.number().int().nonnegative(),
  state: z.enum(['active', 'unknown', 'completed']), commandBinding: commandBindingSchema.optional(),
  completionSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
type MutationRecord = z.infer<typeof recordSchema>;
export interface MutationToken { id: string; nonce: string }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class MutationBarrier {
  private readonly active = new Set<string>();
  constructor(readonly root = resolve(process.env['AGENT_INSTALL_DIR'] ?? process.cwd(), '.magnus/mutation-barrier'),
    private readonly hostname = HOST_FQDN,
    private readonly historicalKeys: HistoricalKeys = { result: process.env['RESULT_SIGNING_SECRET'] ?? '',
      reconciliation: process.env['COMMAND_RECONCILIATION_SECRET'] ?? '' },
    private readonly bootReader: () => Promise<HostBoot> = readHostBoot,
    private readonly reviewedRecords: ReviewedHistoricalRecords = reviewedHistoricalRecords) {}

  private async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Private mutation barrier required');
  }
  private async sync() {
    const handle = await open(this.root, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  private async read(name: string): Promise<unknown | undefined> {
    let handle;
    try { handle = await open(join(this.root, name), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077 || info.size > 16_384) throw new Error('Invalid mutation barrier record');
      return JSON.parse(await handle.readFile('utf8')) as unknown;
    } finally { await handle.close(); }
  }
  private async write(name: string, value: unknown) {
    const temporary = join(this.root, '.write-' + randomUUID());
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, join(this.root, name)); await this.sync();
    } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  }
  private async locked<T>(callback: () => Promise<T>): Promise<T> {
    await this.initialize();
    if (process.platform !== 'linux') throw new Error('Mutation barrier requires Linux locking');
    const handle = await open(join(this.root, 'barrier.flock'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077) throw new Error('Invalid mutation barrier mutex');
      const code = await new Promise<number | null>((resolveCode, reject) => {
        const child = spawn('/usr/bin/flock', ['--exclusive', '--wait', '2', '3'], { stdio: ['ignore', 'ignore', 'ignore', handle.fd] });
        child.once('error', reject); child.once('exit', resolveCode);
      });
      if (code !== 0) throw new Error('Mutation barrier is unavailable');
      return await callback();
    } finally { await handle.close(); }
  }
  private async lockedRead<T>(callback: () => Promise<T>): Promise<T> {
    const rootInfo = await lstat(this.root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o077))
      throw new Error('Private mutation barrier required');
    if (process.platform !== 'linux') throw new Error('Mutation barrier requires Linux locking');
    const handle = await open(join(this.root, 'barrier.flock'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077) throw new Error('Invalid mutation barrier mutex');
      const code = await new Promise<number | null>((resolveCode, reject) => {
        const child = spawn('/usr/bin/flock', ['--shared', '--wait', '2', '3'], { stdio: ['ignore', 'ignore', 'ignore', handle.fd] });
        child.once('error', reject); child.once('exit', resolveCode);
      });
      if (code !== 0) throw new Error('Mutation barrier is unavailable');
      return await callback();
    } finally { await handle.close(); }
  }
  private async identity(): Promise<DrainIdentity | null> {
    const raw = await this.read('drain.json');
    if (raw === undefined) return null;
    const value = identitySchema.parse(raw);
    if (value.nodeFqdn !== this.hostname) throw new Error('Mutation barrier belongs to another node');
    return value;
  }

  private async recordDigest(id: string): Promise<string> {
    const handle = await open(join(this.root, 'request-' + z.string().guid().parse(id) + '.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077 || info.size > 16_384) throw new Error('Invalid mutation barrier record');
      return createHash('sha256').update(await handle.readFile()).digest('hex');
    } finally { await handle.close(); }
  }

  private async historicalSettlement(row: MutationRecord, identity: DrainIdentity | null): Promise<HistoricalReceipt | null> {
    const raw = await this.read('historical-' + row.id + '.json');
    if (raw === undefined) return null;
    const receipt = verifyHistoricalReceipt(raw, this.historicalKeys);
    const approved = this.reviewedRecords[row.id];
    if (!approved || approved.nodeFqdn !== this.hostname ||
        receipt.assertion.records.find(r => r.id === row.id)?.recordSha256 !== approved.recordSha256)
      throw new Error('Historical receipt is outside the exact reviewed records');
    if (!identity || historicalHash(receipt.assertion.before.drain) !== historicalHash(identity) ||
        !receipt.assertion.records.some(r => r.id === row.id && r.acceptedAt === row.acceptedAt && r.routeSha256 === row.routeSha256))
      throw new Error('Historical settlement source or drain differs');
    // Compare the actual retained bytes as well, including unexpected formatting changes.
    if (receipt.assertion.records.find(r => r.id === row.id)!.recordSha256 !== await this.recordDigest(row.id))
      throw new Error('Historical settlement journal bytes differ');
    return receipt;
  }

  /** Before-maintenance owner evidence; read-only and signed with the result key. */
  async historicalObservation() {
    return this.lockedRead(async () => {
      const drain = await this.identity();
      if (!drain) throw new Error('Existing durable drain required');
      const names = (await readdir(this.root)).filter(name => name.startsWith('request-')).sort();
      if (names.length > 10_000) throw new Error('Mutation inventory requires reconciliation');
      const records = [];
      for (const name of names) {
        const row = recordSchema.parse(await this.read(name));
        if (name !== 'request-' + row.id + '.json') throw new Error('Mutation record identity differs');
        if (row.state === 'completed' || await this.historicalSettlement(row, drain)) continue;
        if (this.active.has(row.id)) throw new Error('Active operation cannot be retired');
        records.push({ id: row.id, recordSha256: await this.recordDigest(row.id), acceptedAt: row.acceptedAt, routeSha256: row.routeSha256 });
      }
      return signHistoricalObservation({ version: 1, drain, boot: await this.bootReader(), observedAt: Date.now(), records }, this.historicalKeys.result);
    });
  }

  /** Offline root controller only. An independent signed decision and kernel boot
   * boundary release process claims while original rows and outcomes remain unknown. */
  async settleHistorical(raw: unknown): Promise<HistoricalReceipt> {
    const assertion = verifyHistoricalAssertion(raw, this.historicalKeys);
    return this.locked(async () => {
      const now = Date.now();
      const identity = await this.identity();
      if (!identity || historicalHash(identity) !== historicalHash(assertion.before.drain)) throw new Error('Historical drain differs');
      const boot = await this.bootReader();
      if (historicalHash(boot) !== historicalHash(assertion.boot) || assertion.expiresAt <= now || assertion.expiresAt > now + 300_000)
        throw new Error('Historical decision expired or kernel boot differs');
      let retained: HistoricalReceipt | null = null;
      for (const item of assertion.records) {
        const approved = this.reviewedRecords[item.id];
        if (!approved || approved.nodeFqdn !== this.hostname || approved.recordSha256 !== item.recordSha256)
          throw new Error('Historical decision is outside the exact reviewed records');
        const row = recordSchema.parse(await this.read('request-' + item.id + '.json'));
        if (row.id !== item.id || row.state === 'completed' || this.active.has(row.id) || row.acceptedAt !== item.acceptedAt ||
            row.routeSha256 !== item.routeSha256 || await this.recordDigest(row.id) !== item.recordSha256 ||
            ![hash(['POST', '/commands/execute']), hash(['POST', '/codex/update'])].includes(row.routeSha256))
          throw new Error('Historical source differs or operation is outside the reviewed routes');
        const existing = await this.historicalSettlement(row, identity);
        if (existing && historicalHash(existing.assertion) !== historicalHash(assertion)) throw new Error('Historical decision conflicts');
        if (existing) retained = existing;
      }
      const receipt = retained ?? signHistoricalReceipt({ version: 1, assertion, boot, recordedAt: now,
        replayPermitted: false, originalOutcome: 'unknown' }, this.historicalKeys.result);
      // Files are separate from original request rows; partial application is retained
      // and safely repeatable only with the same signed decision.
      for (const item of assertion.records) {
        const prior = await this.read('historical-' + item.id + '.json');
        if (prior === undefined) await this.write('historical-' + item.id + '.json', receipt);
      }
      return receipt;
    });
  }

  /** Must precede the remote admission read, not merely the native handler. */
  async begin(method: string, path: string, command?: CommandIdentity): Promise<MutationToken> {
    if (command && (method !== 'POST' || path !== '/commands/execute')) throw new Error('Command binding requires the exact execution route');
    const commandBinding = command ? commandBindingSchema.parse({ commandId: command.commandId, requestSha256: commandRequestDigest(command) }) : undefined;
    return this.locked(async () => {
      if (await this.identity()) throw new Error('Node mutation admission is draining');
      const row: MutationRecord = { version: 1, id: randomUUID(), nonce: randomUUID(),
        routeSha256: hash([method, path]), acceptedAt: Date.now(), state: 'active', ...(commandBinding ? { commandBinding } : {}) };
      await this.write('request-' + row.id + '.json', row);
      this.active.add(row.id);
      return { id: row.id, nonce: row.nonce };
    });
  }

  /** Only an observed synchronous completion/no-dispatch may remove a claim. */
  async finish(token: MutationToken, outcome: 'completed' | 'unknown'): Promise<void> {
    const id = z.string().guid().parse(token.id);
    await this.locked(async () => {
      const name = 'request-' + id + '.json';
      const raw = await this.read(name);
      if (raw === undefined) {
        if (outcome === 'completed' && !this.active.has(id)) return;
        throw new Error('Mutation claim is missing');
      }
      const row = recordSchema.parse(raw);
      if (row.id !== id || row.nonce !== token.nonce) throw new Error('Mutation claim owner differs');
      // A concurrent recovery can already have proven this exact command complete.
      if (row.state === 'completed' && row.completionSha256) { this.active.delete(id); return; }
      if (!this.active.has(id)) throw new Error('Mutation claim owner differs');
      await this.write(name, { ...row, state: outcome });
      this.active.delete(id);
      if (outcome === 'completed') { await unlink(join(this.root, name)); await this.sync(); }
    });
  }

  /** Internal recovery only: read a validated durable ledger receipt, never caller JSON.
   * The caller must independently observe original supervisor completion first. */
  async settleCompletedCommand(commandId: string, ledger: Pick<CommandLedger, 'receipt'>): Promise<number> {
    return this.locked(async () => {
      const receipt = await ledger.receipt(commandId); // Verifies stored result HMAC and exact receipt binding.
      if (!receipt || receipt.state !== 'completed' || !receipt.result) throw new Error('Completed command proof unavailable');
      const names = (await readdir(this.root)).filter(name => name.startsWith('request-')).sort();
      if (names.length > 10_000) throw new Error('Mutation inventory requires reconciliation');
      let settled = 0;
      for (const name of names) {
        const row = recordSchema.parse(await this.read(name));
        if (name !== 'request-' + row.id + '.json') throw new Error('Mutation record identity differs');
        if (row.state === 'completed' || row.routeSha256 !== hash(['POST', '/commands/execute']) ||
            row.commandBinding?.commandId !== commandId || row.commandBinding.requestSha256 !== receipt.requestSha256) continue;
        // Retain a tombstone so a late original handler cannot overwrite completion
        // with unknown, even when recovery occurred in another process.
        await this.write(name, { ...row, state: 'completed', completionSha256: hash(receipt) });
        this.active.delete(row.id);
        settled++;
      }
      return settled;
    });
  }

  /** Sticky and monotonic. There is deliberately no reset-to-legacy operation. */
  async drain(input: DrainIdentity): Promise<void> {
    const value = identitySchema.parse(input);
    if (value.nodeFqdn !== this.hostname) throw new Error('Drain target differs');
    await this.locked(async () => {
      const previous = await this.identity();
      if (previous && (previous.nodeId !== value.nodeId || previous.epoch > value.epoch
        || previous.epoch === value.epoch && previous.barrierId !== value.barrierId)) throw new Error('Stale or conflicting drain epoch');
      if (!previous || previous.epoch < value.epoch) await this.write('drain.json', value);
    });
  }

  async snapshot(expected: DrainIdentity) {
    return this.locked(async () => {
      const identity = await this.identity();
      if (!identity || JSON.stringify(identity) !== JSON.stringify(identitySchema.parse(expected))) throw new Error('Drain epoch differs');
      const names = (await readdir(this.root)).filter(name => name.startsWith('request-')).sort();
      if (names.length > 10_000) throw new Error('Mutation inventory requires reconciliation');
      const rows: Array<{ id: string; routeSha256: string; state: 'active' | 'unknown' }> = [];
      for (const name of names) {
        const row = recordSchema.parse(await this.read(name));
        if (name !== 'request-' + row.id + '.json') throw new Error('Mutation record identity differs');
        // A crash after the fsynced completion but before unlink is recoverable.
        if (row.state === 'completed' || await this.historicalSettlement(row, identity)) continue;
        rows.push({ id: row.id, routeSha256: row.routeSha256,
          state: row.state === 'active' && this.active.has(row.id) ? 'active' : 'unknown' });
      }
      return { activeCount: rows.filter(row => row.state === 'active').length,
        unknownCount: rows.filter(row => row.state === 'unknown').length,
        evidenceSha256: hash({ identity, rows }) };
    });
  }

  /** Read-only forensic inventory. A row remains unknown until an owning
   * effect receipt or a separately reviewed quiescence decision settles it.
   * Do not return request bodies, tokens, nonces, or private command output. */
  async unknownInventory() {
    return this.lockedRead(async () => {
      const identity = await this.identity();
      const names = (await readdir(this.root)).filter(name => name.startsWith('request-')).sort();
      if (names.length > 10_000) throw new Error('Mutation inventory requires reconciliation');
      const rows: Array<{ id: string; state: 'active' | 'unknown'; acceptedAt: number;
        routeSha256: string; commandId: string | null; requestSha256: string | null;
        historicalSettlement?: { disposition: string; receiptSha256: string; replayPermitted: false } }> = [];
      for (const name of names) {
        const row = recordSchema.parse(await this.read(name));
        if (name !== 'request-' + row.id + '.json') throw new Error('Mutation record identity differs');
        if (row.state === 'completed') continue;
        const settlement = await this.historicalSettlement(row, identity);
        rows.push({ id: row.id, state: row.state === 'active' && this.active.has(row.id) ? 'active' : 'unknown',
          acceptedAt: row.acceptedAt, routeSha256: row.routeSha256,
          commandId: row.commandBinding?.commandId ?? null,
          requestSha256: row.commandBinding?.requestSha256 ?? null,
          ...(settlement ? { historicalSettlement: { disposition: settlement.assertion.disposition,
            receiptSha256: historicalHash(settlement), replayPermitted: false as const } } : {}) });
      }
      return { version: 1 as const, nodeFqdn: this.hostname, drain: identity,
        observedAt: Date.now(), rows, inventorySha256: hash({ identity, rows }),
        unsettledCounts: { active: rows.filter(row => row.state === 'active').length,
          unknown: rows.filter(row => row.state === 'unknown' && !row.historicalSettlement).length },
        historicallySettledCount: rows.filter(row => row.historicalSettlement).length };
    });
  }
}

export const mutationBarrier = new MutationBarrier();
