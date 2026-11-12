/**
 * Emberpath model routing for the fleet assistant (opt-in).
 *
 * Emberpath serves an OpenAI-compatible API at `<emberpath>/v1` and
 * authenticates with an Emberpath client API key (Bearer). The provider is
 * configured only when MAGNUS_EMBERPATH_URL, MAGNUS_EMBERPATH_API_KEY and
 * MAGNUS_EMBERPATH_MODEL are all set; config/env.ts validates them together.
 */

export interface EmberpathSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface EmberpathEnv {
  MAGNUS_EMBERPATH_URL?: string | undefined;
  MAGNUS_EMBERPATH_API_KEY?: string | undefined;
  MAGNUS_EMBERPATH_MODEL?: string | undefined;
  NODE_ENV?: string | undefined;
}

/** Problems with the Emberpath settings, for config/env.ts; empty when valid or unset. */
export function emberpathConfigurationIssues(env: EmberpathEnv): Array<{ path: string; message: string }> {
  const url = env.MAGNUS_EMBERPATH_URL;
  const apiKey = env.MAGNUS_EMBERPATH_API_KEY;
  const model = env.MAGNUS_EMBERPATH_MODEL;
  if (!url && !apiKey && !model) return [];
  const issues: Array<{ path: string; message: string }> = [];
  if (!url || !apiKey || !model) {
    issues.push({ path: 'MAGNUS_EMBERPATH_URL', message: 'MAGNUS_EMBERPATH_URL, MAGNUS_EMBERPATH_API_KEY and MAGNUS_EMBERPATH_MODEL must be configured together' });
  }
  if (url) {
    let parsed: URL | null = null;
    try { parsed = new URL(url); } catch { /* reported below */ }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      issues.push({ path: 'MAGNUS_EMBERPATH_URL', message: 'MAGNUS_EMBERPATH_URL must be an HTTP(S) URL without credentials, query or fragment' });
    } else if (env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
      issues.push({ path: 'MAGNUS_EMBERPATH_URL', message: 'MAGNUS_EMBERPATH_URL must use HTTPS in production' });
    }
  }
  if (apiKey !== undefined && (apiKey.trim() !== apiKey || apiKey.length === 0 || /\s/.test(apiKey))) {
    issues.push({ path: 'MAGNUS_EMBERPATH_API_KEY', message: 'MAGNUS_EMBERPATH_API_KEY must be a single token without whitespace' });
  }
  if (model !== undefined && (model.trim().length === 0 || model.length > 200)) {
    issues.push({ path: 'MAGNUS_EMBERPATH_MODEL', message: 'MAGNUS_EMBERPATH_MODEL must be a model name of 1 to 200 characters' });
  }
  return issues;
}

/** The Emberpath settings when the provider is fully and validly configured, otherwise null. */
export function emberpathSettings(env: EmberpathEnv = process.env): EmberpathSettings | null {
  const url = env.MAGNUS_EMBERPATH_URL;
  const apiKey = env.MAGNUS_EMBERPATH_API_KEY;
  const model = env.MAGNUS_EMBERPATH_MODEL;
  if (!url || !apiKey || !model) return null;
  if (emberpathConfigurationIssues(env).length > 0) return null;
  return { baseUrl: url.replace(/\/+$/, ''), apiKey, model: model.trim() };
}
