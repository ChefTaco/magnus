export interface HermesSecurityEvent { timestamp: string; type: string; correlationId?: string; [key: string]: unknown }
export function hermesSecurityEventPath(env?: Record<string, string | undefined>): string;
export function normalizeHermesSecurityEvent(event: unknown): HermesSecurityEvent | null;
export function recordHermesSecurityEvent(event: Omit<HermesSecurityEvent, 'timestamp'> & { timestamp?: string }, options?: { path?: string; env?: Record<string, string | undefined>; maxPendingEvents?: number }): boolean;
export function flushHermesSecurityEvents(options?: { path?: string; env?: Record<string, string | undefined> }): Promise<void>;
export function hermesSecurityEventDiagnostics(): { pendingEvents: number; droppedEvents: number; maxPendingEvents: number };
export function readHermesSecurityEvents(options?: { path?: string; env?: Record<string, string | undefined>; limit?: number }): HermesSecurityEvent[];
export function summarizeHermesSecurityEvents(events: HermesSecurityEvent[]): { rejectedOrigins: number; invalidSessions: number; blockedDestinations: number; rejectedEndpoints: number; queuePressure: number; backpressure: number; hostKeyMismatches: number; connectionsClosed: number; averageConnectionDurationMs: number };
