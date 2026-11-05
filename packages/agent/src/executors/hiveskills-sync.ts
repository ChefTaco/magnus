import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { userInfo } from 'node:os';
import { spawn } from 'node:child_process';
import { Hono } from 'hono';
import { z } from 'zod';
import { HiveSkillsSyncInputSchema } from '@hivemagnus/magnus-contracts';
import { requirePrivileged } from '../privileged.js';
import { managedExecution } from '../security/managed-context.js';

const slug=z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
const path=z.string().refine(value=>isAbsolute(value)&&!/[\r\n\0]/.test(value));
export const hiveSkillsTargets=z.record(slug,z.object({registryId:slug,registryTarget:slug,owner:z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/),home:path,hermesHome:path,envFile:path,syncScript:path,nodeBinary:path,caFile:path.optional()}).strict());
export const hiveSkillsSyncInput=HiveSkillsSyncInputSchema;
/** Executables and parents must be immutable to the managed owner. */
async function trustedProgram(file:string){
 if(await realpath(file)!==file)throw new Error('Configured program must not contain symlinks');
 let current=file;
 for(;;){const info=await lstat(current);if(info.uid!==0||(info.mode&0o022)!==0||info.isSymbolicLink())throw new Error('Configured executable path is writable or not root-owned');if(current===file&&!info.isFile())throw new Error('Configured executable is not a regular file');const parent=dirname(current);if(parent===current)break;current=parent}
}
export async function runHiveSkillsSync(input:z.infer<typeof hiveSkillsSyncInput>,targets:z.infer<typeof hiveSkillsTargets>,execute:typeof spawn=spawn){
 const target=targets[input.target];if(!target||target.registryId!==input.registryId)throw new Error('Exact registry and target binding required');
 if(createHash('sha256').update(JSON.stringify(input.manifest)).digest('hex')!==input.publicationSha256)throw new Error('Publication digest mismatch');
 await trustedProgram(target.nodeBinary);await trustedProgram(target.syncScript);
 const credentials=await lstat(target.envFile);if(!credentials.isFile()||credentials.isSymbolicLink()||(credentials.mode&0o077)!==0||await realpath(target.envFile)!==target.envFile)throw new Error('Protected target credential file required');
 const own=userInfo(),root=process.geteuid?.()===0;
 if(!root&&target.owner!==own.username)throw new Error('Explicit target owner differs from this agent');
 const command=root?'/usr/sbin/runuser':target.nodeBinary;
 const nodeArgs=['--env-file='+target.envFile,target.syncScript];
 const args=root?['-u',target.owner,'--',target.nodeBinary,...nodeArgs]:nodeArgs;
 const context=managedExecution.getStore(),remaining=Math.min(110_000,(context?.coordination?.expiresAt??0)-Date.now());
 if(!context||remaining<=0)throw new Error('Current managed execution ownership required');
 return new Promise<number>((resolve,reject)=>{
  const child=execute(command,args,{stdio:'ignore',cwd:target.home,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:target.home,USER:target.owner,HERMES_HOME:target.hermesHome,HIVE_SKILLS_TARGET:target.registryTarget,HIVE_SKILLS_FROZEN_MANIFEST:JSON.stringify(input.manifest),...(target.caFile?{NODE_EXTRA_CA_CERTS:target.caFile}:{})},detached:true});
  let uncertain=false;
  const stop=()=>{uncertain=true;try{if(child.pid)process.kill(-child.pid,'SIGKILL')}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')reject(new Error('Child termination could not be proven'))}};
  const timer=setTimeout(stop,remaining);context.signal?.addEventListener('abort',stop,{once:true});
  child.once('error',()=>{clearTimeout(timer);context.signal?.removeEventListener('abort',stop);reject(new Error('Configured synchronization process could not start'))});
  child.once('close',code=>{clearTimeout(timer);context.signal?.removeEventListener('abort',stop);if(uncertain||code===null)reject(new Error('Synchronization outcome requires review'));else resolve(code)});
 });
}
export const hiveSkillsRoutes=new Hono();
hiveSkillsRoutes.post('/sync',async c=>{
 const input=hiveSkillsSyncInput.safeParse(await c.req.json().catch(()=>null));if(!input.success)return c.json({success:false,error:{code:'VALIDATION_ERROR',message:'Exact approved publication required'}},400);
 if(!managedExecution.getStore())return c.json({success:false,error:{code:'MANAGED_EXECUTION_REQUIRED'}},409);
 let raw:unknown;try{raw=JSON.parse(process.env['MAGNUS_AGENT_HIVESKILLS_TARGETS_JSON']??'{}')}catch{return c.json({success:false,error:{code:'TARGET_UNCONFIGURED'}},409)}
 const targets=hiveSkillsTargets.safeParse(raw);
 if(!targets.success||!targets.data[input.data.target])return c.json({success:false,error:{code:'TARGET_UNCONFIGURED'}},409);
 const selected=targets.data[input.data.target]!;
 if(process.geteuid?.()===0||selected.owner!==userInfo().username){let allowed=false;const blocked=await requirePrivileged('hiveskills-sync')(c,async()=>{allowed=true});if(!allowed)return blocked instanceof Response?blocked:c.json({success:false,error:{code:'AGENT_NOT_PRIVILEGED'}},403);}
 try{const code=await runHiveSkillsSync(input.data,targets.data);return c.json({success:code===0,data:{publicationSha256:input.data.publicationSha256,exitCode:code}},code===0?200:422)}catch(error){console.warn('Managed Skills synchronization requires review:',error instanceof Error?error.message:'unavailable');return c.json({success:false,error:{code:'OUTCOME_REVIEW_REQUIRED'}},500)}
});
