import { describe, expect, it } from 'vitest';
import { buildAgentDeployScript } from './deploy-service.js';

describe('buildAgentDeployScript', () => {
  it('recovers masked services and writes real config files before starting the agent', () => {
    const script = buildAgentDeployScript({
      hostname: 'node.example.test',
      password: 'secret',
      username: 'operator',
      controlApiUrl: 'https://magnus:4000',
      nodeManagerSecret: 'fleet-secret',
      nodeManagerPort: 4100,
      deployedAtIso: '2026-03-07T19:00:00.000Z',
      certContent: 'CERTDATA',
      keyContent: 'KEYDATA',
    });

    expect(script).not.toContain('ENABLE_IAM');
    expect(script).toContain('rm -f .npmrc');
    expect(script).not.toContain('_authToken');
    expect(script).not.toContain('@latest');
    expect(script).toContain('npm install /tmp/magnus-agent-local.tgz');
    expect(script).toContain('cat > /opt/magnus-agent/.env << \'ENVEOF\'');
    expect(script).toContain('cat > /opt/magnus-agent/certs/server.crt << \'CERT_EOF\'');
    expect(script).toContain('do_sudo systemctl unmask magnus-agent || true');
    expect(script).toContain('do_sudo rm -f /etc/systemd/system/magnus-agent.service || true');
    expect(script).toContain('/api/v1/ping');
    expect(script).toContain("--resolve 'node.example.test:4100:127.0.0.1'");
    expect(script).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED');
    expect(script).not.toMatch(/curl[^\n]*(?:--insecure|-sk|-k)/);
    expect(script).not.toContain('| do_sudo tee /opt/magnus-agent/.env');
    expect(script).not.toContain('| do_sudo tee /etc/systemd/system/magnus-agent.service');
  });
});
