import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildHermesDetectionScript,
  extractHermesJson,
  parseHermesDetectionOutput,
  parseProfileListText,
} from './hermes-cli-parser.js';

describe('hermes-cli-parser', () => {
  it('discovers local skills after a large built-in catalogue without truncating names', () => {
    const home = mkdtempSync(join(tmpdir(), 'magnus-hermes-catalogue-'));
    try {
      writeFileSync(join(home, 'config.yaml'), '{}');
      const bin = join(home, 'hermes');
      writeFileSync(bin, `#!/usr/bin/env python3
import os,sys
if sys.argv[1:] == ['skills','list']:
 for i in range(400): print('│ builtin-%04d │ engineering │ builtin │ builtin │ enabled │' % i)
 name='edge-workflow-codex-entry-designer' if int(os.environ.get('COLUMNS','80')) >= 240 else 'edge-workflow-codex-entr…'
 print('│ '+name+' │ edge-integrations │ local │ local │ enabled │')
elif '--version' in sys.argv: print('Hermes Agent 0.21.3')
else: print('[]')
`, { mode: 0o700 });
      const output = execFileSync('bash', ['-c', buildHermesDetectionScript({ hermesHome: home, hermesBin: bin })], { encoding: 'utf8', timeout: 30000 });
      expect(parseHermesDetectionOutput(output).skills).toContainEqual(expect.objectContaining({ slug: 'edge-workflow-codex-entry-designer', source: 'local', enabled: true }));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('extracts the Magnus JSON envelope from command output', () => {
    const parsed = extractHermesJson('noise\n__MAGNUS_HERMES_JSON_START__\n{"installed":true}\n__MAGNUS_HERMES_JSON_END__\nmore');
    expect(parsed).toEqual({ installed: true });
  });

  it('parses profile list text fallback', () => {
    const profiles = parseProfileListText('* default (default)\n◆research  gpt-5.5  running\nops-agent\n', '/home/operator/.hermes');
    expect(profiles.map((p) => p.name)).toEqual(['default', 'research', 'ops-agent']);
    expect(profiles[0]?.isDefault).toBe(true);
    expect(profiles[1]?.profileHome).toBe('/home/operator/.hermes/profiles/research');
  });

  it('normalizes detection output and profile metadata', () => {
    const detection = parseHermesDetectionOutput(`
__MAGNUS_HERMES_JSON_START__
{
  "installed": true,
  "status": "running",
  "version": "hermes 0.1.0",
  "hermesBin": "/home/operator/.local/bin/hermes",
  "hermesHome": "/home/operator/.hermes",
  "gatewayStatus": "active",
  "dashboardStatus": "inactive",
  "apiServerEnabled": true,
  "apiServerHost": "127.0.0.1",
  "apiServerPort": 8642,
  "profiles": [{"name":"canary","description":"host profile","gatewayStatus":"running","apiServerEnabled":true,"apiServerPort":8642}],
  "skills": [{"slug":"review-code","category":"engineering","source":"local","enabled":true}],
  "toolsets": [{"toolset":"web","enabled":true}],
  "providers": [{"profileName":"canary","provider":"openai","model":"gpt-5.5","configured":true}],
  "plugins": [{"slug":"memory/hivemem","pluginType":"memory","version":"0.1.0","status":"detected","healthState":"unknown"}],
  "messagingBindings": [{"platform":"telegram","channelIds":["home"],"voiceEnabled":false,"secretRef":"env:TELEGRAM_BOT_TOKEN","status":"detected"}]
}
__MAGNUS_HERMES_JSON_END__
`);
    expect(detection.status).toBe('running');
    expect(detection.gatewayStatus).toBe('running');
    expect(detection.dashboardStatus).toBe('inactive');
    expect(detection.profiles[0]?.name).toBe('canary');
    expect(detection.profiles[0]?.apiServerEnabled).toBe(true);
    expect(detection.skills[0]?.slug).toBe('review-code');
    expect(detection.toolsets[0]?.toolset).toBe('web');
    expect(detection.providers[0]?.model).toBe('gpt-5.5');
    expect(detection.plugins[0]?.slug).toBe('memory/hivemem');
    expect(detection.messagingBindings[0]?.platform).toBe('telegram');
  });

  it('accepts snake_case managed profile fields and marks default profile', () => {
    const detection = parseHermesDetectionOutput(`
__MAGNUS_HERMES_JSON_START__
{
  "installed": true,
  "status": "detected",
  "hermesHome": "/home/operator/.hermes",
  "profiles": [{
    "name": "default",
    "profile_home": "/home/operator/.hermes/profiles/default",
    "is_default": true,
    "gateway_status": "active",
    "api_server_enabled": true,
    "api_server_host": "127.0.0.1",
    "api_server_port": 8765,
    "model": "gpt-5.5"
  }]
}
__MAGNUS_HERMES_JSON_END__
`);

    expect(detection.profiles[0]).toMatchObject({
      name: 'default',
      profileHome: '/home/operator/.hermes/profiles/default',
      isDefault: true,
      gatewayStatus: 'running',
      apiServerEnabled: true,
      apiServerPort: 8765,
      modelSummary: 'gpt-5.5',
    });
  });


  it('redacts sensitive command output', async () => {
    const { redactSensitiveText } = await import('./ssh-exec-service.js');
    expect(redactSensitiveText('API_SERVER_KEY=supersecret\nAuthorization: Bearer token123')).toContain('[REDACTED]');
  });
});
