/**
 * Terminal audit: metadata only. The event type has no field that could hold terminal input or
 * output, and session code never passes either here.
 */
import type { AuditEvent, ControlApi } from './control-api.js';

export interface Auditor {
  /** Durable before returning. A failure here refuses the session it would have recorded. */
  required(event: AuditEvent): Promise<void>;
  /** Written locally at once and sent on; losing the send is reported, not fatal. */
  bestEffort(event: AuditEvent): Promise<void>;
}

export function createAuditor(api: Pick<ControlApi, 'audit'>, write: (line: string) => void = (line) => console.log(line)): Auditor {
  const local = (event: AuditEvent) => write(JSON.stringify({ type: 'audit', ...event }));
  return {
    async required(event) {
      local(event);
      await api.audit(event);
    },
    async bestEffort(event) {
      local(event);
      try {
        await api.audit(event);
      } catch {
        console.error(JSON.stringify({ type: 'audit-delivery-failed', action: event.action, sessionId: event.sessionId }));
      }
    },
  };
}

const REFUSALS_PER_MINUTE = 30;
const MAX_TRACKED_SUBJECTS = 5_000;

/**
 * Records refusals of verified tokens. Bounded per subject, so a low-privilege person who keeps
 * trying cannot flood the audit log through it.
 */
export function createRefusalAuditor(auditor: Auditor, now: () => number = () => Date.now()) {
  const windows = new Map<string, { startedAt: number; count: number }>();
  return (event: { subject: string; actorId: string; nodeId: string | null; outcome: string; ipAddress: string | null; fingerprint: string | null }): void => {
    const at = now();
    let window = windows.get(event.subject);
    if (!window || at - window.startedAt >= 60_000) {
      if (windows.size >= MAX_TRACKED_SUBJECTS) windows.clear();
      window = { startedAt: at, count: 0 };
      windows.set(event.subject, window);
    }
    window.count += 1;
    if (window.count > REFUSALS_PER_MINUTE) return;
    void auditor.bestEffort({ ...event, action: 'terminal.session.refuse', sessionId: null, at: new Date(at).toISOString(), durationMs: null });
  };
}
