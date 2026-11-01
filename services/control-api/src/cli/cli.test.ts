import { describe, expect, it } from 'vitest';
import { parseArgs, UsageError } from './args.js';
import { ENV_CATALOG, buildEnvSchemaDocument, renderEnvTable } from './env-catalog.js';
import { redactUrl } from './preflight.js';

describe('magnus-server argument parsing', () => {
  it('defaults to start and collects repeated env files', () => {
    expect(parseArgs([])).toMatchObject({ command: 'start', envFiles: [], migrate: false });
    expect(parseArgs(['start', '--env-file', 'a.env', '--env-file=b.env', '--migrate']))
      .toMatchObject({ command: 'start', envFiles: ['a.env', 'b.env'], migrate: true });
  });

  it('parses check, migrate, env-schema formats and help flags', () => {
    expect(parseArgs(['check']).command).toBe('check');
    expect(parseArgs(['migrate', '--env-file', 'x']).command).toBe('migrate');
    expect(parseArgs(['env-schema', '--format', 'table'])).toMatchObject({ command: 'env-schema', format: 'table' });
    expect(parseArgs(['check', '--help']).command).toBe('help');
    expect(parseArgs(['-v']).command).toBe('version');
  });

  it('passes upgrade, rollback and agents arguments through untouched', () => {
    expect(parseArgs(['upgrade', '--to', '1.1.0', '--dry-run', '--help'])).toMatchObject({ command: 'upgrade', passthrough: ['--to', '1.1.0', '--dry-run', '--help'] });
    expect(parseArgs(['agents', 'upgrade', '--nodes', 'a,b', '--env-file', 'x.env'])).toMatchObject({ command: 'agents', passthrough: ['upgrade', '--nodes', 'a,b'], envFiles: ['x.env'] });
    expect(parseArgs(['backup', '--label', 'before-test'])).toMatchObject({ command: 'backup', label: 'before-test' });
    expect(parseArgs(['check', '--format', 'json'])).toMatchObject({ command: 'check', format: 'json', formatGiven: true });
  });

  it('rejects unknown commands, options and formats', () => {
    expect(() => parseArgs(['serve'])).toThrow(UsageError);
    expect(() => parseArgs(['--port', '1'])).toThrow(UsageError);
    expect(() => parseArgs(['env-schema', '--format', 'yaml'])).toThrow(UsageError);
    expect(() => parseArgs(['--env-file'])).toThrow(UsageError);
  });
});

describe('documented environment', () => {
  it('lists every required secret exactly once and marks secrets', () => {
    const names = ENV_CATALOG.map(variable => variable.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of ['API_SECRET', 'NODE_MANAGER_SECRET', 'AUDIT_HMAC_SECRET', 'RESULT_SIGNING_SECRET',
      'LOG_INGEST_SIGNING_SECRET', 'CREDENTIAL_ROTATION_KEY', 'METRICS_TOKEN', 'WEBHOOK_ENCRYPTION_KEY']) {
      expect(ENV_CATALOG.find(variable => variable.name === name)).toMatchObject({ required: true, secret: true });
    }
    expect(ENV_CATALOG.find(variable => variable.name === 'SECURITY_FUSION_MODE')?.default).toBe('off');
  });

  it('renders JSON and a table', () => {
    const document = buildEnvSchemaDocument();
    expect(document.variables.length).toBe(ENV_CATALOG.length);
    expect(renderEnvTable().split('\n')[0]).toMatch(/^NAME\s+GROUP\s+REQUIRED\s+DEFAULT$/);
  });

  it('redacts passwords from connection URLs', () => {
    expect(redactUrl('postgresql://magnus:hunter2@db.example.com:5432/magnus')).toBe('postgresql://magnus:***@db.example.com:5432/magnus');
    expect(redactUrl('not a url')).toBe('<invalid URL>');
  });
});

describe('agents subcommand', async () => {
  const { parseAgentsArgs } = await import('./agents.js');
  it('parses upgrade options', () => {
    expect(parseAgentsArgs(['upgrade', '--to=1.1.1', '--nodes', 'node-1, node-2', '--dry-run'])).toEqual({ to: '1.1.1', nodes: ['node-1', 'node-2'], dryRun: true });
    expect(parseAgentsArgs([])).toBe('help');
    expect(() => parseAgentsArgs(['downgrade'])).toThrow(UsageError);
    expect(() => parseAgentsArgs(['upgrade', '--to'])).toThrow(UsageError);
  });
});

describe('project discovery for magnus-server upgrade', async () => {
  const { locateProject } = await import('./upgrade.js');
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  it('finds magnus-project.json above the installed package', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magnus-project-'));
    writeFileSync(join(dir, 'magnus-project.json'), '{}');
    const pkg = join(dir, 'versions', '1.1.0', 'node_modules', '@hivemagnus', 'magnus-server');
    mkdirSync(pkg, { recursive: true });
    expect(locateProject(pkg, {})).toBe(dir);
    expect(locateProject(tmpdir(), { MAGNUS_PROJECT_DIR: dir })).toBe(dir);
    expect(locateProject(join(tmpdir(), 'nowhere'), {})).toBeNull();
  });
});
