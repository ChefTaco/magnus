import { isIP } from 'node:net';

/** Only an observed listener may replace inventory routing. No endpoint on an
 * older agent, unknown result, hostname, or malformed observation means retain
 * the stored endpoint. This metadata grants no SSH destination authority. */
export function observedDashboardEndpoint(state: {
  dashboardStatus?: unknown; dashboardHost?: unknown; dashboardPort?: unknown;
}): { dashboardHost: string; dashboardPort: number } | Record<string, never> {
  const { dashboardHost, dashboardPort } = state;
  if (state.dashboardStatus !== 'running' || typeof dashboardHost !== 'string'
    || !isIP(dashboardHost) || typeof dashboardPort !== 'number'
    || !Number.isInteger(dashboardPort) || dashboardPort < 1 || dashboardPort > 65535) return {};
  return { dashboardHost, dashboardPort };
}
