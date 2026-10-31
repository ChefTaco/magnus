import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtemp, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {appendSecurityEvent, buildSecurityEvent} from './security-events';
afterEach(()=>vi.unstubAllEnvs());
describe('application security audit',()=>{
 it('pseudonymizes accounts and excludes request credentials and untrusted forwarding',()=>{
  vi.stubEnv('SESSION_SECRET','audit-test-key-'.repeat(4));
  const record=buildSecurityEvent('auth.login_failed',new Headers({'cookie':'secret-cookie','authorization':'Bearer secret-token','x-forwarded-for':'203.0.113.8'}),'password=never-log-this');
  expect(record.sourceAddress).toBe('unverified');
  expect(JSON.stringify(record)).not.toMatch(/never-log-this|secret-cookie|secret-token|203\.0\.113\.8/);
  expect(record.accountLabel).toMatch(/^[a-f0-9]{24}$/);
 });
 it('writes complete durable records and refuses symbolic links',async()=>{
  vi.stubEnv('SESSION_SECRET','audit-test-key-'.repeat(4));
  const dir=await mkdtemp(join(tmpdir(),'ui-security-'));
  try {
   const path=join(dir,'events.jsonl');
   await Promise.all(Array.from({length:12},()=>appendSecurityEvent(path,buildSecurityEvent('auth.login_failed',new Headers(),'admin'))));
   const rows=(await readFile(path,'utf8')).trim().split('\n').map(x=>JSON.parse(x));
   expect(rows).toHaveLength(12);expect(new Set(rows.map(x=>x.eventId)).size).toBe(12);
   expect((await stat(path)).mode & 0o077).toBe(0o040);
   const target=join(dir,'protected');await writeFile(target,'unchanged');
   await symlink(target,join(dir,'link'));
   await expect(appendSecurityEvent(join(dir,'link'),rows[0])).rejects.toThrow();
   expect(await readFile(target,'utf8')).toBe('unchanged');
  } finally {await rm(dir,{recursive:true,force:true});}
 });
});
