const pulses = new Map<string, number>();
const expected = { commands: 60_000, webhooks: 60_000, rollouts: 60_000, applications: 180_000, nodes: 90_000 };
export function recordMonitorPulse(name: keyof typeof expected) { pulses.set(name, Date.now()); }
export function monitorsHealthy(now = Date.now()): boolean {
  return Object.entries(expected).every(([name, maxAge]) => {
    const at = pulses.get(name);
    return at !== undefined && now - at <= maxAge;
  });
}
