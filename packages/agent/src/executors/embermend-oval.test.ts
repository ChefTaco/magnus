import { describe, expect, it } from 'vitest';
import { normalizeUbuntuOval } from './embermend-oval.js';
const definitions = `<oval_definitions><generator><timestamp>2026-11-10T00:00:00</timestamp></generator><definitions><definition id="def:1" class="patch"><metadata><title>USN fixture</title><reference source="CVE" ref_id="CVE-2026-12345" ref_url="https://example.com/advisory"/><advisory><severity>High</severity></advisory></metadata><criteria><criterion test_ref="test:1"/></criteria></definition></definitions><tests><dpkginfo_test id="test:1"><state state_ref="state:1"/></dpkginfo_test></tests><states><dpkginfo_state id="state:1"><evr operation="less than">1.0-0ubuntu0.1</evr></dpkginfo_state></states></oval_definitions>`;
const results = (state = 'true') => `<oval_results><results><system><definitions><definition definition_id="def:1" result="${state}"/></definitions><tests><test test_id="test:1" result="true"><tested_item item_id="item:1" result="true"/></test></tests><oval_system_characteristics><system_data><dpkginfo_item id="item:1" status="exists"><name>fixture-package</name><evr>1.0-0ubuntu0</evr><arch>amd64</arch></dpkginfo_item></system_data></oval_system_characteristics></system></results></oval_results>`;
describe('Ubuntu vendor applicability evidence', () => {
  const now = new Date('2026-11-10T01:00:00Z');
  it('joins OpenSCAP decisions without recomputing Debian versions', () => {
    const result = normalizeUbuntuOval(definitions, results(), now);
    expect(result.coverage).toBe('complete');
    expect(result.advisories[0]?.packages[0]).toEqual({ name: 'fixture-package', installedVersion: '1.0-0ubuntu0', fixedVersions: ['1.0-0ubuntu0.1'], architecture: 'amd64' });
    expect(result.advisories[0]?.cves).toEqual(['CVE-2026-12345']);
  });
  it('preserves vendor negative decisions and unknown evaluation separately', () => {
    expect(normalizeUbuntuOval(definitions, results('false'), now).advisories).toHaveLength(0);
    expect(normalizeUbuntuOval(definitions, results('unknown'), now).coverage).toBe('partial');
    expect(normalizeUbuntuOval(definitions, results(), new Date('2026-11-15T00:00:00Z')).coverage).toBe('stale');
  });
  it('refuses external entities and cannot infer package proof from a title', () => {
    expect(() => normalizeUbuntuOval('<!DOCTYPE x>' + definitions, results(), now)).toThrow(/XML/);
    expect(normalizeUbuntuOval(definitions, results().replace('result="true"/></test>', 'result="false"/></test>'), now).coverage).toBe('partial');
  });
});
