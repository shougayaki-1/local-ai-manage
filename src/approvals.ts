import { constants } from 'node:fs';
import { open, lstat, rename, unlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ControlError, type Controller } from './controller.ts';
import { registryFingerprint, loadHandoff } from './handoff.ts';
import { record } from './registry.ts';
import { readPrivateJson } from './snapshot.ts';
import { ghRead, queueMetadata, type GitHubRead } from './github-queue.ts';
import { approvableReasons, parseGrant, parseE2e, pendingReasons, approvalStatus, issueBinding, diffBinding, protectedReasons, type Grant, type Binding, type E2eScope } from './approval-policy.ts';
import type { Registry, Repository, Snapshot, Job } from './types.ts';

export interface ApprovalRequest {requestId:string;expectedRevision:number;repositoryId:string;issue:number;reason:string;e2e:E2eScope|null}
export interface ApprovalAck {requestId:string;revision:number;status:'recorded';scope:'human-approval';issue:number;reason:string;approvedAt:number}
interface State {version:1;topology:string;revision:number;operations:{command:ApprovalRequest;grant:Grant;ack:ApprovalAck}[]}
const keys=(value:Record<string,unknown>,names:string[])=>Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
export function parseApproval(value:unknown,registry:Registry):ApprovalRequest {
 if(!record(value)||!keys(value,['requestId','expectedRevision','repositoryId','issue','reason','e2e'])||typeof value.requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.requestId)||!Number.isSafeInteger(value.expectedRevision)||(value.expectedRevision as number)<0||typeof value.repositoryId!=='string'||!registry.repositories.some(repo=>repo.id===value.repositoryId)||!Number.isSafeInteger(value.issue)||(value.issue as number)<=0||typeof value.reason!=='string'||!approvableReasons.includes(value.reason)||(value.reason!=='manual_e2e'&&value.e2e!==null))throw new ControlError('invalid_approval');
 let e2e:E2eScope|null=null;try{if(value.reason==='manual_e2e')e2e=parseE2e(value.e2e);}catch{throw new ControlError('invalid_e2e_scope');}
 return {requestId:value.requestId,expectedRevision:value.expectedRevision as number,repositoryId:value.repositoryId,issue:value.issue as number,reason:value.reason,e2e};
}
export function parseApprovalState(value:unknown,registry:Registry):State {
 if(!record(value)||!keys(value,['version','topology','revision','operations'])||value.version!==1||value.topology!==registryFingerprint(registry)||!Array.isArray(value.operations)||value.operations.length>1024||value.revision!==value.operations.length)throw new ControlError('approval_state_invalid',503);
 const seen=new Set<string>();
 const operations=value.operations.map((item,index)=>{
  if(!record(item)||!keys(item,['command','grant','ack']))throw new ControlError('approval_state_invalid',503);
  const command=parseApproval(item.command,registry);const grant=parseGrant(item.grant);const repo=registry.repositories.find(repo=>repo.id===command.repositoryId)!;
  if(seen.has(command.requestId)||command.expectedRevision!==index||grant.repositoryId!==command.repositoryId||grant.repo!==repo.repo||grant.issue!==command.issue||grant.reason!==command.reason||JSON.stringify(grant.e2e)!==JSON.stringify(command.e2e))throw new ControlError('approval_state_invalid',503);
  seen.add(command.requestId);
  const ack:ApprovalAck={requestId:command.requestId,revision:index+1,status:'recorded',scope:'human-approval',issue:command.issue,reason:command.reason,approvedAt:grant.approvedAt};
  const storedAck=item.ack;
  if(!record(storedAck)||!keys(storedAck,Object.keys(ack))||Object.entries(ack).some(([key,value])=>storedAck[key]!==value))throw new ControlError('approval_state_invalid',503);
  return {command,grant,ack};
 });
 return {version:1,topology:registryFingerprint(registry),revision:operations.length,operations};
}
export async function readApprovalGrants(directory:string,registry:Registry):Promise<Grant[]> {
 try {
  const info=await lstat(join(directory,'approvals.json'));
  if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)throw new ControlError('approval_state_unsafe',503);
  const state=parseApprovalState((await readPrivateJson(join(directory,'approvals.json'))).value,registry);
  const latest=new Map<string,Grant>();for(const item of state.operations)latest.set(`${item.grant.repositoryId}:${item.grant.issue}:${item.grant.reason}`,item.grant);
  return [...latest.values()];
 }catch(error){if(error instanceof Error&&'code' in error&&error.code==='ENOENT')return [];throw error;}
}
export const approvalGit=(binary:string,args:string[],options?:{cwd?:string}):Promise<string>=>new Promise((resolve,reject)=>{
 if(binary!=='git'){reject(new Error('approval_command_rejected'));return;}
 execFile('git',args,{cwd:options?.cwd,env:{PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'},timeout:10000,maxBuffer:20_000_000,shell:false},(error,stdout)=>error?reject(new Error('approval_scope_unavailable')):resolve(stdout.trimEnd()));
});
export class Approvals {
 private state:State;private writable=true;
 private registry:Registry;private controller:Controller;private read:GitHubRead;private git:typeof approvalGit;
 private constructor(registry:Registry,controller:Controller,state:State,read:GitHubRead,git:typeof approvalGit){this.registry=registry;this.controller=controller;this.state=state;this.read=read;this.git=git;}
 static async create(registry:Registry,controller:Controller,options:{read?:GitHubRead;git?:typeof approvalGit}={}):Promise<Approvals>{
  let state:State={version:1,topology:registryFingerprint(registry),revision:0,operations:[]};
  try{await readApprovalGrants(controller.directoryPath(),registry);state=parseApprovalState((await readPrivateJson(join(controller.directoryPath(),'approvals.json'))).value,registry);}catch(error){if(!(error instanceof Error)||!('code' in error)||error.code!=='ENOENT')throw error;}
  return new Approvals(registry,controller,state,options.read??ghRead,options.git??approvalGit);
 }
 grants():Grant[]{const latest=new Map<string,Grant>();for(const item of this.state.operations)latest.set(`${item.grant.repositoryId}:${item.grant.issue}:${item.grant.reason}`,item.grant);return structuredClone([...latest.values()]);}
 revision():number{return this.state.revision;}
 ack(id:string):ApprovalAck|null{return this.state.operations.find(item=>item.command.requestId===id)?.ack??null;}
 private async current(repo:Repository,issue:number){
  if(await realpath(repo.stateDirectory)!==repo.stateDirectory)throw new ControlError('approval_scope_unavailable',503);
  const raw=(await readPrivateJson(join(repo.stateDirectory,'state.json'))).value;
  if(!record(raw)||raw.version!==1||raw.repo!==repo.repo||!Array.isArray(raw.humanWaiting??[])||!['needs-human','idle','running'].includes(String(raw.status)))throw new ControlError('approval_worker_unavailable',409);
  const parked=(raw.humanWaiting as unknown[]|undefined)?.filter(record).find(item=>record(item.current)&&item.current.number===issue);
  const current=parked?.current??raw.current;
  if(!record(current)||current.number!==issue||(!parked&&(raw.status!=='needs-human'||raw.paused!==true))||!['prepare','implement','publish'].includes(String(current.stage)))throw new ControlError('approval_current_issue_mismatch',409);
  if(typeof current.worktree!=='string'||current.worktree!==join(repo.stateDirectory,'worktrees',`issue-${issue}`)||typeof current.branch!=='string'||!current.branch.startsWith(`codex/issue-${issue}-`))throw new ControlError('approval_worktree_unsafe',409);
  return current as Record<string,unknown>&{number:number;worktree:string;branch:string};
 }
 private async scope(repo:Repository,number:number){
  const current=await this.current(repo,number);const handoffs=await loadHandoff(join(this.controller.directoryPath(),'handoff.json'),this.registry);
  const profile=handoffs.find(item=>item.repositoryId===repo.id)?.profile;if(!profile)throw new ControlError('approval_requires_managed_repository',409);
  const raw=(await readPrivateJson(join(repo.stateDirectory,'state.json'))).value;
  if(!record(raw)||(raw.profile!==undefined&&raw.profile!==profile)||(profile!=='care-record-v1'&&raw.profile===undefined))throw new ControlError('approval_profile_mismatch',409);
  const issue=await this.read(repo.repo,`issues/${number}`);
  if(!record(issue)||issue.number!==number||issue.state!=='open'||typeof issue.body!=='string'||!Array.isArray(issue.labels)||issue.pull_request||/<!--\s*codex-worker-status\s*-->/.test(issue.body))throw new ControlError('approval_issue_ineligible',409);
  const labels=issue.labels.map(item=>typeof item==='string'?item:record(item)?item.name:null);
  if(labels.some(label=>['codex:blocked','codex:failed','codex:running'].includes(String(label))))throw new ControlError('approval_issue_ineligible',409);
  const metadata=queueMetadata(issue.body);
  for(const dependency of metadata.dependencies){const item=await this.read(repo.repo,`issues/${dependency}`);if(!record(item)||item.number!==dependency||item.state!=='closed')throw new ControlError('approval_dependency_blocked',409);}
  const bindings:{issue:Binding;diff?:Binding}={issue:issueBinding({body:issue.body})};
  let reasons=pendingReasons(current);
  if(current.base!==undefined){
   const common=await this.git('git',['rev-parse','--path-format=absolute','--git-common-dir'],{cwd:current.worktree});
   if(common!==await this.git('git',['rev-parse','--path-format=absolute','--git-common-dir'],{cwd:repo.clonePath}))throw new ControlError('approval_worktree_unsafe',409);
   bindings.diff=await diffBinding(current,this.git);reasons=[...new Set([...reasons,...await protectedReasons(current,this.git,profile)])];
   if(JSON.stringify(bindings.diff)!==JSON.stringify(await diffBinding(current,this.git)))throw new ControlError('approval_scope_changed',409);
  }
  return {current,bindings,reasons,profile};
 }
 apply(value:unknown):Promise<ApprovalAck>{
  const command=parseApproval(value,this.registry);
  return this.controller.dispatchGate(async()=>{
   if(!this.writable)throw new ControlError('approval_storage_uncertain',503);
   if(this.controller.ack(command.requestId))throw new ControlError('request_id_conflict',409);
   const prior=this.state.operations.find(item=>item.command.requestId===command.requestId);
   if(prior){if(JSON.stringify(prior.command)!==JSON.stringify(command))throw new ControlError('request_id_conflict',409);return {...prior.ack};}
   if(command.expectedRevision!==this.state.revision)throw new ControlError('revision_conflict',409);
   if(this.state.operations.length>=1024)throw new ControlError('request_history_full',503);
   if(this.controller.view().scheduler?.active)throw new ControlError('approval_worker_active',409);
   try{await lstat(join(this.controller.directoryPath(),'dispatch.lock'));throw new ControlError('approval_worker_active',409);}catch(error){if(!(error instanceof Error)||!('code' in error)||error.code!=='ENOENT')throw error;}
   const repo=this.registry.repositories.find(repo=>repo.id===command.repositoryId)!;
   if(await realpath(repo.stateDirectory)!==repo.stateDirectory)throw new ControlError('approval_scope_unavailable',503);
   const lock=await open(join(repo.stateDirectory,'worker.lock'),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600).catch(()=>{throw new ControlError('approval_worker_active',409);});
   try {
    const scope=await this.scope(repo,command.issue);
    if(!scope.reasons.includes(command.reason))throw new ControlError('approval_reason_not_pending',409);
    if(command.reason==='manual_e2e'&&scope.profile!=='care-record-v1')throw new ControlError('approval_e2e_profile_unsupported',409);
    const binding=command.reason==='manual_e2e'?scope.bindings.issue:scope.bindings.diff;
    if(!binding)throw new ControlError('approval_diff_missing',409);
    const grant:Grant={repositoryId:repo.id,repo:repo.repo,issue:command.issue,reason:command.reason,binding,approvedAt:Date.now(),e2e:command.e2e};
    const ack:ApprovalAck={requestId:command.requestId,revision:this.state.revision+1,status:'recorded',scope:'human-approval',issue:command.issue,reason:command.reason,approvedAt:grant.approvedAt};
    const next:State={...this.state,revision:ack.revision,operations:[...this.state.operations,{command,grant,ack}]};
    const temporary=join(this.controller.directoryPath(),`${randomUUID()}.tmp`);
    try {
     const file=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
     try{await file.writeFile(JSON.stringify(next));await file.sync();}finally{await file.close();}
     await rename(temporary,join(this.controller.directoryPath(),'approvals.json'));
     const parent=await open(this.controller.directoryPath(),constants.O_RDONLY);try{await parent.sync();}finally{await parent.close();}
    }catch{this.writable=false;this.controller.storageUncertain();throw new ControlError('approval_storage_uncertain',503);}finally{await unlink(temporary).catch(()=>{});}
    this.state=next;return {...ack};
   }finally{await lock.close();await unlink(join(repo.stateDirectory,'worker.lock'));}
  });
 }
 async project(snapshot:Snapshot):Promise<Snapshot>{
  const value=structuredClone(snapshot);value.approvalRevision=this.state.revision;
  for(const repo of value.repositories){
   const configured=this.registry.repositories.find(item=>item.id===repo.id)!;
   const jobs=[...(repo.current&&repo.status==='needs-human'?[repo.current]:[]),...(repo.humanWaiting??[]).map(item=>item.job)];
   for(const job of jobs)await this.projectJob(configured,job);
  }
  return value;
 }
 private async projectJob(repo:Repository,job:Job){
  let scope:Awaited<ReturnType<Approvals['scope']>>|null=null;
  try{scope=await this.scope(repo,job.issue);}catch{/* Unverified scope never claims approval. */}
  if(scope)job.reasonCategories=scope.reasons;
  job.approvals=job.reasonCategories.map(reason=>({reason,status:scope?approvalStatus(this.grants(),repo.id,repo.repo,job.issue,reason,reason==='manual_e2e'?scope.bindings.issue:scope.bindings.diff):this.grants().some(grant=>grant.repositoryId===repo.id&&grant.issue===job.issue&&grant.reason===reason)?'stale':'missing',approvable:approvableReasons.includes(reason)&&!(reason==='manual_e2e'&&scope?.profile!=='care-record-v1')}));
 }
}
