import type { SessionPayload } from './src/lib/auth';
export function createLocalSession(username: string): Promise<string>;
export function verifyLocalSession(session: SessionPayload): Promise<boolean>;
export function revokeLocalSession(session: SessionPayload, all?: boolean): Promise<void>;
