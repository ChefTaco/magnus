/** Private durable supervisor files. No command/environment appears in public evidence. */
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
export const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
// Worst-case JSON escaping across both streams stays below the 4 MiB record cap.
export const MAX_OUTPUT = 256 * 1024;
export interface SupervisorInput {
  commandId: string; command: string; args: string[]; workingDirectory?: string;
  environment?: Record<string,string>; timeoutSeconds: number;
  coordination?: { version: 1; resourceKey: string; fence: string; expiresAt: number };
}
export function requestDigest(input: SupervisorInput): string {
  return hash(JSON.stringify({ commandId:input.commandId,command:input.command,args:input.args,
    workingDirectory:input.workingDirectory??null,
    environment:Object.fromEntries(Object.entries(input.environment??{}).sort(([a],[b])=>a<b?-1:a>b?1:0)),
    timeoutSeconds:input.timeoutSeconds,coordination:input.coordination?{
      version:1,resourceKey:input.coordination.resourceKey,fence:input.coordination.fence,expiresAt:input.coordination.expiresAt,
    }:null }));
}
export interface ExecutionIntent {
  version: 1; commandId: string; requestSha256: string; unit: string; nonce: string;
  bootId: string; preparedAt: number; deadline: number; phase: 'prepared'|'starting';
  defaultWorkingDirectory:string; payloadSha256: string; workerSha256: string; stateSha256: string; stopRequestedAt?: number;
  completionOwner?: { version:1; registrySha256:string; descriptorId:string };
}
export interface WorkerStarted { version:1; nonce:string; requestSha256:string; invocationId:string; cgroup:string; startedAt:number }
export interface WorkerResult { version:1; nonce:string; requestSha256:string; invocationId:string;
  exitCode:number; stdout:string; stderr:string; truncated:boolean; durationMs:number }
export async function privateDirectory(path:string):Promise<void> {
  await mkdir(path,{recursive:true,mode:0o700});const st=await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.mode&0o077 || (process.getuid && st.uid!==process.getuid())) throw new Error('Unsafe supervisor directory');
}
export async function syncDirectory(root:string):Promise<void> { const fd=await open(root,constants.O_RDONLY);try{await fd.sync();}finally{await fd.close();} }
export async function writeJson(root:string,name:string,value:unknown):Promise<void> {
  const temp=join(root,'.'+name+'.'+randomUUID());const fd=await open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{await fd.writeFile(JSON.stringify(value));await fd.sync();}finally{await fd.close();}
  await rename(temp,join(root,name));await syncDirectory(root);
}
export async function readJson<T>(root:string,name:string,max=4*1024*1024):Promise<T|undefined> {
  let fd;try{fd=await open(join(root,name),constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
  try{const st=await fd.stat();if(!st.isFile()||st.nlink!==1||st.mode&0o077||st.size>max||(process.getuid&&st.uid!==process.getuid()))throw new Error('Unsafe supervisor record');return JSON.parse(await fd.readFile('utf8')) as T;}finally{await fd.close();}
}
