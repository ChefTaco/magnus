import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { HiveSkillsPublicationSchema } from '@hivemagnus/magnus-contracts';
import type { AppVariables } from '../types/index.js';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';
import { safeEqual } from '../utils/safe-equal.js';
import { getNodeManagerSecret } from '../utils/env.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { NodeApiClient } from '../sdk/node-api-client.js';
import { logAuditEvent } from '../services/audit-service.js';
import { httpIdentity } from '../security/managed-http.js';

const slug=z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
export const skillsExecutorConfig=z.record(slug,z.object({tokenSha256:z.string().regex(/^[a-f0-9]{64}$/),targets:z.record(slug,z.object({nodeId:z.string().min(1).max(128),agentTarget:slug}).strict())}).strict());
export const skillJobRequest=z.object({target:slug,publicationSha256:z.string().regex(/^[a-f0-9]{64}$/),manifest:HiveSkillsPublicationSchema,approvedBy:z.string().min(1).max(200)}).strict();
export const hiveskillsRouter=new Hono<AppVariables>();
function authorize(header:string|undefined){
 let raw:unknown;try{raw=JSON.parse(process.env['MAGNUS_HIVESKILLS_DEPLOYMENTS_JSON']??'{}')}catch{throw new HttpError(503,'HIVESKILLS_UNCONFIGURED','Invalid Skills executor configuration')}
 const configured=skillsExecutorConfig.safeParse(raw);
 if(!configured.success)throw new HttpError(503,'HIVESKILLS_UNCONFIGURED','Invalid Skills executor configuration');
 if(!header?.startsWith('Bearer ')||header.length<39||/[\r\n]/.test(header))throw new HttpError(401,'UNAUTHORIZED','Endpoint-scoped Skills credential required');
 const digest=createHash('sha256').update(header.slice(7)).digest('hex');
 for(const [registryId,entry] of Object.entries(configured.data))if(safeEqual(entry.tokenSha256,digest))return {registryId,...entry};
 throw new HttpError(401,'UNAUTHORIZED','Endpoint-scoped Skills credential required');
}
function commandId(registryId:string,id:string){if(!z.uuid().safeParse(id).success)throw new HttpError(400,'VALIDATION_ERROR','Job UUID required');return 'hiveskills-'+createHash('sha256').update(registryId+':'+id).digest('hex')}
async function targetClient(registry:ReturnType<typeof authorize>,target:string){
 const binding=registry.targets[target];if(!binding)throw new HttpError(403,'FORBIDDEN','Target is outside this registry executor grant');
 const node=await getDb().node.findUnique({where:{id:binding.nodeId}});
 if(!node||node.status==='DECOMMISSIONED')throw new HttpError(409,'TARGET_UNAVAILABLE','Configured target is unavailable');
 return {binding,node,client:new NodeApiClient({baseUrl:getNodeBaseUrl(node.ipAddress,node.port),resourceNodeId:node.id,resourceActorId:'service:hiveskills:'+registry.registryId,nodeToken:getNodeManagerSecret()})};
}
async function observed(registry:ReturnType<typeof authorize>,target:string,id:string){
 const {node,client}=await targetClient(registry,target),jobId=commandId(registry.registryId,id);
 const row=await getDb().remoteCommand.findUnique({where:{id:jobId}});
 if(!row)throw new HttpError(404,'NOT_FOUND','Job has not been admitted');
 if(row.nodeId!==node.id||row.createdBy!=='service:hiveskills:'+registry.registryId)throw new HttpError(409,'JOB_BINDING_CONFLICT','Job belongs to another target');
 const lease=await getDb().commandResourceLease.findUnique({where:{commandId:jobId}});
 if(!lease) return {jobId,status:'unknown',result:'Missing durable ownership; review required'};
 try{
  const receipt=await client.getCommandReceipt(jobId,{nodeFqdn:node.hostname,requestSha256:lease.requestSha256});
  if(receipt.state==='completed')return {jobId,status:receipt.result.exitCode===0?'completed':'failed',result:receipt.result.exitCode===0?'Exact approved publication synchronized':'Node completed with a bounded failure'};
  return {jobId,status:receipt.state==='running'?'running':'unknown',result:'Original operation retained; never replayed'};
 }catch{return {jobId,status:'unknown',result:'Receipt unavailable; original operation retained'}}
}
hiveskillsRouter.get('/jobs/:id',async c=>{const registry=authorize(c.req.header('authorization'));const target=slug.safeParse(c.req.query('target'));if(!target.success)throw new HttpError(400,'VALIDATION_ERROR','Exact target required');return c.json(await observed(registry,target.data,c.req.param('id')))});
hiveskillsRouter.post('/jobs/:id',async c=>{
 const registry=authorize(c.req.header('authorization')),parsed=skillJobRequest.safeParse(await c.req.json().catch(()=>null));
 if(!parsed.success)throw new HttpError(400,'VALIDATION_ERROR','Exact approved Skills publication required');
 const body=parsed.data,jobId=commandId(registry.registryId,c.req.param('id'));
 if(createHash('sha256').update(JSON.stringify(body.manifest)).digest('hex')!==body.publicationSha256)throw new HttpError(409,'PUBLICATION_CONFLICT','Publication digest differs');
 const {binding,node,client}=await targetClient(registry,body.target);
 const request={target:binding.agentTarget,registryId:registry.registryId,publicationSha256:body.publicationSha256,manifest:body.manifest};
 const prior=await getDb().remoteCommand.findUnique({where:{id:jobId}});
 if(prior){
  const identity=httpIdentity(jobId,'POST','/hiveskills/sync',JSON.stringify(request),120);
  if(prior.nodeId!==node.id||prior.createdBy!=='service:hiveskills:'+registry.registryId||prior.command!==identity.command||prior.args!==JSON.stringify(identity.args))throw new HttpError(409,'JOB_BINDING_CONFLICT','Existing job has another target or publication');
  return c.json(await observed(registry,body.target,c.req.param('id')));
 }
 await logAuditEvent({action:'skill.push',actorId:'service:hiveskills:'+registry.registryId,targetType:'node',targetId:node.id,details:{jobId,target:body.target,publicationSha256:body.publicationSha256,approvedBy:body.approvedBy,outcome:'requested'}});
 try {
  const result=await client.syncHiveSkills(request,jobId);
  await logAuditEvent({action:'skill.push',actorId:'service:hiveskills:'+registry.registryId,targetType:'node',targetId:node.id,details:{jobId,target:body.target,publicationSha256:body.publicationSha256,approvedBy:body.approvedBy,commandSha256:result.evidence.commandSha256}});
  return c.json({jobId,status:result.response.success?'completed':'failed',result:result.response.success?'Exact approved publication synchronized':'Node completed with a bounded failure'});
 }catch{
  const row=await getDb().remoteCommand.findUnique({where:{id:jobId}});
  if(!row)return c.json({jobId,status:'not_admitted',result:'No operation was admitted; resolve target readiness and prepare a new preview'});
  return c.json(await observed(registry,body.target,c.req.param('id')));
 }
});
