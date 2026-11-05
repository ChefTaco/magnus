import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
test('container health retains configured CA trust and uses the leaf only as an explicit fallback', () => {
  const directory = mkdtempSync(join(tmpdir(), 'magnus-probe-environment-'));
  try {
    const node = join(directory, 'node');
    writeFileSync(node, '#!/bin/sh\nprintf "%s" "${NODE_EXTRA_CA_CERTS:-}"\n'); chmodSync(node, 0o700);
    const command = resolve('services/control-api/docker/entrypoint.sh');
    const env = { PATH: directory + ':/usr/bin:/bin', TLS_CERT_PATH: '/run/config/server.pem', NODE_EXTRA_CA_CERTS: '/run/config/authority.pem' };
    assert.equal(execFileSync('sh', [command, 'healthcheck'], { encoding: 'utf8', env }), '/run/config/authority.pem');
    delete env.NODE_EXTRA_CA_CERTS;
    assert.equal(execFileSync('sh', [command, 'healthcheck'], { encoding: 'utf8', env }), '/run/config/server.pem');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
