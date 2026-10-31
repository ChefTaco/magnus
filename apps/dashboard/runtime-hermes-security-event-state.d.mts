export function incrementPendingSecurityEvents(delta: number): void;
export function incrementDroppedSecurityEvents(): void;
export function hermesSecurityEventDiagnostics(): { pendingEvents: number; droppedEvents: number; maxPendingEvents: number };
