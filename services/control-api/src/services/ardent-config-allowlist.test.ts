import { describe, expect, it } from 'vitest';
import { ARDENT_SERVICE_CONFIG_PATHS } from '@hivemagnus/magnus-contracts';
import { changedConfigPaths, classifyServiceConfigEdit } from './ardent-config-allowlist.js';

const BASE = `profile: lead
providers:
  llamacpp:
    model: local-model  # the default
    api_key_env: LLAMACPP_API_KEY
skills:
  enabled: [a, b]
`;

describe('Ardent configuration allowlist for a linked service', () => {
  it('lists only model, provider limits, skills and the artifact size', () => {
    expect([...ARDENT_SERVICE_CONFIG_PATHS].sort()).toEqual([
      'artifacts.max_bytes', 'execution.backend', 'providers.codex.model', 'providers.llamacpp.context_window_tokens',
      'providers.llamacpp.max_output_tokens', 'providers.llamacpp.model', 'providers.llamacpp.reasoning_effort',
      'providers.llamacpp.request_timeout_seconds', 'skills.enabled',
    ]);
    for (const path of ARDENT_SERVICE_CONFIG_PATHS) expect(path, path).not.toMatch(/_env$|token_env|api_key|base_url|_url$|command|auth_mode|channel|peer|a2a|^api\.|listen|memory|plugin/);
  });

  it('compares values, not comments, order or formatting', () => {
    const reordered = `skills: { enabled: [a, b] }\n# edited\nproviders:\n  llamacpp: { api_key_env: LLAMACPP_API_KEY, model: local-model }\nprofile: lead\n`;
    expect(changedConfigPaths(BASE, reordered)).toEqual([]);
  });

  it('treats an array as one value and a missing map as empty', () => {
    expect(changedConfigPaths(BASE, BASE.replace('[a, b]', '[b, a]'))).toEqual([['skills', 'enabled']]);
    expect(classifyServiceConfigEdit(BASE, `${BASE}artifacts:\n  max_bytes: 4096\n`)).toEqual({ changed: ['artifacts.max_bytes'], forbidden: [] });
    // Removing an allowed value (back to Ardent's default) is a change to that path only.
    expect(classifyServiceConfigEdit(`${BASE}artifacts:\n  max_bytes: 4096\n`, BASE)).toEqual({ changed: ['artifacts.max_bytes'], forbidden: [] });
  });

  it('refuses secrets, a map replaced by a value, a dotted key and a non-map document', () => {
    expect(classifyServiceConfigEdit(BASE, BASE.replace('api_key_env: LLAMACPP_API_KEY', 'api_key_env: OTHER')).forbidden).toEqual(['providers.llamacpp.api_key_env']);
    expect(classifyServiceConfigEdit(BASE, BASE.replace(/skills:\n {2}enabled: \[a, b\]\n/, 'skills: [a]\n')).forbidden).toEqual(['skills']);
    expect(classifyServiceConfigEdit(BASE, `${BASE}"skills.enabled": [c]\n`).forbidden).toEqual(['skills.enabled']);
    expect(classifyServiceConfigEdit(BASE, `${BASE}__proto__:\n  polluted: true\n`).forbidden).toEqual(['__proto__.polluted']);
    expect(classifyServiceConfigEdit(BASE, '- a\n').forbidden).toEqual(['(document)']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('rejects text that is not one valid YAML document', () => {
    expect(() => changedConfigPaths(BASE, `${BASE}profile: other\n`)).toThrow(/not valid YAML/);
    expect(() => changedConfigPaths(BASE, 'a: [\n')).toThrow(/not valid YAML/);
    expect(() => changedConfigPaths('a: [\n', BASE)).toThrow(/current configuration/);
  });
});
