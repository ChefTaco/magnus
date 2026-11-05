import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
vi.mock('node:fs/promises',()=>({realpath:async(path:string)=>path,lstat:async(path:string)=>({uid:0,mode:path.endsWith('.env')?0o100600:0o100755,isSymbolicLink:()=>false,isFile:()=>true})}));
vi.mock('node:os',()=>({userInfo:()=>({username:'operator'})}));
import { afterEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { hiveSkillsRoutes,hiveSkillsSyncInput,hiveSkillsTargets,runHiveSkillsSync } from './hiveskills-sync.js';
import { managedExecution } from '../security/managed-context.js';
const manifest={schemaVersion:1 as const,channel:'stable' as const,skills:[]};
const input={target:'fixture-target',registryId:'fixture-registry',publicationSha256:createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),manifest};
afterEach(()=>vi.unstubAllEnvs());
it('forbids root host execution when privileged mode is disabled',async()=>{vi.stubEnv('MAGNUS_AGENT_PRIVILEGED','false');const response=await new Hono().route('/hiveskills',hiveSkillsRoutes).request('/hiveskills/sync',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});expect(response.status).toBe(403);expect(await response.json()).toMatchObject({error:{code:'AGENT_NOT_PRIVILEGED'}})});
it('rejects unmanaged execution and unconfigured targets before launching a process',async()=>{vi.stubEnv('MAGNUS_AGENT_PRIVILEGED','true');vi.stubEnv('MAGNUS_AGENT_HIVESKILLS_TARGETS_JSON','{}');const app=new Hono().route('/hiveskills',hiveSkillsRoutes),invoke=()=>app.request('/hiveskills/sync',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});expect((await invoke()).status).toBe(409);expect((await managedExecution.run({claim:{leaseId:'fixture',nodeId:'fixture',nodeFqdn:'node.example.com'},commandId:'fixture',requestSha256:'a'.repeat(64)},invoke)).status).toBe(409)});
it('rejects caller-selected commands, owner paths and registry mismatches',async()=>{expect(hiveSkillsSyncInput.safeParse({...input,command:'arbitrary'}).success).toBe(false);expect(hiveSkillsTargets.safeParse({'fixture-target':{owner:'admin'}}).success).toBe(false);const spawn=vi.fn();await expect(runHiveSkillsSync(input,{},spawn as never)).rejects.toThrow(/binding/);expect(spawn).not.toHaveBeenCalled()});

it('runs only the configured product client and owner-scoped profile with no inherited credentials',async()=>{
 const targets=hiveSkillsTargets.parse({'fixture-target':{registryId:'fixture-registry',registryTarget:'fixture-native-target',owner:'operator',home:'/opt/operator',hermesHome:'/opt/hermes-profile',envFile:'/opt/skills/target.env',syncScript:'/opt/skills/scripts/hermes-sync.mjs',nodeBinary:'/usr/bin/node'}});
 const child=new EventEmitter(),execute=vi.fn(()=>{queueMicrotask(()=>child.emit('close',0));return child});
 vi.stubEnv('NODE_MANAGER_SECRET','obviously-fake-never-child');
 const code=await managedExecution.run({claim:{leaseId:'fixture',nodeId:'fixture',nodeFqdn:'node.example.com'},commandId:'fixture',requestSha256:'a'.repeat(64),coordination:{version:1,resourceKey:'node:fixture',fence:'1',expiresAt:Date.now()+60000}},()=>runHiveSkillsSync(input,targets,execute as never));
 expect(code).toBe(0);expect(execute).toHaveBeenCalledOnce();const [command,args,options]=execute.mock.calls[0]! as unknown as [string,string[],{env:Record<string,string>;stdio:string;cwd:string}];
 expect(command).toBe(process.geteuid?.()===0?'/usr/sbin/runuser':'/usr/bin/node');expect(args).toContain('--env-file=/opt/skills/target.env');expect(args).toContain('/opt/skills/scripts/hermes-sync.mjs');expect(options.stdio).toBe('ignore');expect(options.env.HIVE_SKILLS_TARGET).toBe('fixture-native-target');expect(options.env.HERMES_HOME).toBe('/opt/hermes-profile');expect(options.env.HIVE_SKILLS_FROZEN_MANIFEST).toBe(JSON.stringify(manifest));expect(options.env).not.toHaveProperty('NODE_MANAGER_SECRET');
});
