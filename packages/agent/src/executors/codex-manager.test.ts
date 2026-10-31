import { describe, expect, it } from 'vitest';
import {
  codexNpmCandidates,
  codexNpmInstallPrefix,
  codexProvenance,
  codexUpdateSupported,
  codexTargetEnvironment,
  codexVersionManagerPaths,
  decodeJwtExpiration,
  isStandaloneCodexInstall,
  isVersionBehind,
  parseCodexVersion,
  parseNpmCodexVersion,
} from './codex-manager.js';

describe('Codex manager helpers', () => {
  it('parses Codex CLI versions', () => {
    expect(parseCodexVersion('codex-cli 0.154.0\n')).toBe('0.154.0');
    expect(parseCodexVersion('0.155.0-beta.1')).toBe('0.155.0-beta.1');
    expect(parseCodexVersion('missing')).toBeNull();
  });

  it('compares numeric version components', () => {
    expect(isVersionBehind('0.153.2', '0.154.0')).toBe(true);
    expect(isVersionBehind('0.154.0', '0.154.0')).toBe(false);
    expect(isVersionBehind('0.155.0', '0.154.0')).toBe(false);
  });

  it('accepts scalar and array npm version responses', () => {
    expect(parseNpmCodexVersion('"0.154.0"')).toBe('0.154.0');
    expect(parseNpmCodexVersion('["0.153.4", "0.154.0"]')).toBe('0.154.0');
    expect(parseNpmCodexVersion('0.154.0\n')).toBe('0.154.0');
  });

  it('recognizes standalone Codex release targets', () => {
    expect(isStandaloneCodexInstall(
      '/home/operator/.codex',
      '/home/operator/.codex/packages/standalone/releases/0.154.0-x86_64-unknown-linux-musl/bin/codex',
    )).toBe(true);
    expect(isStandaloneCodexInstall(
      '/home/operator/.codex',
      '/home/operator/.nvm/versions/node/v24.18.0/bin/codex',
    )).toBe(false);
  });

  it('decodes only the JWT expiration timestamp', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1_800_000_000, secret: 'ignored' })).toString('base64url');
    expect(decodeJwtExpiration(`header.${payload}.signature`)).toBe('2027-01-15T08:00:00.000Z');
    expect(decodeJwtExpiration('invalid')).toBeNull();
  });

  it('discovers newest version-manager installs first', () => {
    expect(codexVersionManagerPaths('/home/operator/.nvm/versions/node', ['v20.18.0', 'v24.18.0']))
      .toEqual([
        '/home/operator/.nvm/versions/node/v24.18.0/bin/codex',
        '/home/operator/.nvm/versions/node/v20.18.0/bin/codex',
      ]);
  });

  it('updates npm-managed Codex in the prefix that owns its bin directory', () => {
    expect(codexNpmInstallPrefix('/usr/local/bin/codex')).toBe('/usr/local');
    expect(codexNpmInstallPrefix('/home/operator/.npm-global/bin/codex')).toBe('/home/operator/.npm-global');
    expect(codexNpmInstallPrefix('/home/operator/.nvm/versions/node/v24.13.0/bin/codex'))
      .toBe('/home/operator/.nvm/versions/node/v24.13.0');
    expect(codexNpmInstallPrefix('/home/operator/.local/share/pnpm/codex')).toBeNull();
  });

  it('classifies every discovered path and refuses non-owned package trees', () => {
    const home = '/home/operator';
    const codexHome = `${home}/.codex`;
    const cases = [
      ['/usr/bin/codex', '/usr/lib/node_modules/@openai/codex/bin/codex.js', 'npm'],
      ['/usr/local/bin/codex', '/usr/local/lib/node_modules/@openai/codex/bin/codex.js', 'npm'],
      [`${home}/.npm-global/bin/codex`, `${home}/.npm-global/lib/node_modules/@openai/codex/bin/codex.js`, 'npm'],
      [`${home}/.local/bin/codex`, `${codexHome}/packages/standalone/releases/v1/bin/codex`, 'standalone'],
      [`${home}/.local/share/pnpm/codex`, `${home}/.local/share/pnpm/codex`, 'pnpm'],
      [`${home}/.volta/bin/codex`, `${home}/.volta/tools/image/packages/codex/bin/codex`, 'volta'],
      [`${home}/.bun/bin/codex`, `${home}/.bun/install/global/node_modules/@openai/codex/bin/codex.js`, 'bun'],
      [`${home}/.asdf/shims/codex`, `${home}/.asdf/installs/nodejs/v24/bin/codex`, 'asdf'],
      [`${home}/.local/share/mise/shims/codex`, `${home}/.local/share/mise/installs/node/v24/bin/codex`, 'mise'],
      [`${home}/.nix-profile/bin/codex`, '/nix/store/example/bin/codex', 'nix'],
      ['/nix/var/nix/profiles/default/bin/codex', '/nix/store/example/bin/codex', 'nix'],
      ['/snap/bin/codex', '/usr/bin/snap', 'snap'],
      [`${home}/.nvm/versions/node/v24/bin/codex`, `${home}/.nvm/versions/node/v24/lib/node_modules/@openai/codex/bin/codex.js`, 'nvm'],
      [`${home}/.local/share/fnm/node-versions/v24/installation/bin/codex`, `${home}/.local/share/fnm/node-versions/v24/installation/lib/node_modules/@openai/codex/bin/codex.js`, 'fnm'],
      [`${home}/.fnm/node-versions/v24/installation/bin/codex`, `${home}/.fnm/node-versions/v24/installation/lib/node_modules/@openai/codex/bin/codex.js`, 'fnm'],
      [`${home}/.asdf/installs/nodejs/v24/bin/codex`, `${home}/.asdf/installs/nodejs/v24/lib/node_modules/@openai/codex/bin/codex.js`, 'asdf'],
      [`${home}/.local/share/mise/installs/node/v24/bin/codex`, `${home}/.local/share/mise/installs/node/v24/lib/node_modules/@openai/codex/bin/codex.js`, 'mise'],
      ['/usr/bin/codex', '/opt/vendor/codex', 'unknown'],
    ] as const;
    for (const [bin, resolved, expected] of cases) {
      expect(codexProvenance(bin, resolved, codexHome), bin).toBe(expected);
      expect(codexUpdateSupported(expected)).toBe(['standalone', 'npm', 'nvm', 'fnm'].includes(expected));
    }
  });

  it('checks the npm sibling of a user-managed Codex before system npm paths', () => {
    expect(codexNpmCandidates('/home/operator/.nvm/versions/node/v24.13.0/bin/codex'))
      .toEqual([
        '/home/operator/.nvm/versions/node/v24.13.0/bin/npm',
        '/usr/bin/npm',
        '/usr/local/bin/npm',
      ]);
    expect(codexNpmCandidates(null)).toEqual(['/usr/bin/npm', '/usr/local/bin/npm']);
  });

  it('lets Codex create a missing default home on first use', () => {
    expect(codexTargetEnvironment('/home/operator', '/home/operator/.codex'))
      .toEqual({ HOME: '/home/operator' });
  });

  it('preserves an explicitly custom Codex home', () => {
    expect(codexTargetEnvironment('/home/operator', '/var/lib/operator-codex'))
      .toEqual({ HOME: '/home/operator', CODEX_HOME: '/var/lib/operator-codex' });
  });
});
