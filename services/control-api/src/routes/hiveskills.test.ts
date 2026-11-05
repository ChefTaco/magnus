import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
const mocks=vi.hoisted(()=>({db:{node:{findUnique:vi.fn()},remoteCommand:{findUnique:vi.fn()},commandResourceLease:{findUnique:vi.fn(),count:vi.fn()},resourceEnrollment:{findUnique:vi.fn()}},posture:vi.fn(),sync:vi.fn(),receipt:vi.fn(),audit:vi.fn()}));
vi.mock('../db/index.js',()=>({getDb:()=>mocks.db}));
vi.mock('../sdk/node-api-client.js',()=>({NodeApiClient:class{hiveSkillsTargetPosture=mocks.posture;syncHiveSkills=mocks.sync;getCommandReceipt=mocks.receipt}}));
vi.mock('../services/audit-service.js',()=>({logAuditEvent:mocks.audit}));
vi.mock('../utils/env.js',()=>({getNodeManagerSecret:()=> 'obviously-fake-node-secret'}));
const {hiveskillsRouter}=await import('./hiveskills.js');
const app=new Hono().route('/hiveskills',hiveskillsRouter).onError((e,c)=>c.json({error:e.message},'status' in e?Number(e.status) as 400:500));
const token='obviously-fake-endpoint-scoped-registry-credential',hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const manifest={schemaVersion:1,channel:'stable',skills:[{slug:'fixture-skill',name:'Fixture Skill',version:'1.0.0',sha256:'a'.repeat(64),compatibility:{minHermesVersion:null,maxHermesVersion:null},archiveUrl:'https://skills.example.com/v1/skills/fixture-skill/releases/1.0.0/archive'}]};
const body=()=>({target:'fixture-target',manifest,publicationSha256:hash(JSON.stringify(manifest)),approvedBy:'admin'});
function send(id:string,input:unknown=body(),credential=token){return app.request('/hiveskills/jobs/'+id,{method:'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json'},body:JSON.stringify(input)})}
beforeEach(()=>{vi.clearAllMocks();process.env['MAGNUS_HIVESKILLS_DEPLOYMENTS_JSON']=JSON.stringify({'fixture-registry':{tokenSha256:hash(token),targets:{'fixture-target':{nodeId:'fixture-node',agentTarget:'fixture-agent-target'}}}});mocks.db.node.findUnique.mockResolvedValue({id:'fixture-node',hostname:'node.example.com',ipAddress:'192.0.2.1',port:4100,status:'ONLINE',lastHeartbeatAt:new Date()});mocks.db.resourceEnrollment.findUnique.mockResolvedValue({state:'enrolled',nodeFqdn:'node.example.com'});mocks.db.commandResourceLease.count.mockResolvedValue(0);mocks.posture.mockResolvedValue({success:true,data:{registryId:'fixture-registry',target:'fixture-agent-target',ready:true,reason:'ready',configurationSha256:'a'.repeat(64),clientSha256:'b'.repeat(64)}});mocks.db.remoteCommand.findUnique.mockResolvedValue(null);mocks.sync.mockResolvedValue({response:{success:true},evidence:{commandSha256:'b'.repeat(64)}})});
describe('fixed registry execution bridge',()=>{
 it('accepts only the dedicated endpoint credential and server-owned target mapping',async()=>{expect((await send(randomUUID(),body(),'wrong-token')).status).toBe(401);expect((await send(randomUUID(),{...body(),target:'other-target'})).status).toBe(403);expect(mocks.sync).not.toHaveBeenCalled()});
 it('binds exact publication and rejects arbitrary shell or paths before dispatch',async()=>{expect((await send(randomUUID(),{...body(),publicationSha256:'b'.repeat(64)})).status).toBe(409);expect((await send(randomUUID(),{...body(),command:'arbitrary'})).status).toBe(400);expect(mocks.sync).not.toHaveBeenCalled()});
 it('dispatches one fixed native operation with a durable namespace-bound job ID',async()=>{const id=randomUUID(),response=await send(id);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({status:'completed'});expect(mocks.sync).toHaveBeenCalledExactlyOnceWith({target:'fixture-agent-target',registryId:'fixture-registry',manifest,publicationSha256:body().publicationSha256},'hiveskills-'+hash('fixture-registry:'+id));expect(mocks.audit).toHaveBeenCalledTimes(2)});
 it('never replays an admitted job; reconciles only its original signed native receipt',async()=>{const id=randomUUID();const identity=await import('../security/managed-http.js');const request={target:'fixture-agent-target',registryId:'fixture-registry',publicationSha256:body().publicationSha256,manifest};const native=identity.httpIdentity('unused','POST','/hiveskills/sync',JSON.stringify(request),120);mocks.db.remoteCommand.findUnique.mockResolvedValue({nodeId:'fixture-node',createdBy:'service:hiveskills:fixture-registry',command:native.command,args:JSON.stringify(native.args)});mocks.db.commandResourceLease.findUnique.mockResolvedValue({requestSha256:'c'.repeat(64)});mocks.receipt.mockResolvedValue({state:'unknown'});const response=await send(id);expect(await response.json()).toMatchObject({status:'unknown'});expect(mocks.sync).not.toHaveBeenCalled();expect(mocks.receipt).toHaveBeenCalledOnce();expect((await send(id,{...body(),manifest:{...manifest,skills:[]},publicationSha256:hash(JSON.stringify({...manifest,skills:[]}))})).status).toBe(409)});
});

it('verifies exact target posture read-only and holds stale, unenrolled or unknown ownership',async()=>{
 const check=(credential=token)=>app.request('/hiveskills/targets/fixture-target',{headers:{authorization:'Bearer '+credential}});
 expect((await check('wrong-token')).status).toBe(401);
 expect(await (await check()).json()).toMatchObject({ready:true,nodeId:'fixture-node',agentTarget:'fixture-agent-target',clientSha256:'b'.repeat(64)});
 expect(mocks.sync).not.toHaveBeenCalled();expect(mocks.audit).not.toHaveBeenCalled();
 mocks.db.commandResourceLease.count.mockResolvedValue(1);expect(await (await check()).json()).toMatchObject({ready:false});
 mocks.db.commandResourceLease.count.mockResolvedValue(0);mocks.db.resourceEnrollment.findUnique.mockResolvedValue({state:'enrolled',nodeFqdn:'different.example.com'});expect(await (await check()).json()).toMatchObject({ready:false});
 mocks.db.resourceEnrollment.findUnique.mockResolvedValue({state:'enrolled',nodeFqdn:'node.example.com'});mocks.posture.mockResolvedValue({success:true,data:{registryId:'another-registry',target:'fixture-agent-target',ready:true,reason:'ready',configurationSha256:'a'.repeat(64),clientSha256:'b'.repeat(64)}});expect(await (await check()).json()).toMatchObject({ready:false,reason:'Native target posture unavailable'});
 expect(mocks.sync).not.toHaveBeenCalled();
});
