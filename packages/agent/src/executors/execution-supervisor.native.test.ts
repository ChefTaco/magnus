/** Explicit local-user transient-unit fixtures, never production enrollment. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { ExecutionSupervisor, SystemdSupervisorBackend } from './execution-supervisor.js';
import { hash, requestDigest, type SupervisorInput } from './execution-supervisor-state.js';
const exec=promisify(execFile);
const native=process.env['SUPERVISOR_NATIVE_TESTS']==='1'?describe:describe.skip;
let root:string;let backend:SystemdSupervisorBackend;let supervisor:ExecutionSupervisor;let units:string[];
function request(command:string,timeoutSeconds=3):SupervisorInput{const commandId='native-'+randomUUID();units.push('magnus-exec-'+hash(commandId)+'.service');return{commandId,command,args:[],timeoutSeconds};}
native('actual isolated user-systemd execution',()=>{
  beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'magnus-supervisor-native-'));units=[];backend=new SystemdSupervisorBackend(true);await backend.probe();supervisor=new ExecutionSupervisor({root,backend,workerDirectory:resolve('dist/executors')});});
  afterEach(async()=>{for(const unit of units){await exec('/usr/bin/systemctl',['--user','stop',unit],{timeout:5000}).catch(()=>undefined);await exec('/usr/bin/systemctl',['--user','reset-failed',unit],{timeout:3000}).catch(()=>undefined);}await rm(root,{recursive:true,force:true});});
  it('retains exact completion across restart and never interpolates environment into unit arguments',async()=>{
    const input=request('printf "%s" "$FIXTURE_VALUE"; test -z "$API_SECRET"');input.environment={FIXTURE_VALUE:'literal $(do-not-run); "quote"\nvalue'};
    const result=await supervisor.run(input);expect(result.state).toBe('completed');expect(result.result?.exitCode).toBe(0);expect(result.result?.stdout).toBe(input.environment.FIXTURE_VALUE);
    expect(result.evidence.groupEmpty).toBe(true);expect(result.evidence.invocationId).toMatch(/^[a-f0-9]{32}$/);
    expect(await new ExecutionSupervisor({root,backend}).recover(input)).toEqual(result);
  },10000);
  it('does not complete at parent exit while a redirected grandchild lives; runtime kills the whole group',async()=>{
    const input=request("/bin/sh -c 'sleep 20 >/dev/null 2>&1 & printf parent-done'",2);
    const pending=supervisor.run(input);const dir=join(root,hash(input.commandId));
    let ready=false;for(let n=0;n<30;n++){try{await readFile(join(dir,'result.json'));ready=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,50));}}
    expect(ready).toBe(true);expect((await supervisor.status(input.commandId,requestDigest(input))).state).toBe('running');
    const result=await pending;expect(result.state).toBe('completed');expect(result.result?.exitCode).toBe(124);expect(result.evidence.groupEmpty).toBe(true);
  },15000);
  it('adopts the original unit after the requesting OS process crashes',async()=>{
    const input=request('sleep 1; printf crash-recovered',4);
    const module=pathToFileURL(resolve('dist/executors/execution-supervisor.js')).href;
    const code=`import {ExecutionSupervisor,SystemdSupervisorBackend} from ${JSON.stringify(module)}; await new ExecutionSupervisor({root:${JSON.stringify(root)},backend:new SystemdSupervisorBackend(true)}).run(${JSON.stringify(input)});`;
    const processChild=spawn(process.execPath,['--input-type=module','-e',code],{stdio:'ignore'});
    const closed=new Promise(resolve=>processChild.once('close',resolve));
    try{
      let ready=false;for(let n=0;n<40;n++){try{await readFile(join(root,hash(input.commandId),'started.json'));ready=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,25));}}
      expect(ready).toBe(true);processChild.kill('SIGKILL');await closed;
      let value=await supervisor.recover(input);
      for(let n=0;n<60&&value.state!=='completed';n++){await new Promise(resolve=>setTimeout(resolve,50));value=await supervisor.recover(input);}
      expect(value.state).toBe('completed');expect(value.result?.stdout).toBe('crash-recovered');
    }finally{processChild.kill('SIGKILL');await closed;}
  },10000);
  it('explicit stop verifies group death even when descendants ignore TERM',async()=>{
    const input=request("/bin/sh -c 'trap \"\" TERM; sleep 20'",8);
    const pending=supervisor.run(input);
    let ready=false;for(let n=0;n<30;n++){try{await readFile(join(root,hash(input.commandId),'started.json'));ready=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,25));}}
    expect(ready).toBe(true);
    const stopped=await supervisor.stop(input.commandId,requestDigest(input));expect(stopped.state).toBe('completed');expect(stopped.evidence.groupEmpty).toBe(true);expect(stopped.result?.exitCode).not.toBe(0);
    expect((await pending).state).toBe('completed');
  },15000);
  it('bounds output and persists no raw command or environment in public evidence',async()=>{
    const input=request('head -c 2000000 /dev/zero');input.environment={PRIVATE_FIXTURE:'private-value'};
    const result=await supervisor.run(input);expect(result.state).toBe('completed');expect(result.result?.truncated).toBe(true);expect(Buffer.byteLength(result.result!.stdout)).toBeLessThanOrEqual(256*1024);
    expect(JSON.stringify(result.evidence)).not.toContain('private-value');expect(JSON.stringify(result.evidence)).not.toContain('head -c');
    expect((await readFile(join(root,hash(input.commandId),'result.json'))).length).toBeLessThan(4*1024*1024);
  },10000);
});
