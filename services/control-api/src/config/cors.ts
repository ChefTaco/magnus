export interface CorsConfiguration {
  origin: '*' | string[];
  credentials: boolean;
}

/** Resolve CORS once and reject every production wildcard source. */
export function resolveCorsConfiguration(env: Record<string, string | undefined>): CorsConfiguration {
  const production = env['NODE_ENV'] === 'production';
  const configured = env['CORS_ORIGIN']
    ?? (production
      ? (env['DASHBOARD_ORIGIN'] ?? env['PUBLIC_DASHBOARD_URL'] ?? 'https://magnus')
      : '*');
  const origins = configured.split(',').map((origin) => origin.trim()).filter(Boolean);
  if (production && origins.includes('*')) {
    throw new Error('CORS_ORIGIN cannot contain a wildcard in production');
  }
  if (configured === '*') return { origin: '*', credentials: false };
  return { origin: origins, credentials: true };
}
