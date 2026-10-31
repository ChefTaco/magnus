const key = Symbol.for('magnus.hermesSecurityEventState');
const state = globalThis[key] ??= { pendingEvents: 0, droppedEvents: 0, maxPendingEvents: 1_000 };

export function incrementPendingSecurityEvents(delta) {
  state.pendingEvents = Math.max(0, state.pendingEvents + delta);
}

export function incrementDroppedSecurityEvents() {
  state.droppedEvents += 1;
}

export function hermesSecurityEventDiagnostics() {
  return { ...state };
}
