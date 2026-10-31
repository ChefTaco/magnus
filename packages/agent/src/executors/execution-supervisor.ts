/** Durable systemd execution. Missing evidence retains ownership; never replay a start. */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { open, readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExecutionIntent, SupervisorInput, WorkerStarted, WorkerResult, hash, privateDirectory, readJson, requestDigest, syncDirectory, writeJson, MAX_OUTPUT } from './execution-supervisor-state.js';
import { COMMAND_COMPLETION_REGISTRY, COMMAND_COMPLETION_REGISTRY_SHA256, commandCompletionDescriptor } from '../security/command-completion-registry.js';
export type { SupervisorInput } from './execution-supervisor-state.js';
const exec=promisify(execFile);
const UNIT_FIELDS=['LoadState','ActiveState','SubState','InvocationID','Description','ControlGroup','ExecMainCode','ExecMainStatus','Result','KillMode','ExitType','RemainAfterExit','Restart'];
function unitDescription(intent:ExecutionIntent):string{return 'Magnus execution '+intent.nonce+' '+intent.requestSha256
  +(intent.completionOwner?' '+hash(JSON.stringify(intent.completionOwner)):'');}
export interface UnitObservation { [property:string]:string }
/** Preserve every matching namespace unit; unexpected output is not absence. */
export function parseSupervisorUnits(raw:string):string[]{
  return raw.split('\n').map(line=>line.trim()).filter(Boolean).map(line=>{
    const fields=line.split(/\s+/);const unit=fields[0];
    if(fields.length<4||!unit?.startsWith('magnus-exec-')||!unit.endsWith('.service')||/[\x00-\x1f\x7f]/.test(unit))
      throw new Error('Supervisor unit inventory could not be parsed');
    return unit;
  });
}
export interface SupervisorBackend {
  probe():Promise<{bootId:string}>;
  listUnits():Promise<string[]>;
  launch(intent:ExecutionIntent,directory:string):Promise<void>;
  inspect(unit:string):Promise<UnitObservation|null>;
  empty(cgroup:string):Promise<boolean>;
  signal(unit:string,signal:'SIGTERM'|'SIGKILL'):Promise<void>;
}
export interface SupervisorEvidence {
  version:1;commandId:string;requestSha256:string;unit:string;bootId:string;deadline:number;
  invocationId?:string;groupEmpty?:boolean;supervisorResult?:string;stopRequested?:boolean;
  completionOwner?: { version:1; registrySha256:string; descriptorId:string };
  cgroup?:string;startedAt?:number;terminalAt?:number;
}
export interface SupervisorStatus {
  state:'starting'|'running'|'completed'|'unknown';evidence:SupervisorEvidence;
  result?:{exitCode:number;stdout:string;stderr:string;durationMs:number;truncated:boolean};
}
export class SupervisorUnavailableError extends Error { constructor(){super('Systemd execution supervisor unavailable; no new execution admitted');} }
export class SystemdSupervisorBackend implements SupervisorBackend {
  // User manager is for explicit isolated local fixtures; production uses system manager.
  constructor(readonly userFixture=false){}
  private async command(binary:string,args:string[]):Promise<string>{
    const value=await exec(binary,[...(this.userFixture?['--user']:[]),...args],{timeout:8000,maxBuffer:256*1024,env:{PATH:'/usr/bin:/bin',LANG:'C',...(this.userFixture?{XDG_RUNTIME_DIR:process.env['XDG_RUNTIME_DIR']??`/run/user/${process.getuid?.()}`}: {})}});
    return value.stdout;
  }
  async probe():Promise<{bootId:string}>{
    if(process.platform!=='linux'||(!this.userFixture&&process.getuid?.()!==0))throw new SupervisorUnavailableError();
    const version=await exec('/usr/bin/systemd-run',['--version'],{timeout:3000,maxBuffer:4096});
    if(Number(/^systemd (\d+)/.exec(version.stdout)?.[1])<250||!/^systemd \d+/.test(version.stdout))throw new SupervisorUnavailableError();
    await readFile('/sys/fs/cgroup/cgroup.controllers','utf8');
    await this.command('/usr/bin/systemctl',['show','--property=Version']);
    const bootId=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
    if(!/^[a-f0-9-]{36}$/.test(bootId))throw new SupervisorUnavailableError();return{bootId};
  }
  async launch(intent:ExecutionIntent,directory:string):Promise<void>{
    const remaining=intent.deadline-Date.now();if(remaining<=0)throw new SupervisorUnavailableError();
    // All properties and executable paths are fixed; only bounded identifiers and
    // finite numeric runtime vary. Request bytes never enter a unit/CLI property.
    await this.command('/usr/bin/systemd-run',[
      '--quiet','--unit='+intent.unit,'--property=Type=exec','--property=ExitType=cgroup',
      '--property=RemainAfterExit=yes','--property=Restart=no','--property=KillMode=control-group',
      '--property=SendSIGKILL=yes','--property=TimeoutStopSec=2s','--property=RuntimeMaxSec='+remaining+'ms',
      '--property=Description='+unitDescription(intent),
      '--property=StandardInput=null','--property=StandardOutput=null','--property=StandardError=null',
      '--property=NoNewPrivileges=yes','--property=UMask=0077',
      '--property=UnsetEnvironment=NODE_OPTIONS NODE_PATH NODE_MANAGER_SECRET API_SECRET RESULT_SIGNING_SECRET COMMAND_RECONCILIATION_SECRET',
      '--','/usr/bin/node',join(directory,'execution-supervisor-worker.js'),directory,
    ]);
  }
  async listUnits():Promise<string[]>{
    const raw=await this.command('/usr/bin/systemctl',['list-units','--all','--plain','--no-legend','--no-pager','magnus-exec-*.service']);
    return parseSupervisorUnits(raw);
  }
  async inspect(unit:string):Promise<UnitObservation|null>{
    const raw=await this.command('/usr/bin/systemctl',['show',unit,...UNIT_FIELDS.map(p=>'--property='+p)]);
    const value=Object.fromEntries(raw.trim().split('\n').map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));
    return value['LoadState']==='not-found'?null:value;
  }
  async empty(cgroup:string):Promise<boolean>{
    if(!cgroup.startsWith('/')||cgroup.includes('..')||!/^\/[a-zA-Z0-9_/.@:\\-]+$/.test(cgroup))throw new Error('Invalid execution cgroup');
    try{return /(?:^|\n)populated 0(?:\n|$)/.test(await readFile('/sys/fs/cgroup'+cgroup+'/cgroup.events','utf8'));}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return true;throw error;}
  }
  async signal(unit:string,signal:'SIGTERM'|'SIGKILL'):Promise<void>{await this.command('/usr/bin/systemctl',['kill','--kill-whom=all','--signal='+signal,unit]);}
}

export class ExecutionSupervisor {
  readonly root:string;readonly backend:SupervisorBackend;readonly workerDirectory:string;
  constructor(options:{root?:string;backend?:SupervisorBackend;workerDirectory?:string;pollMs?:number}={}){
    this.root=resolve(options.root??join(process.env['AGENT_INSTALL_DIR']??process.cwd(),'.magnus/execution-supervisor'));
    if(/[\x00-\x1f\x7f%$\\]/.test(this.root))throw new Error('Supervisor path contains executable expansion syntax');
    this.backend=options.backend??new SystemdSupervisorBackend();this.workerDirectory=options.workerDirectory??dirname(fileURLToPath(import.meta.url));
    this.pollMs=options.pollMs??100;if(!Number.isInteger(this.pollMs)||this.pollMs<10||this.pollMs>1000)throw new Error('Invalid supervisor polling interval');
  }
  private readonly pollMs:number;
  private directory(commandId:string):string{
    if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(commandId))throw new Error('Invalid command ID');
    return join(this.root,hash(commandId));
  }
  private evidence(intent:ExecutionIntent):SupervisorEvidence{return{version:1,commandId:intent.commandId,requestSha256:intent.requestSha256,unit:intent.unit,bootId:intent.bootId,deadline:intent.deadline,...(intent.stopRequestedAt?{stopRequested:true}:{}),...(intent.completionOwner?{completionOwner:intent.completionOwner}:{})};}
  private async lock(directory:string,name='execution.flock',wait=false){
    await privateDirectory(this.root);await privateDirectory(directory);
    const file=await open(join(directory,name),constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
    try{
      const st=await file.stat();if(!st.isFile()||st.nlink!==1||st.mode&0o077)throw new Error('Invalid supervisor mutex');
      const code=await new Promise<number|null>((resolve,reject)=>{const child=spawn('/usr/bin/flock',['--exclusive',...(wait?['--wait','2']:['--nonblock']),'3'],{stdio:['ignore','ignore','ignore',file.fd]});child.once('error',reject);child.once('exit',resolve);});
      if(code!==0)throw new Error('Execution supervisor operation busy');return file;
    }catch(error){await file.close();throw error;}
  }
  private validate(input:SupervisorInput):void{
    this.directory(input.commandId);
    if(typeof input.command!=='string'||!input.command||input.command.includes('\0')||!Array.isArray(input.args)||input.args.some(v=>typeof v!=='string'||v.includes('\0'))
      ||!Number.isInteger(input.timeoutSeconds)||input.timeoutSeconds<1||input.timeoutSeconds>3600||Buffer.byteLength(JSON.stringify(input))>128*1024)throw new Error('Invalid finite execution');
    if(input.workingDirectory!==undefined&&(!input.workingDirectory.startsWith('/')||input.workingDirectory.includes('\0')))throw new Error('Absolute execution directory required');
    for(const[key,value]of Object.entries(input.environment??{})){
      if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)||typeof value!=='string'||value.includes('\0')||/^(NODE_MANAGER_SECRET|API_SECRET|RESULT_SIGNING_SECRET|COMMAND_RECONCILIATION_SECRET)(_|$)/.test(key))throw new Error('Unsafe command environment');
    }
    if(input.coordination&&(!Number.isSafeInteger(input.coordination.expiresAt)||input.coordination.expiresAt<=Date.now()))throw new Error('Execution deadline expired');
  }
  async run(raw:SupervisorInput, completionOwner?: { version:1; registrySha256:string; descriptorId:string }):Promise<SupervisorStatus>{
    const input=structuredClone(raw);const directory=this.directory(input.commandId);const requestSha256=requestDigest(input);
    if(completionOwner){
      // The supervisor derives completion authority from the exact bytes it
      // will persist and execute; a caller cannot attach a valid registry ID to
      // an arbitrary command and thereby obtain terminal evidence.
      this.validate(input);const descriptor=commandCompletionDescriptor(input);
      if(!descriptor||completionOwner.version!==COMMAND_COMPLETION_REGISTRY.version
        ||completionOwner.registrySha256!==COMMAND_COMPLETION_REGISTRY_SHA256
        ||completionOwner.descriptorId!==descriptor.id)throw new Error('Completion owner does not match exact registered command');
    }
    const mutex=await this.lock(directory);let intent:ExecutionIntent;
    try{
      const prior=await readJson<ExecutionIntent>(directory,'intent.json');
      if(prior){if(prior.requestSha256!==requestSha256||JSON.stringify(prior.completionOwner??null)!==JSON.stringify(completionOwner??null))throw new Error('Execution ID reused with different request or completion owner');intent=prior;}
      else{
        this.validate(input);const capability=await this.backend.probe();
        const worker=await readFile(join(this.workerDirectory,'execution-supervisor-worker.js'));
        const state=await readFile(join(this.workerDirectory,'execution-supervisor-state.js'));
        const preparedAt=Date.now();intent={version:1,commandId:input.commandId,requestSha256,unit:'magnus-exec-'+hash(input.commandId)+'.service',
          nonce:randomUUID(),bootId:capability.bootId,preparedAt,deadline:Math.min(preparedAt+input.timeoutSeconds*1000,input.coordination?.expiresAt??Infinity),phase:'prepared',
          defaultWorkingDirectory:process.cwd(),payloadSha256:hash(JSON.stringify(input)),workerSha256:hash(worker),stateSha256:hash(state),...(completionOwner?{completionOwner}:{})};
        await writeJson(directory,'intent.json',intent);await writeJson(directory,'request.json',input);
        for(const[name,data]of [['execution-supervisor-worker.js',worker],['execution-supervisor-state.js',state],['package.json',Buffer.from('{"type":"module"}')]] as const){
          const fd=await open(join(directory,name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o500);
          try{await fd.writeFile(data);await fd.sync();}finally{await fd.close();}
        }
        await syncDirectory(directory);intent={...intent,phase:'starting'};await writeJson(directory,'intent.json',intent);
        try{await this.backend.launch(intent,directory);}catch{return{state:'unknown',evidence:this.evidence(intent)};}
      }
    }finally{await mutex.close();}
    // A restart/repeated request can observe the original, never launch it again.
    for(;;){const value=await this.status(input.commandId,requestSha256);if(value.state==='completed'||value.state==='unknown'||Date.now()>intent.deadline+10_000)return value;
      await new Promise(resolve=>setTimeout(resolve,this.pollMs));}
  }
  async recover(input:SupervisorInput):Promise<SupervisorStatus>{return this.status(input.commandId,requestDigest(input));}
  async status(commandId:string,requestSha256:string):Promise<SupervisorStatus>{
    // Serialize observation and immutable terminal publication across processes.
    // Readers never adopt a completion before the writer fsyncs its directory.
    const mutex=await this.lock(this.directory(commandId),'status.flock',true);
    try{return await this.observe(commandId,requestSha256);}finally{await mutex.close();}
  }
  private async observe(commandId:string,requestSha256:string):Promise<SupervisorStatus>{
    const directory=this.directory(commandId);const intent=await readJson<ExecutionIntent>(directory,'intent.json');
    if(!intent||intent.commandId!==commandId||intent.requestSha256!==requestSha256||intent.version!==1||intent.unit!=='magnus-exec-'+hash(commandId)+'.service')throw new Error('Original supervisor identity unavailable');
    const evidence=this.evidence(intent);const unknown:SupervisorStatus={state:'unknown',evidence};
    try{
      const finished=await readJson<SupervisorStatus>(directory,'completed.json');
      if(finished){
        const result=finished.result;const proof=finished.evidence;
        const completionStarted=await readJson<WorkerStarted>(directory,'started.json');
        if(finished.state!=='completed'||proof.version!==1||proof.requestSha256!==requestSha256||proof.commandId!==commandId
          ||proof.unit!==intent.unit||proof.bootId!==intent.bootId||proof.deadline!==intent.deadline||proof.groupEmpty!==true
          ||JSON.stringify(proof.completionOwner??null)!==JSON.stringify(intent.completionOwner??null)
          ||!/^[a-f0-9]{32}$/.test(proof.invocationId??'')||!result||!Number.isInteger(result.exitCode)||result.exitCode<0||result.exitCode>255
          ||!completionStarted||completionStarted.version!==1||completionStarted.nonce!==intent.nonce
          ||completionStarted.requestSha256!==requestSha256||proof.invocationId!==completionStarted.invocationId
          ||proof.cgroup!==completionStarted.cgroup||proof.startedAt!==completionStarted.startedAt
          ||!Number.isSafeInteger(completionStarted.startedAt)||completionStarted.startedAt<intent.preparedAt
          ||!Number.isSafeInteger(proof.terminalAt)||(proof.terminalAt??-1)<completionStarted.startedAt||(proof.terminalAt??Infinity)>Date.now()
          ||!proof.cgroup?.endsWith('/'+intent.unit)||proof.cgroup.includes('..')
          ||typeof result.stdout!=='string'||typeof result.stderr!=='string'||Buffer.byteLength(result.stdout)>MAX_OUTPUT||Buffer.byteLength(result.stderr)>MAX_OUTPUT
          ||!Number.isSafeInteger(result.durationMs)||result.durationMs<0||typeof result.truncated!=='boolean')throw new Error('Completion binding differs');
        return finished;
      }
      if(intent.phase!=='starting')return unknown;
      const capability=await this.backend.probe();if(capability.bootId!==intent.bootId)return unknown;
      const unit=await this.backend.inspect(intent.unit);if(!unit)return unknown;
      if(unit['Description']!==unitDescription(intent)||unit['KillMode']!=='control-group'||unit['ExitType']!=='cgroup'||unit['RemainAfterExit']!=='yes'||unit['Restart']!=='no')return unknown;
      const started=await readJson<WorkerStarted>(directory,'started.json');
      if(!started)return Date.now()<intent.deadline&&['activating','active'].includes(unit['ActiveState']??'')?{state:'starting',evidence}:unknown;
      if(started.version!==1||started.nonce!==intent.nonce||started.requestSha256!==requestSha256||!/^[a-f0-9]{32}$/.test(started.invocationId)
        ||started.invocationId!==unit['InvocationID']||!Number.isSafeInteger(started.startedAt)||started.startedAt<intent.preparedAt||!started.cgroup.endsWith('/'+intent.unit)
        ||(unit['ControlGroup']&&unit['ControlGroup']!==started.cgroup))return unknown;
      evidence.invocationId=started.invocationId;
      if(unit['SubState']==='running'||unit['ActiveState']==='activating'||unit['ActiveState']==='deactivating')return{state:'running',evidence};
      if(!['exited','dead','failed'].includes(unit['SubState']??'')||!await this.backend.empty(started.cgroup))return{state:'running',evidence};
      // Re-read after cgroup inspection: a replaced invocation cannot supply proof.
      const after=await this.backend.inspect(intent.unit);
      if(!after||UNIT_FIELDS.some(key=>after[key]!==unit[key]))return unknown;
      evidence.groupEmpty=true;evidence.supervisorResult=unit['Result'];evidence.cgroup=started.cgroup;
      evidence.startedAt=started.startedAt;evidence.terminalAt=Date.now();
      if(!/^[0-9]+$/.test(unit['ExecMainCode']??'')||!/^[0-9]+$/.test(unit['ExecMainStatus']??''))return unknown;
      const exitKind=Number(unit['ExecMainCode']);const exitStatus=Number(unit['ExecMainStatus']);
      if(![1,2,3].includes(exitKind)||!Number.isInteger(exitStatus)||exitStatus<0||exitStatus>255)return unknown;
      const worker=await readJson<WorkerResult>(directory,'result.json');let result:SupervisorStatus['result'];
      if(exitKind===1&&exitStatus===0&&['success','timeout'].includes(unit['Result']??'')&&worker){
        if(worker.nonce!==intent.nonce||worker.requestSha256!==requestSha256||worker.invocationId!==started.invocationId||worker.version!==1
          ||!Number.isInteger(worker.exitCode)||worker.exitCode<0||worker.exitCode>255||typeof worker.stdout!=='string'||typeof worker.stderr!=='string'
          ||Buffer.byteLength(worker.stdout)>MAX_OUTPUT||Buffer.byteLength(worker.stderr)>MAX_OUTPUT||!Number.isSafeInteger(worker.durationMs)||worker.durationMs<0||typeof worker.truncated!=='boolean')return unknown;
        result={exitCode:unit['Result']==='timeout'?124:intent.stopRequestedAt?143:worker.exitCode,stdout:worker.stdout,stderr:worker.stderr,truncated:worker.truncated,durationMs:worker.durationMs};
      }else if([2,3].includes(exitKind)&&exitStatus>0&&exitStatus<=64&&['timeout','signal','core-dump','success'].includes(unit['Result']??'')){
        result={exitCode:unit['Result']==='timeout'?124:128+exitStatus,stdout:'',stderr:'Supervisor verified execution group termination; output before termination is unavailable',truncated:true,durationMs:Math.max(0,Date.now()-started.startedAt)};
      }else return unknown;
      const completed:SupervisorStatus={state:'completed',evidence,result};await writeJson(directory,'completed.json',completed);return completed;
    }catch{return unknown;}
  }
  async inventory():Promise<{supported:boolean;quiescent:boolean;executions:Array<{state:SupervisorStatus['state'];evidence:SupervisorEvidence}>;unownedUnits:string[];issues:string[]}>{
    const value:{supported:boolean;quiescent:boolean;executions:Array<{state:SupervisorStatus['state'];evidence:SupervisorEvidence}>;unownedUnits:string[];issues:string[]}={supported:false,quiescent:false,executions:[],unownedUnits:[],issues:[]};
    try{
      await this.backend.probe();value.supported=true;const units=new Set(await this.backend.listUnits());
      await privateDirectory(this.root);const directories=await readdir(this.root,{withFileTypes:true});
      if(directories.length>256){value.issues.push('SUPERVISOR_INVENTORY_LIMIT');return value;}
      const finishBy=Date.now()+10_000;
      for(const directory of directories){
        if(Date.now()>finishBy){value.issues.push('SUPERVISOR_INVENTORY_TIMEOUT');return value;}
        if(!directory.isDirectory()||! /^[a-f0-9]{64}$/.test(directory.name)){value.issues.push('INVALID_SUPERVISOR_OWNER');continue;}
        const intent=await readJson<ExecutionIntent>(join(this.root,directory.name),'intent.json');
        if(!intent||hash(intent.commandId)!==directory.name){value.issues.push('MISSING_SUPERVISOR_OWNER');continue;}
        const observed=await this.status(intent.commandId,intent.requestSha256);
        value.executions.push({state:observed.state,evidence:observed.evidence});
        // Persisted completed history remains valid after GC, but a currently
        // loaded replacement unit must never disappear from the drain inventory.
        if(units.has(intent.unit)){
          const current=await this.backend.inspect(intent.unit);
          if(current?.InvocationID===observed.evidence.invocationId&&current?.Description===unitDescription(intent)
            &&(observed.state!=='completed'||['exited','dead','failed'].includes(current?.SubState??'')))units.delete(intent.unit);
        }
      }
      value.unownedUnits=[...units];value.quiescent=value.issues.length===0&&!value.unownedUnits.length&&value.executions.every(e=>e.state==='completed');
    }catch{value.issues.push('SUPERVISOR_INVENTORY_UNAVAILABLE');}
    return value;
  }
  async stop(commandId:string,requestSha256:string):Promise<SupervisorStatus>{
    const directory=this.directory(commandId);const mutex=await this.lock(directory);
    try{const intent=await readJson<ExecutionIntent>(directory,'intent.json');if(!intent||intent.requestSha256!==requestSha256)throw new Error('Execution stop binding differs');
      const before=await this.status(commandId,requestSha256);if(before.state==='completed'||before.state==='unknown')return before;
      await writeJson(directory,'intent.json',{...intent,stopRequestedAt:intent.stopRequestedAt??Date.now()});
      // Kill targets the existing unit, never starts one. A returned signal request
      // is not stop evidence; status independently proves group/exit completion.
      try{await this.backend.signal(intent.unit,'SIGTERM');}catch{return{state:'unknown',evidence:this.evidence(intent)};}
    }finally{await mutex.close();}
    const escalationAt=Date.now()+2000;const finishBy=escalationAt+3000;let escalated=false;
    for(;;){
      const value=await this.status(commandId,requestSha256);
      if(value.state==='completed'||value.state==='unknown'||Date.now()>=finishBy)return value;
      if(!escalated&&Date.now()>=escalationAt){
        if(!value.evidence.invocationId)return{state:'unknown',evidence:value.evidence};
        try{await this.backend.signal(value.evidence.unit,'SIGKILL');}catch{return{state:'unknown',evidence:value.evidence};}
        escalated=true;
      }
      await new Promise(resolve=>setTimeout(resolve,this.pollMs));
    }
  }
}
