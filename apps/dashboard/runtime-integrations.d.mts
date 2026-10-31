export interface IntegrationFlags {
  /** External security console base URL, or null when not configured. */
  securityConsoleUrl: string | null;
  hiveRouter: boolean;
  hiveLogin: boolean;
  hermes: boolean;
}
type Env = Record<string, string | undefined>;
export function normalizeIntegrationUrl(value: string | undefined): string | null;
export function securityConsoleUrl(env?: Env): string | null;
export function hiveRouterAdminUrl(env?: Env): string | null;
export function hiveLoginConfigured(env?: Env): boolean;
export function hermesEnabled(env?: Env): boolean;
export function readIntegrations(env?: Env): IntegrationFlags;
export function describeIntegrations(env?: Env): Array<{ name: string; enabled: boolean; via: string }>;
