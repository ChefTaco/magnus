import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicHermesPaths, HERMES_REVISION } from './build-native-hermes-image.mjs';

test('public Hermes allowlist preserves runtime and attribution while excluding operational and repository state', () => {
  const required=['LICENSE','pyproject.toml','uv.lock','hermes_cli/main.py','run_agent.py'];
  const selected=publicHermesPaths([...required,'agent/core.py','plugins/fixture/plugin.yaml','assets/icon.svg','.env','.npmrc','tests/private-fixture.py','apps/desktop/secret','Dockerfile','profiles/default/config.yaml','.git/config']);
  assert.deepEqual(selected,[...required,'agent/core.py','plugins/fixture/plugin.yaml','assets/icon.svg']);
  assert.equal(HERMES_REVISION.length,40);
  assert.throws(()=>publicHermesPaths([...required,'../escape.py']),/Unsupported/);
  assert.throws(()=>publicHermesPaths([...required,'assets/model.gguf']),/inference/);
  assert.throws(()=>publicHermesPaths(['run_agent.py']),/Incomplete/);
});

test('native Hermes refuses unsafe profile, credential and interpreter selection before invoking Python', () => {
  const scratch=mkdtempSync(join(tmpdir(),'hermes-launcher-test-'));
  try {
    chmodSync(scratch,0o700);
    const profile=join(scratch,'profile'),environment=join(scratch,'native.env');
    mkdirSync(profile,{mode:0o700});writeFileSync(environment,'RETAINED_VALUE=obviously-fake-fixture\n',{mode:0o600});
    copyFileSync(new URL('../tooling/native-hermes/launcher.mjs',import.meta.url),join(scratch,'launcher.mjs'));
    const bin=join(scratch,'python/cpython-3.13.13-linux-x86_64-gnu/bin');mkdirSync(bin,{recursive:true});
    // A small process boundary fixture proves all refusal checks precede exec.
    writeFileSync(join(bin,'python3.13'),'#!/bin/sh\n[ "$HERMES_HOME" = "$EXPECTED_PROFILE" ] || exit 90\n[ "$HERMES_DISABLE_LAZY_INSTALLS" = 1 ] || exit 91\nprintf "native selection accepted\\n"\n',{mode:0o700});
    const env={PATH:process.env.PATH,HOME:scratch,EXPECTED_PROFILE:profile};
    const run=(args=[],extra={})=>execFileSync(process.execPath,[join(scratch,'launcher.mjs'),'--env-file',environment,'--profile-path',profile,...args],{env:{...env,...extra},encoding:'utf8',stdio:['ignore','pipe','pipe']});
    assert.throws(()=>run(['--native-verify-profile']));
    assert.equal(JSON.parse(run(['--native-init-profile'])).initialized,true);
    assert.equal(JSON.parse(run(['--native-verify-profile'])).readOnly,true);
    writeFileSync(join(profile,'sessions','preserved.txt'),'existing native state',{mode:0o600});
    assert.equal(JSON.parse(run(['--native-init-profile'])).initialized,true);
    assert.equal(run(['--native-preflight']).trim(),'native selection accepted');
    assert.throws(()=>run(['--native-preflight'],{HERMES_HOME:join(scratch,'other')}));
    assert.throws(()=>run(['--native-preflight'],{PYTHONPATH:'/opt/unreviewed'}));
    assert.throws(()=>run(['-p','different','--version']));
    assert.throws(()=>run(['-pdifferent','--version']));
    chmodSync(environment,0o644);assert.throws(()=>run(['--native-preflight']));chmodSync(environment,0o600);
    writeFileSync(join(profile,'config.yaml'),'model: synthetic\n',{mode:0o644});assert.throws(()=>run(['--native-preflight']));chmodSync(join(profile,'config.yaml'),0o600);
    symlinkSync(environment,join(profile,'.env'));assert.throws(()=>run(['--native-preflight']));
  } finally {rmSync(scratch,{recursive:true,force:true});}
});
