/** Fixed private systemd worker. No shell interpolation occurs in systemd arguments. */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { ExecutionIntent, SupervisorInput, WorkerResult, hash, MAX_OUTPUT, readJson, requestDigest, writeJson } from './execution-supervisor-state.js';

const root=process.argv[2];
if(!root)throw new Error('Missing private execution directory');
const intent=await readJson<ExecutionIntent>(root,'intent.json');
const payload=await readJson<SupervisorInput>(root,'request.json',256*1024);
const invocationId=process.env['INVOCATION_ID'];
if(!intent||!payload||!invocationId||!/^[a-f0-9]{32}$/.test(invocationId)||intent.phase!=='starting'
  ||intent.requestSha256!==requestDigest(payload)||intent.payloadSha256!==hash(JSON.stringify(payload)))throw new Error('Supervisor worker binding differs');
const memberships=(await readFile('/proc/self/cgroup','utf8')).trim().split('\n');
const cgroup=memberships.find(line=>line.startsWith('0::'))?.slice(3);
if(!cgroup||!cgroup.endsWith('/'+intent.unit)||cgroup.includes('..'))throw new Error('Worker cgroup identity differs');
const startedAt=Date.now();
await writeJson(root,'started.json',{version:1,nonce:intent.nonce,requestSha256:intent.requestSha256,invocationId,cgroup,startedAt});
// Recheck after the durable started receipt, immediately before effects.
if(intent.deadline<=Date.now()||intent.stopRequestedAt){
  await writeJson(root,'result.json',{version:1,nonce:intent.nonce,requestSha256:intent.requestSha256,invocationId,
    exitCode:125,stdout:'',stderr:'Execution deadline expired or stop requested before process start; no command executed',truncated:false,durationMs:Date.now()-startedAt});
}else{
  const output={stdout:[] as Buffer[],stderr:[] as Buffer[]};const size={stdout:0,stderr:0};let truncated=false;
  const append=(which:'stdout'|'stderr',data:Buffer)=>{const left=MAX_OUTPUT-size[which];if(data.length>left)truncated=true;if(left>0){const part=data.subarray(0,left);output[which].push(Buffer.from(part));size[which]+=part.length;}};
  // Never inherit node/API/signing credentials from either agent or user manager.
  const environment={PATH:'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C.UTF-8',...payload.environment};
  // Registry-bound commands use their exact executable and argv. Legacy or
  // unregistered work retains historical shell behavior but cannot acquire a
  // terminal command-completion receipt from the API boundary.
  const child=spawn(payload.command,payload.args,{cwd:payload.workingDirectory??intent.defaultWorkingDirectory,
    env:environment,shell:intent.completionOwner?false:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',(value:Buffer)=>append('stdout',value));child.stderr.on('data',(value:Buffer)=>append('stderr',value));
  let spawnError=false;child.on('error',()=>{spawnError=true;append('stderr',Buffer.from('Command process could not start'));});
  const outcome=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  const exitCode=spawnError?127:outcome.code??(outcome.signal?128+osConstants.signals[outcome.signal]:-1);
  if(exitCode<0)throw new Error('Command exit evidence unavailable');
  const bounded=(which:'stdout'|'stderr')=>{let result=Buffer.concat(output[which]).toString('utf8');while(Buffer.byteLength(result)>MAX_OUTPUT)result=result.slice(0,-1);return result;};
  const result:WorkerResult={version:1,nonce:intent.nonce,requestSha256:intent.requestSha256,invocationId,
    exitCode,stdout:bounded('stdout'),stderr:bounded('stderr'),truncated,durationMs:Date.now()-startedAt};
  await writeJson(root,'result.json',result);
}
