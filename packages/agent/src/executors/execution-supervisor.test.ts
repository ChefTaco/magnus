import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ExecutionSupervisor, parseSupervisorUnits, type SupervisorBackend, type UnitObservation } from './execution-supervisor.js';
import { ExecutionIntent, hash, requestDigest, SupervisorInput, writeJson } from './execution-supervisor-state.js';
import { COMMAND_COMPLETION_REGISTRY_SHA256 } from '../security/command-completion-registry.js';
class FixtureBackend implements SupervisorBackend {
  starts=0;signals=0;bootId='fixture-boot';unit:UnitObservation|null=null;populated=false;lostAck=false;
  intent?:ExecutionIntent;directory?:string;beforeLaunch?:()=>Promise<void>;
  async probe(){return{bootId:this.bootId};}
  async listUnits(){return this.unit&&this.intent?[this.intent.unit]:[];}
  async launch(intent:ExecutionIntent,directory:string){
    this.starts++;this.intent=intent;this.directory=directory;
    expect(JSON.parse(await readFile(join(directory,'intent.json'),'utf8')).phase).toBe('starting');
    await this.beforeLaunch?.();
    this.unit={LoadState:'loaded',ActiveState:'active',SubState:'exited',InvocationID:'a'.repeat(32),
      Description:'Magnus execution '+intent.nonce+' '+intent.requestSha256+(intent.completionOwner?' '+hash(JSON.stringify(intent.completionOwner)):''),ControlGroup:'',ExecMainCode:'1',ExecMainStatus:'0',Result:'success',KillMode:'control-group',ExitType:'cgroup',RemainAfterExit:'yes',Restart:'no'};
    await writeJson(directory,'started.json',{version:1,nonce:intent.nonce,requestSha256:intent.requestSha256,invocationId:'a'.repeat(32),cgroup:'/fixture/'+intent.unit,startedAt:Date.now()});
    await writeJson(directory,'result.json',{version:1,nonce:intent.nonce,requestSha256:intent.requestSha256,invocationId:'a'.repeat(32),exitCode:0,stdout:'fixture-ok',stderr:'',truncated:false,durationMs:1});
    if(this.lostAck)throw new Error('Start reply lost');
  }
  async inspect(){return this.unit?{...this.unit}:null;}
  async empty(){return !this.populated;}
  async signal(){this.signals++;}
}
let root:string;let backend:FixtureBackend;let supervisor:ExecutionSupervisor;
const input=():SupervisorInput=>({commandId:'fixture-command',command:'/bin/true',args:[],timeoutSeconds:1});
const registeredInput=():SupervisorInput=>({commandId:'registered-command',command:'/usr/bin/uptime',args:[],environment:{},timeoutSeconds:60,
  coordination:{version:1,resourceKey:'node:fixture',fence:'1',expiresAt:Date.now()+60_000}});
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'supervisor-unit-'));backend=new FixtureBackend();supervisor=new ExecutionSupervisor({root,backend,workerDirectory:resolve('dist/executors'),pollMs:10});});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
describe('durable execution supervisor',()=>{
  it('persists intent and immutable worker before effects; exact replay never starts twice',async()=>{
    const request=input();const value=await supervisor.run(request);expect(value.state).toBe('completed');expect(value.result?.stdout).toBe('fixture-ok');
    expect((await supervisor.run(request)).state).toBe('completed');expect(backend.starts).toBe(1);
    await expect(supervisor.run({...request,args:['changed']})).rejects.toThrow('different request');
    expect(JSON.stringify(value.evidence)).not.toContain('/bin/true');
    const dir=join(root,hash(request.commandId));expect(hash(await readFile(join(dir,'execution-supervisor-worker.js')))).toBe(backend.intent?.workerSha256);
  });
  it('binds registered completion authority and terminal cgroup timing into immutable evidence',async()=>{
    const request=registeredInput();const owner={version:1 as const,registrySha256:COMMAND_COMPLETION_REGISTRY_SHA256,descriptorId:'diagnostics-uptime-v1'};
    const value=await supervisor.run(request,owner);expect(value.state).toBe('completed');
    expect(value.evidence).toMatchObject({completionOwner:owner,cgroup:expect.stringContaining(value.evidence.unit),
      startedAt:expect.any(Number),terminalAt:expect.any(Number),groupEmpty:true});
    expect(value.evidence.terminalAt!).toBeGreaterThanOrEqual(value.evidence.startedAt!);
    const directory=join(root,hash(request.commandId));
    expect(JSON.parse(await readFile(join(directory,'intent.json'),'utf8')).completionOwner).toEqual(owner);
    await expect(supervisor.run(request)).rejects.toThrow('completion owner');expect(backend.starts).toBe(1);
    await writeJson(directory,'completed.json',{...value,evidence:{...value.evidence,
      completionOwner:{...owner,registrySha256:'0'.repeat(64)}}});
    expect((await supervisor.status(request.commandId,requestDigest(request))).state).toBe('unknown');
  });
  it('rejects caller-asserted registered authority for arbitrary command bytes before persistence or launch',async()=>{
    const request=input();const owner={version:1 as const,registrySha256:COMMAND_COMPLETION_REGISTRY_SHA256,descriptorId:'diagnostics-uptime-v1'};
    await expect(supervisor.run(request,owner)).rejects.toThrow('exact registered command');
    expect(backend.starts).toBe(0);
    await expect(readFile(join(root,hash(request.commandId),'intent.json'),'utf8')).rejects.toMatchObject({code:'ENOENT'});
  });
  it('adopts the exact completed invocation after lost launch reply and process restart',async()=>{
    backend.lostAck=true;const request=input();expect((await supervisor.run(request)).state).toBe('unknown');
    const restarted=new ExecutionSupervisor({root,backend});expect((await restarted.recover(request)).state).toBe('completed');expect(backend.starts).toBe(1);
  });
  it('does not infer safe replay from a missing or garbage-collected unit',async()=>{
    backend.lostAck=true;const request=input();await supervisor.run(request);backend.unit=null;
    expect((await supervisor.run(request)).state).toBe('unknown');expect((await supervisor.recover(request)).state).toBe('unknown');expect(backend.starts).toBe(1);
  });
  it('rejects replaced invocation and boot identity before completion',async()=>{
    backend.lostAck=true;const request=input();await supervisor.run(request);backend.unit!.InvocationID='b'.repeat(32);
    expect((await supervisor.recover(request)).state).toBe('unknown');backend.unit!.InvocationID='a'.repeat(32);backend.bootId='another-boot';
    expect((await supervisor.recover(request)).state).toBe('unknown');
  });
  it('parent exit and valid output do not settle while a descendant remains',async()=>{
    backend.lostAck=true;const request=input();await supervisor.run(request);backend.populated=true;
    expect((await supervisor.recover(request)).state).toBe('running');backend.populated=false;
    expect((await supervisor.recover(request)).state).toBe('completed');
  });
  it('does not trust cgroup emptiness across invocation replacement',async()=>{
    backend.lostAck=true;const request=input();await supervisor.run(request);
    backend.empty=async()=>{backend.unit!.InvocationID='b'.repeat(32);return true;};expect((await supervisor.recover(request)).state).toBe('unknown');
  });
  it('stop intent and successful signal request do not prove stopped',async()=>{
    backend.lostAck=true;const request=input();await supervisor.run(request);backend.populated=true;backend.unit!.SubState='running';
    backend.signal=async()=>{backend.signals++;throw new Error('signal outcome lost');};
    const stopped=await supervisor.stop(request.commandId,requestDigest(request));expect(stopped.state).toBe('unknown');
    const observed=await supervisor.recover(request);expect(observed.state).toBe('running');expect(observed.evidence.stopRequested).toBe(true);expect(backend.signals).toBe(1);
  });
  it('requires explicit valid process exit evidence after group removal',async()=>{
    backend.lostAck=true;const request=input();await supervisor.run(request);backend.unit!.ExecMainCode='0';backend.unit!.ExecMainStatus='';
    expect((await supervisor.recover(request)).state).toBe('unknown');
    backend.unit!.ExecMainCode='2';backend.unit!.ExecMainStatus='9';backend.unit!.Result='timeout';backend.unit!.SubState='failed';backend.unit!.ActiveState='failed';
    const value=await supervisor.recover(request);expect(value.state).toBe('completed');expect(value.result?.exitCode).toBe(124);expect(value.evidence.groupEmpty).toBe(true);
  });
  it('uses actual signal exit evidence even when systemd classifies TERM as clean success',async()=>{
    backend.lostAck=true;const request=input();await supervisor.run(request);backend.unit!.ExecMainCode='2';backend.unit!.ExecMainStatus='15';
    const value=await supervisor.recover(request);expect(value.state).toBe('completed');expect(value.result?.exitCode).toBe(143);
  });
  it('concurrent recovery publishes one immutable result after group termination',async()=>{
    backend.lostAck=true;const request=input();await supervisor.run(request);backend.unit!.ExecMainCode='2';backend.unit!.ExecMainStatus='9';backend.unit!.Result='timeout';
    const values=await Promise.all([supervisor.recover(request),new ExecutionSupervisor({root,backend}).recover(request)]);
    expect(values[0]).toEqual(values[1]);expect(values[0]!.state).toBe('completed');expect(backend.starts).toBe(1);
  });
  it('drain inventory rejects unknown or replacement units and omits private output',async()=>{
    backend.lostAck=true;const request=input();await supervisor.run(request);backend.populated=true;
    let inventory=await supervisor.inventory();expect(inventory.quiescent).toBe(false);expect(inventory.executions[0]?.state).toBe('running');
    backend.populated=false;inventory=await supervisor.inventory();expect(inventory.quiescent).toBe(true);expect(JSON.stringify(inventory)).not.toContain('fixture-ok');
    backend.unit!.InvocationID='b'.repeat(32);inventory=await supervisor.inventory();expect(inventory.quiescent).toBe(false);expect(inventory.unownedUnits).toEqual([backend.intent!.unit]);
  });
  it('retains dot, instance and escaped namespace units as unowned instead of silently filtering them',async()=>{
    const names=['magnus-exec-unknown.part.service','magnus-exec-template@instance.service','magnus-exec-unknown\\x2dpart.service'];
    backend.listUnits=async()=>parseSupervisorUnits(names.map(name=>name+' loaded active running Unknown owner').join('\n'));
    const inventory=await supervisor.inventory();expect(inventory.quiescent).toBe(false);expect(inventory.unownedUnits).toEqual(names);
    expect(()=>parseSupervisorUnits('unexpected output')).toThrow('could not be parsed');
    expect(()=>parseSupervisorUnits('other.service loaded active running')).toThrow('could not be parsed');
  });
  it('fails closed before launch for unavailable capability, expired deadline and secret environment',async()=>{
    backend.probe=async()=>{throw new Error('unsupported');};await expect(supervisor.run(input())).rejects.toThrow('unsupported');expect(backend.starts).toBe(0);
    await expect(supervisor.run({...input(),environment:{API_SECRET:'private'}})).rejects.toThrow('Unsafe');
    await expect(supervisor.run({...input(),coordination:{version:1,resourceKey:'node:fixture',fence:'1',expiresAt:Date.now()-1}})).rejects.toThrow('expired');
  });
});
