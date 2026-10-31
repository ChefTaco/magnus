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
