import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { lstat, realpath, open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, sep } from 'node:path';
import { githubEnvironment } from './github-queue.ts';
import { registryFingerprint } from './handoff.ts';
import { record } from './registry.ts';
import { readPrivateJson } from './snapshot.ts';
import { formatRemoteStatus } from './remote-status.ts';
import type { Registry, Snapshot } from './types.ts';
export interface StatusTarget {repositoryId:string;repo:string;issue:number;comment:number}
export interface StatusTargets {version:1;registryFingerprint:string;targets:StatusTarget[]}
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>0;
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export function parseStatusTargets(value:unknown,registry?:Registry):StatusTargets {
 if(!record(value)||!exact(value,['version','registryFingerprint','targets'])||value.version!==1||typeof value.registryFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(value.registryFingerprint)||!Array.isArray(value.targets)||value.targets.length<1||value.targets.length>32||(registry&&value.registryFingerprint!==registryFingerprint(registry)))throw new Error('invalid_status_targets');
 const seen=new Set<string>();const comments=new Set<string>();
 for(const target of value.targets){if(!record(target)||!exact(target,['repositoryId','repo','issue','comment'])||typeof target.repo!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(target.repo)||target.repo.split('/').some(v=>v==='.'||v==='..')||target.repositoryId!==target.repo.toLowerCase().replace('/','--')||!positive(target.issue)||!positive(target.comment)||seen.has(String(target.repositoryId))||comments.has(`${target.repo.toLowerCase()}/${target.comment}`)||registry&&!registry.repositories.some(r=>r.id===target.repositoryId&&r.repo===target.repo))throw new Error('invalid_status_target');seen.add(target.repositoryId as string);comments.add(`${target.repo.toLowerCase()}/${target.comment}`);}
 return value as unknown as StatusTargets;
}
export async function loadStatusTargets(directory:string,registry?:Registry):Promise<StatusTargets>{const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0||await realpath(directory)!==directory||registry?.repositories.flatMap(r=>[r.clonePath,r.stateDirectory]).some(p=>directory===p||directory.startsWith(p+sep)||p.startsWith(directory+sep)))throw new Error('unsafe_status_directory');const file=join(directory,'targets.json');const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)throw new Error('unsafe_status_targets');return parseStatusTargets((await readPrivateJson(file)).value,registry);}
export type StatusRequest=(target:StatusTarget,resource:'issue'|'comment',body?:string)=>Promise<unknown>;
export function statusArgs(target:StatusTarget,resource:'issue'|'comment',write=false):string[]{parseStatusTargets({version:1,registryFingerprint:'a'.repeat(64),targets:[target]});if(!['issue','comment'].includes(resource)||write&&resource!=='comment')throw new Error('invalid_status_request');return ['api','--hostname','github.com','--method',write?'PATCH':'GET',`repos/${target.repo}/issues/${resource==='issue'?target.issue:`comments/${target.comment}`}`,...(write?['--input','-']:[])];}
export const statusRequest:StatusRequest=(target,resource,body)=>new Promise((resolve,reject)=>{const args=statusArgs(target,resource,body!==undefined);const child=execFile('gh',args,{cwd:homedir(),env:githubEnvironment(process.env),timeout:10000,killSignal:'SIGKILL',maxBuffer:1048576,shell:false},(error,stdout)=>{if(error){reject(new Error('status_transport_unavailable'));return;}try{resolve(JSON.parse(stdout));}catch{reject(new Error('status_transport_unavailable'));}});child.stdin?.on('error',()=>{});child.stdin?.end(body===undefined?'':JSON.stringify({body}));});
const marker='<!-- codex-worker-status -->';
function commentBody(value:unknown,target:StatusTarget):string{if(!record(value)||value.id!==target.comment||value.issue_url!==`https://api.github.com/repos/${target.repo}/issues/${target.issue}`||typeof value.body!=='string'||value.body.length>65536||!value.body.startsWith(marker+'\n')||value.body.split(marker).length!==2)throw new Error('invalid_status_comment');return value.body;}
function assertIssue(value:unknown,target:StatusTarget){if(!record(value)||value.number!==target.issue||value.state!=='open'||value.pull_request||typeof value.body!=='string'||!value.body.includes(marker)||!Array.isArray(value.labels)||value.labels.some(v=>{const name=typeof v==='string'?v:record(v)?v.name:null;return typeof name!=='string'||name.startsWith('codex:');}))throw new Error('invalid_status_issue');}
const { classifyHeartbeat }=await import(new URL(import.meta.url.endsWith('.ts')?'../engine/status-monitor.mjs':'../../engine/status-monitor.mjs',import.meta.url).href);
export function remoteHeartbeat(body:string,now:number):{status:'observed'|'stale'|'stopped'|'unknown';at:string|null}{return classifyHeartbeat(body,now);}
export async function monitorStatus(config:StatusTargets,request:StatusRequest=statusRequest,now=Date.now()){const results=[];for(const target of config.targets){try{assertIssue(await request(target,'issue'),target);const body=commentBody(await request(target,'comment'),target);results.push({repositoryId:target.repositoryId,...remoteHeartbeat(body,now)});}catch{results.push({repositoryId:target.repositoryId,status:'unavailable',at:null});}}return {version:1,checkedAt:new Date(now).toISOString(),repositories:results};}
const signature=(body:string)=>body.replace(/<!-- codex-worker-heartbeat: [^\n]+ -->\n/g,'').replace(/^- Last heartbeat: .*$/m,'');
/** Sole comment writer. Monitoring never PATCHes, so it cannot overwrite a newer heartbeat. */
export class StatusPublisher {
 private last=new Map<string,{signature:string;attempt:number}>();
 private config:StatusTargets;private request:StatusRequest;
 constructor(config:StatusTargets,request:StatusRequest=statusRequest){this.config=parseStatusTargets(config);this.request=request;}
 async tick(snapshot:Snapshot,now=Date.now(),stopping:()=>boolean=()=>false){
  const results=[];
  for(const target of this.config.targets){if(stopping())break;const repo=snapshot.repositories.find(r=>r.id===target.repositoryId&&r.repo===target.repo);if(!repo){results.push({repositoryId:target.repositoryId,status:'unavailable'});continue;}
   const body=formatRemoteStatus(repo,snapshot.queue.repositories.find(q=>q.repositoryId===repo.id),now);const key=signature(body);const previous=this.last.get(target.repositoryId);if(previous&&now-previous.attempt<300000&&previous.signature===key)continue;
   this.last.set(target.repositoryId,{signature:key,attempt:now});
   try{assertIssue(await this.request(target,'issue'),target);const remote=await this.request(target,'comment');const current=commentBody(remote,target);const heartbeat=remoteHeartbeat(current,now);const proposed=remoteHeartbeat(body,now);if(heartbeat.at&&(!proposed.at||Date.parse(heartbeat.at)>Date.parse(proposed.at)))throw new Error('newer_remote_heartbeat');
    // Re-read immediately before writing; retain any administrator edit and retry later.
    const latest=commentBody(await this.request(target,'comment'),target);if(latest!==current)throw new Error('comment_changed');
    const updated=record(remote)&&typeof remote.updated_at==='string'?Date.parse(remote.updated_at):NaN;
    if(signature(latest)===key&&Number.isFinite(updated)&&updated<=now&&now-updated<300000){results.push({repositoryId:target.repositoryId,status:'unchanged'});continue;}
    if(latest!==body){const result=await this.request(target,'comment',body);if(commentBody(result,target)!==body)throw new Error('status_response_unknown');}
    results.push({repositoryId:target.repositoryId,status:'published'});
   }catch{results.push({repositoryId:target.repositoryId,status:'unavailable'});}
  }
  return results;
 }
}
export async function lockPublisher(directory:string){const path=join(directory,'publisher.lock');const handle=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{await handle.writeFile(JSON.stringify({version:1}));await handle.sync();}catch{await handle.close();throw new Error('publisher_lock_uncertain');}return async()=>{await handle.close();await unlink(path);};}
