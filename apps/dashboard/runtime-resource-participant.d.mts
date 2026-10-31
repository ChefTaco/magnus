export type ManagedSshKind = 'terminal-http' | 'terminal-ws' | 'hermes-http' | 'hermes-ws';
export interface ManagedSshWork { workId: string; finish(disposition?: 'not-started' | 'remote-ended' | 'unknown', evidenceSha256?: string): Promise<unknown> }
export function canonicalDrainJson(value: unknown): string;
export function createResourceParticipant(options?: { env?: Record<string, string | undefined>; request?: (path: string, body: any) => Promise<any>; ownerId?: string }): { begin(host: string, kind: ManagedSshKind): Promise<ManagedSshWork>; drain(descriptor: any, suppliedKey: string): Promise<any> };
export function beginManagedSshWork(host: string, kind: ManagedSshKind): Promise<ManagedSshWork>;
export function dashboardDrainReceipt(descriptor: unknown, suppliedKey: string): Promise<Record<string, unknown>>;
export function observeManagedSshEnd(work: ManagedSshWork, disposition?: 'not-started' | 'remote-ended' | 'unknown'): void;
