type Env = Record<string, string | undefined>;
export type StoredCredentialKind = 'empty' | 'current' | 'legacy' | 'plaintext';
export interface ControlNodeCredentialCounts {
  present: boolean;
  nodes: number;
  current: number;
  legacy: number;
  plaintext: number;
  retired: number;
}
export interface ReencryptionResult {
  status: 'absent' | 'current' | 'reencrypted';
  reencrypted: number;
  encrypted: number;
  retired: number;
  backup: string | null;
}
export function controlNodeStateFile(root: string): string;
export function classifyStoredCredential(value: unknown): StoredCredentialKind;
export function inspectControlNodeCredentials(file: string): ControlNodeCredentialCounts;
export function credentialsNeedReencryption(counts: Pick<ControlNodeCredentialCounts, 'legacy' | 'plaintext' | 'retired'>): boolean;
export function reencryptLegacyControlNodeCredentials(file: string, env?: Env, options?: {
  now?: Date;
  euid?: number | null;
  lockWaitMs?: number;
}): ReencryptionResult;
export function controlNodeStateLockFile(file: string): string;
export function controlNodeStateOwner(file: string): { uid: number; gid: number } | null;
export function withControlNodeStateLock<T>(file: string, fn: () => Promise<T>): Promise<T>;
export function describeReencryption(result: ReencryptionResult): string | null;
export function describeCredentialCounts(counts: ControlNodeCredentialCounts, file?: string): string;
export const lockTestHooks: { writeLock(descriptor: number, text: string): void };
