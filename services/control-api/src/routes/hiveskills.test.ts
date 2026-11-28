import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from 'jose';
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

describe('Oathweave service tokens for the registry executor',()=>{
 const ISSUER='https://identity.example.com',JWKS_URL=ISSUER+'/oauth/jwks';
 const LINK={issuer:ISSUER,subject:'hiveskills-executor',localUserId:'fixture-registry',role:'HIVESKILLS_SERVICE'};
 let signingKey:CryptoKey,jwks:JSONWebKeySet;
 beforeAll(async()=>{const pair=await generateKeyPair('RS256');signingKey=pair.privateKey;jwks={keys:[{...await exportJWK(pair.publicKey),kid:'fixture-key',alg:'RS256',use:'sig'}]}});
 const sign=(claims:Record<string,unknown>,subject:string,options:{audience?:string;lifetime?:number}={})=>{const now=Math.floor(Date.now()/1000);return new SignJWT(claims).setProtectedHeader({alg:'RS256',kid:'fixture-key'}).setIssuer(ISSUER).setAudience(options.audience??'magnus').setSubject(subject).setJti(randomUUID()).setIssuedAt(now).setExpirationTime(now+(options.lifetime??300)).sign(signingKey)};
 const service=(claims:Record<string,unknown>={},subject='hiveskills-executor',options={})=>sign({actorType:'SERVICE_ACCOUNT',token_type:'access',clientId:subject,permissions:['magnus:hiveskills'],...claims},subject,options);
 const links=(rows:unknown[])=>vi.stubEnv('MAGNUS_OATHWEAVE_IDENTITIES_JSON',JSON.stringify(rows));
 beforeEach(async()=>{
  const {resetOathweaveVerifier}=await import('../middleware/oathweave-verifier.js');resetOathweaveVerifier();
  vi.stubEnv('OATHWEAVE_ISSUER',ISSUER);vi.stubEnv('OATHWEAVE_JWKS_URL',JWKS_URL);vi.stubEnv('OATHWEAVE_USERINFO_URL',ISSUER+'/oauth/userinfo');
  links([LINK,{issuer:ISSUER,subject:'ardent-studio',localUserId:'ardentstudio',role:'ARDENT_SERVICE'},{issuer:ISSUER,subject:'admin-subject',localUserId:'alice',role:'ADMIN'},{issuer:ISSUER,subject:'unknown-registry-client',localUserId:'other-registry',role:'HIVESKILLS_SERVICE'}]);
  vi.stubGlobal('fetch',async(input:RequestInfo|URL)=>{if(String(input)===JWKS_URL)return Response.json(jwks);throw new Error('unexpected request')});
 });
 afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals()});

 it('accepts a linked HiveSkills client holding magnus:hiveskills for the registry its link names',async()=>{
  const token=await service(),id=randomUUID(),response=await send(id,body(),token);
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({status:'completed'});
  expect(mocks.sync).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({registryId:'fixture-registry'}),'hiveskills-'+hash('fixture-registry:'+id));
  expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({actorId:'service:hiveskills:fixture-registry',details:expect.objectContaining({authentication:'oathweave',clientId:'hiveskills-executor'})}));
  expect((await app.request('/hiveskills/targets/fixture-target',{headers:{authorization:'Bearer '+token}})).status).toBe(200);
 });

 it('serves a registry that has no static credential at all',async()=>{
  vi.stubEnv('MAGNUS_HIVESKILLS_DEPLOYMENTS_JSON',JSON.stringify({'fixture-registry':{targets:{'fixture-target':{nodeId:'fixture-node',agentTarget:'fixture-agent-target'}}}}));
  expect((await send(randomUUID(),body(),await service())).status).toBe(200);
  expect((await send(randomUUID(),body(),token)).status).toBe(401);
 });

 it.each([
  ['another audience',()=>service({},'hiveskills-executor',{audience:'hiveskills'}),401],
  ['a lifetime over fifteen minutes',()=>service({},'hiveskills-executor',{lifetime:3600}),401],
  ['a session claim',()=>service({sessionId:'fixture-session'}),401],
  ['a person token on the service link subject',()=>sign({actorType:'USER',sessionId:'fixture-session',clientId:'hivexui-magnus',roles:[],permissions:['magnus:hiveskills','magnus:admin']},'hiveskills-executor'),401],
  ['a person token of a linked ADMIN',()=>sign({actorType:'USER',sessionId:'fixture-session',clientId:'hivexui-magnus',roles:[],permissions:['magnus:admin']},'admin-subject'),401],
  ['no magnus:hiveskills permission',()=>service({permissions:['magnus:ardent','magnus:admin']}),403],
  ['an unlinked client',()=>service({},'unlinked-client'),403],
  ['an Ardent service link',()=>service({},'ardent-studio'),403],
  ['a link naming a registry without a grant',()=>service({},'unknown-registry-client'),403],
])('refuses %s before any dispatch',async(_name,mint,status)=>{
  expect((await send(randomUUID(),body(),await mint())).status).toBe(status);
  expect(mocks.sync).not.toHaveBeenCalled();expect(mocks.audit).not.toHaveBeenCalled();
 });

 it('refuses a link naming an inherited property instead of a configured registry',async()=>{
  links([{...LINK,localUserId:'constructor'}]);
  expect((await send(randomUUID(),body(),await service())).status).toBe(403);
  expect(mocks.sync).not.toHaveBeenCalled();
 });

 it('never falls through to the static credential once a token is an Oathweave token',async()=>{
  const unlinked=await service({},'unlinked-client');
  vi.stubEnv('MAGNUS_HIVESKILLS_DEPLOYMENTS_JSON',JSON.stringify({'fixture-registry':{tokenSha256:hash(unlinked),targets:{'fixture-target':{nodeId:'fixture-node',agentTarget:'fixture-agent-target'}}}}));
  expect((await send(randomUUID(),body(),unlinked)).status).toBe(403);
  expect(mocks.sync).not.toHaveBeenCalled();
 });

 it('keeps the deprecated static credential working beside Oathweave, and audits which one was used',async()=>{
  expect((await send(randomUUID())).status).toBe(200);
  expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({details:expect.objectContaining({authentication:'static'})}));
 });

 it('reconciles a job admitted with the static credential when asked with a token, and the reverse',async()=>{
  const id=randomUUID();expect((await send(id)).status).toBe(200);
  const identity=await import('../security/managed-http.js'),request={target:'fixture-agent-target',registryId:'fixture-registry',publicationSha256:body().publicationSha256,manifest},native=identity.httpIdentity('unused','POST','/hiveskills/sync',JSON.stringify(request),120);
  mocks.db.remoteCommand.findUnique.mockResolvedValue({nodeId:'fixture-node',createdBy:'service:hiveskills:fixture-registry',command:native.command,args:JSON.stringify(native.args)});
  mocks.db.commandResourceLease.findUnique.mockResolvedValue({requestSha256:'c'.repeat(64)});mocks.receipt.mockResolvedValue({state:'completed',result:{exitCode:0}});
  const observed=await app.request('/hiveskills/jobs/'+id+'?target=fixture-target',{headers:{authorization:'Bearer '+await service()}});
  expect(await observed.json()).toMatchObject({jobId:'hiveskills-'+hash('fixture-registry:'+id),status:'completed'});
  expect(mocks.sync).toHaveBeenCalledOnce();
 });
});

it('refuses a target named like an inherited property',async()=>{
 expect((await send(randomUUID(),{...body(),target:'constructor'})).status).toBe(403);
 expect((await app.request('/hiveskills/targets/constructor',{headers:{authorization:'Bearer '+token}})).status).toBe(403);
 expect(mocks.sync).not.toHaveBeenCalled();
});
