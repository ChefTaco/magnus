import {afterEach,it,expect,vi} from 'vitest';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {securityBackupRouter} from './security-backup.js';
let directory:string|undefined;
afterEach(async()=>{vi.unstubAllEnvs();if(directory)await rm(directory,{recursive:true,force:true});});
it('rejects unauthenticated backup writes before accepting a body',async()=>{
 vi.stubEnv('SECURITY_BACKUP_TOKEN_SHA256',createHash('sha256').update('scoped').digest('hex'));
 const res=await securityBackupRouter.request('/',{method:'POST',body:'unauthorized'});
 expect(res.status).toBe(401);
});
it('publishes only complete digest-verified encrypted uploads',async()=>{
 directory=await mkdtemp(join(tmpdir(),'security-backup-test-'));
 vi.stubEnv('SECURITY_BACKUP_DIRECTORY',directory);
 vi.stubEnv('SECURITY_BACKUP_TOKEN_SHA256',createHash('sha256').update('scoped').digest('hex'));
 const bytes=Buffer.from('AEGIS001'+'ciphertext'.repeat(20));
 const headers={Authorization:'Bearer scoped','x-backup-name':'security-20260917T000000Z.aes','x-backup-sha256':createHash('sha256').update(bytes).digest('hex')};
 expect((await securityBackupRouter.request('/',{method:'POST',headers,body:bytes})).status).toBe(201);
 expect(await readFile(join(directory,headers['x-backup-name']))).toEqual(bytes);
 expect((await securityBackupRouter.request('/',{method:'POST',headers,body:'truncated'})).status).toBe(503);
 expect(await readFile(join(directory,headers['x-backup-name']))).toEqual(bytes);
});
