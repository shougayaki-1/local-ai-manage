import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { record } from './registry.ts';
import { Controller, ControlError } from './controller.ts';
import { Approvals, parseApproval, type ApprovalRequest } from './approvals.ts';
import { registryFingerprint } from './handoff.ts';
import { readPrivateJson } from './snapshot.ts';
import { githubEnvironment } from './github-queue.ts';
import { pendingReasons, approvableReasons, operationalReasons, parseReviewBinding, parseRecovery, parseReevaluation, parseE2e, recoveryState, type Binding, type E2eScope, type Reevaluation } from './approval-policy.ts';
import type { Registry, Repository, Snapshot, Job } from './types.ts';

const categories=[...approvableReasons,...operationalReasons,'specification','production','deploy','credential','external_service','destructive','worktree_safety'];
const checks=['typecheck','lint','test','test:unit','test:ui','build','test:codex-worker','test:ci-scope','diff-check'];
const states=['missing','approved','stale','automatic','automatic_retry_pending','human_investigation_required','decision_required','reevaluating','non_approvable','scope_required'] as const;
type ReviewStatus=typeof states[number];
type Worker='waiting'|'resuming'|'running'|'idle';
export interface ReviewRequest {
 requestId:string;repositoryId:string;issue:number;bindings:{issue:Binding;diff?:Binding};reasons:string[];e2e:E2eScope|null;
 authorId:number;commentId:number|null;createdAt:number;ignoredReactionIds:number[];published:boolean;
 statuses:{reason:string;status:ReviewStatus}[];worker:Worker;check:string|null;commands:ApprovalRequest[];baselineApprovalIds:{reason:string;requestId:string|null}[];reevaluation:Reevaluation|null;
}
interface ReviewState {version:1;topology:string;revision:number;requests:ReviewRequest[]}
export type GitHubReviewApi=(method:'GET'|'POST'|'PATCH',resource:string,payload?:{body:string})=>Promise<unknown>;
const id=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>0;
const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>record(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

/** Narrow fixed REST routes. No Issue/reaction text enters a route or CLI flag. */
export const githubReviewApi:GitHubReviewApi=async(method,resource,payload)=>{
 const repository='[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*';
 const valid=method==='GET'?new RegExp(`^(?:user|repos/${repository}(?:/issues/comments/[1-9]\\d*(?:/reactions\\?per_page=100&page=[1-9]\\d?)?)?)$`).test(resource):method==='POST'?new RegExp(`^repos/${repository}/issues/[1-9]\\d*/comments$`).test(resource):new RegExp(`^repos/${repository}/issues/comments/[1-9]\\d*$`).test(resource);
 if(!valid||resource.split('/').some(value=>value==='.'||value==='..')||(method==='GET'?payload!==undefined:!exact(payload,['body'])||typeof payload.body!=='string'||payload.body.length>8192))throw new Error('review_api_rejected');
 return new Promise((resolve,reject)=>{
  const child=execFile('gh',['api','--hostname','github.com','--method',method,'-H','Accept: application/vnd.github+json',resource,...(payload?['--input','-']:[])],{cwd:homedir(),env:githubEnvironment(process.env),timeout:10000,maxBuffer:1048576,shell:false},(error,stdout)=>{
   if(error){reject(new Error('github_review_unavailable'));return;}try{resolve(JSON.parse(stdout));}catch{reject(new Error('github_review_unavailable'));}
  });child.stdin?.on('error',()=>{});child.stdin?.end(payload?JSON.stringify(payload):'');
 });
};
export function reviewComment(request:ReviewRequest):string {
 const labels:Record<ReviewStatus,string>={missing:'approval required',approved:'approved',stale:'stale',automatic:'automatic',automatic_retry_pending:'automatic retry',human_investigation_required:'verification failed / human investigation required',decision_required:'decision required',reevaluating:'reevaluating',non_approvable:'human investigation required / not approvable',scope_required:'explicit local E2E scope required'};
 const grantable=request.statuses.filter(item=>['missing','stale'].includes(item.status)&&approvableReasons.includes(item.reason)).map(item=>item.reason);
 return [`<!-- codex-worker-review: ${request.requestId} -->`,'Codex Worker Review','',`Scope: Issue #${request.issue} / ${request.bindings.diff?'current saved diff':'current Issue revision'}`,...request.statuses.map(item=>`- ${item.reason}: ${labels[item.status]}`),`- Worker: ${request.worker}`,...(request.check?[`- Check: ${request.check}`]:[]),...(request.e2e?[`Local E2E specs: ${request.e2e.specs.join(', ')}`,`Local E2E projects: ${request.e2e.projects.join(', ')} (retries=0)`]:[]),'',...(grantable.length?[`確認済みなら、この current request に 👍 を付けてください。承認対象: ${grantable.join(', ')}。`]:[]),...(request.reasons.includes('specification')?['仕様判断は Issue 本文へ記録してください。本文更新後の 👍 は保存作業の再評価トリガーであり、仕様の承認ではありません。']:[]),'operational blocker の承認操作は不要です。古い request の 👍 は再利用しません。'].join('\n');
}
export function parseReviewState(value:unknown,registry:Registry):ReviewState {
 if(!exact(value,['version','topology','revision','requests'])||value.version!==1||value.topology!==registryFingerprint(registry)||!Number.isSafeInteger(value.revision)||(value.revision as number)<0||!Array.isArray(value.requests)||value.requests.length>256)throw new Error('review_state_invalid');
 const seen=new Set<string>(),comments=new Set<number>(),requestIds=new Set<string>();
 const requests=value.requests.map(raw=>{
  if(!exact(raw,['requestId','repositoryId','issue','bindings','reasons','e2e','authorId','commentId','createdAt','ignoredReactionIds','published','statuses','worker','check','commands','baselineApprovalIds','reevaluation'])||!uuid(raw.requestId)||typeof raw.repositoryId!=='string'||!registry.repositories.some(repo=>repo.id===raw.repositoryId)||!id(raw.issue)||!id(raw.authorId)||(raw.commentId!==null&&!id(raw.commentId))||!Number.isSafeInteger(raw.createdAt)||(raw.createdAt as number)<0||typeof raw.published!=='boolean'||!['waiting','resuming','running','idle'].includes(String(raw.worker))||(raw.check!==null&&!checks.includes(String(raw.check)))||!Array.isArray(raw.reasons)||raw.reasons.length>categories.length||raw.reasons.some(reason=>typeof reason!=='string'||!categories.includes(reason))||new Set(raw.reasons).size!==raw.reasons.length||!Array.isArray(raw.ignoredReactionIds)||raw.ignoredReactionIds.length>1000||raw.ignoredReactionIds.some(value=>!id(value))||new Set(raw.ignoredReactionIds).size!==raw.ignoredReactionIds.length||!Array.isArray(raw.commands)||raw.commands.length>approvableReasons.length||!Array.isArray(raw.statuses)||raw.statuses.length!==raw.reasons.length||raw.statuses.some((item,index)=>!exact(item,['reason','status'])||item.reason!==(raw.reasons as unknown[])[index]||!states.includes(item.status as ReviewStatus)))throw new Error('review_state_invalid');
  if(!exact(raw.bindings,['issue',...(Object.hasOwn(raw.bindings??{},'diff')?['diff']:[])]))throw new Error('review_state_invalid');
  const binding=raw.bindings as {issue:Binding;diff?:Binding};
  if(binding.diff)parseRecovery(binding);else if(!exact(binding.issue,['kind','issueDigest'])||binding.issue.kind!=='issue'||!/^[a-f0-9]{64}$/.test(binding.issue.issueDigest))throw new Error('review_state_invalid');
  if(raw.e2e!==null)parseE2e(raw.e2e);
  const commandReasons=new Set<string>();
  for(const command of raw.commands){const parsed=parseApproval(command,registry);if(parsed.repositoryId!==raw.repositoryId||parsed.issue!==raw.issue||!raw.reasons.includes(parsed.reason)||commandReasons.has(parsed.reason)||!same(parsed.e2e,parsed.reason==='manual_e2e'?raw.e2e:null))throw new Error('review_state_invalid');commandReasons.add(parsed.reason);}
  if(!Array.isArray(raw.baselineApprovalIds)||raw.baselineApprovalIds.length>approvableReasons.length||raw.baselineApprovalIds.some(item=>!exact(item,['reason','requestId'])||typeof item.reason!=='string'||!approvableReasons.includes(item.reason)||!(raw.reasons as unknown[]).includes(item.reason)||(item.requestId!==null&&!uuid(item.requestId)))||new Set(raw.baselineApprovalIds.map(item=>item.reason)).size!==raw.baselineApprovalIds.length)throw new Error('review_state_invalid');
  if(raw.reevaluation!==null){const trigger=parseReevaluation(raw.reevaluation);if(!raw.reasons.includes('specification')||trigger.requestId!==raw.requestId||(!same(trigger.issue,binding.issue)&&trigger.previousIssueDigest!==(binding.issue as {issueDigest:string}).issueDigest)||!same(trigger.diff,binding.diff??null))throw new Error('review_state_invalid');}
  const key=`${raw.repositoryId}:${raw.issue}`;if(requestIds.has(raw.requestId as string)||seen.has(key)||raw.commentId!==null&&comments.has(raw.commentId as number))throw new Error('review_state_invalid');seen.add(key);requestIds.add(raw.requestId as string);if(raw.commentId!==null)comments.add(raw.commentId as number);
  return raw as unknown as ReviewRequest;
 });
 return {version:1,topology:registryFingerprint(registry),revision:value.revision as number,requests};
}
async function loadState(directory:string,registry:Registry):Promise<ReviewState> {
 try {const path=join(directory,'github-reviews.json');const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)throw new Error('review_state_unsafe');return parseReviewState((await readPrivateJson(path)).value,registry);}
 catch(error){if(error instanceof Error&&'code' in error&&error.code==='ENOENT')return {version:1,topology:registryFingerprint(registry),revision:0,requests:[]};throw error;}
}
export async function readReevaluation(directory:string,registry:Registry,repositoryId:string,issue:number):Promise<Reevaluation|undefined> {
 const request=(await loadState(directory,registry)).requests.find(item=>item.repositoryId===repositoryId&&item.issue===issue);
 if(!request?.published) return undefined;
 const trigger=request.reevaluation;if(!trigger)return undefined;
 const repo=registry.repositories.find(item=>item.id===repositoryId)!;
 const raw=(await readPrivateJson(join(repo.stateDirectory,'state.json'))).value;
 if(!record(raw))throw new Error('review_worker_unavailable');
 const parked=Array.isArray(raw.humanWaiting)?raw.humanWaiting.filter(record).find(item=>record(item.current)&&item.current.number===issue):undefined;
 const current=parked?.current??raw.current;
 return record(current)&&current.number===issue&&pendingReasons(current).includes('specification')&&current.processedSpecificationDigest!==trigger.issue.issueDigest?trigger:undefined;
}
export async function readReviewBinding(directory:string,registry:Registry,repositoryId:string,issue:number):Promise<ReturnType<typeof parseReviewBinding>|undefined> {
 const request=(await loadState(directory,registry)).requests.find(item=>item.repositoryId===repositoryId&&item.issue===issue);
 if(!request)return undefined;
 if(!request.published||!request.statuses.every(item=>['approved','automatic','automatic_retry_pending','reevaluating'].includes(item.status)))throw new Error('review_not_authorized');
 return parseReviewBinding({issue:request.reevaluation?.issue??request.bindings.issue,diff:request.bindings.diff??null});
}
export class GitHubReviews {
 private registry:Registry;private controller:Controller;private approvals:Approvals;private api:GitHubReviewApi;private state:ReviewState;private ticking:Promise<void>|null=null;private clock:()=>number;private timer:ReturnType<typeof setTimeout>|undefined;private stopped=false;
 private constructor(registry:Registry,controller:Controller,approvals:Approvals,state:ReviewState,api:GitHubReviewApi,clock:()=>number){this.registry=registry;this.controller=controller;this.approvals=approvals;this.state=state;this.api=api;this.clock=clock;}
 static async create(registry:Registry,controller:Controller,approvals:Approvals,options:{api?:GitHubReviewApi;now?:()=>number}={}):Promise<GitHubReviews>{
  const state=await loadState(controller.directoryPath(),registry);if(state.requests.some(item=>!item.published||item.commentId===null))throw new Error('review_state_uncertain');
  return new GitHubReviews(registry,controller,approvals,state,options.api??githubReviewApi,options.now??Date.now);
 }
 private async save(request:ReviewRequest){
  await this.controller.dispatchGate(async()=>{
   const next:ReviewState={...this.state,revision:this.state.revision+1,requests:[...this.state.requests.filter(item=>item.repositoryId!==request.repositoryId||item.issue!==request.issue),structuredClone(request)]};parseReviewState(next,this.registry);if(Buffer.byteLength(JSON.stringify(next))>1048576)throw new Error('review_history_full');
   const directory=this.controller.directoryPath(),temporary=join(directory,randomUUID()+'.tmp');
   try{const file=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{await file.writeFile(JSON.stringify(next));await file.sync();}finally{await file.close();}await rename(temporary,join(directory,'github-reviews.json'));const parent=await open(directory,constants.O_RDONLY);try{await parent.sync();}finally{await parent.close();}this.state=next;}
   catch{this.controller.storageUncertain();throw new Error('review_storage_uncertain');}finally{await unlink(temporary).catch(()=>{});}
  });
 }
 private async reactions(repo:Repository,commentId:number):Promise<{id:number;actorId:number;at:number;content:string}[]> {
  const reactions=[];
  for(let page=1;page<=10;page++){
   const raw=await this.api('GET',`repos/${repo.repo}/issues/comments/${commentId}/reactions?per_page=100&page=${page}`);
   if(!Array.isArray(raw)||raw.length>100)throw new Error('review_reactions_unavailable');
   for(const reaction of raw){if(!record(reaction)||!id(reaction.id)||!record(reaction.user)||!id(reaction.user.id)||typeof reaction.created_at!=='string'||!Number.isFinite(Date.parse(reaction.created_at))||typeof reaction.content!=='string')throw new Error('review_reactions_unavailable');reactions.push({id:reaction.id,actorId:reaction.user.id,at:Date.parse(reaction.created_at),content:reaction.content});}
   if(raw.length<100){if(new Set(reactions.map(r=>r.id)).size!==reactions.length)throw new Error('review_reactions_unavailable');return reactions;}
  }throw new Error('review_reactions_unavailable');
 }
 private comment(value:unknown,repo:Repository,request:ReviewRequest){
  if(!record(value)||!id(value.id)||request.commentId!==null&&value.id!==request.commentId||!record(value.user)||value.user.id!==request.authorId||value.issue_url!==`https://api.github.com/repos/${repo.repo}/issues/${request.issue}`||value.body!==reviewComment(request))throw new Error('review_comment_untrusted');return value.id;
 }
 private async publish(repo:Repository,request:ReviewRequest,issued=false){
  request.published=false;await this.save(request);
  try{
   const response=await this.api(request.commentId===null?'POST':'PATCH',request.commentId===null?`repos/${repo.repo}/issues/${request.issue}/comments`:`repos/${repo.repo}/issues/comments/${request.commentId}`,{body:reviewComment(request)});
   request.commentId=this.comment(response,repo,request);if(issued)request.createdAt=this.clock();request.published=true;await this.save(request);
  }catch{this.controller.storageUncertain();throw new Error('review_publication_uncertain');}
 }
 private async identity(repo:Repository){
  const repository=await this.api('GET',`repos/${repo.repo}`),actor=await this.api('GET','user');
  if(!record(repository)||repository.full_name!==repo.repo||!record(repository.owner)||!id(repository.owner.id)||typeof repository.owner.type!=='string'||!record(actor)||!id(actor.id))throw new Error('review_identity_unavailable');
  return {authorId:actor.id,reviewerIds:[...(repository.owner.type==='User'?[repository.owner.id]:[]),...(repo.githubReview?.reviewerIds??[])]};
 }
 private async statuses(repo:Repository,job:Job,scope:Awaited<ReturnType<Approvals['scope']>>,request?:Pick<ReviewRequest,'baselineApprovalIds'>):Promise<ReviewRequest['statuses']>{
  const projected=await this.approvals.project({schemaVersion:1,generatedAt:new Date(this.clock()).toISOString(),mode:'observe-only',controller:this.controller.view(),repositories:[{id:repo.id,repo:repo.repo,current:job,status:'needs-human',humanWaiting:[]}]} as unknown as Snapshot);
  const approvals=projected.repositories[0]!.current!.approvals??[];
  const result:ReviewRequest['statuses']=scope.reasons.map(reason=>({reason,status:approvableReasons.includes(reason)?approvals.find(item=>item.reason===reason)?.status==='automatic'?'automatic':reason==='manual_e2e'&&scope.profile!=='care-record-v1'?'non_approvable':reason==='manual_e2e'&&!repo.githubReview?.e2e?'scope_required':approvals.find(item=>item.reason===reason)?.status??'missing':operationalReasons.includes(reason)?recoveryState(scope.current)??'human_investigation_required':reason==='specification'?'decision_required':'non_approvable'}));
  for(const item of result){const baseline=request?.baselineApprovalIds.find(entry=>entry.reason===item.reason);if(item.status==='approved'&&baseline&&this.approvals.latestId(repo.id,job.issue,item.reason)===baseline.requestId)item.status='stale';}
  return result;
 }
 private async renew(repo:Repository,job:Job,scope:Awaited<ReturnType<Approvals['scope']>>,old?:ReviewRequest,reevaluation?:Reevaluation){
  const identity=await this.identity(repo);
  if(old){const raw=await this.api('GET',`repos/${repo.repo}/issues/comments/${old.commentId}`);this.comment(raw,repo,old);if(old.authorId!==identity.authorId)throw new Error('review_author_changed');}
  const ignored=old?(await this.reactions(repo,old.commentId!)).map(item=>item.id):[];
  const baselineApprovalIds=old?scope.reasons.filter(reason=>approvableReasons.includes(reason)).map(reason=>({reason,requestId:this.approvals.latestId(repo.id,job.issue,reason)})):[];
  const request:ReviewRequest={requestId:randomUUID(),repositoryId:repo.id,issue:job.issue,bindings:scope.bindings,reasons:scope.reasons,e2e:scope.profile==='care-record-v1'&&scope.reasons.includes('manual_e2e')&&repo.githubReview?.e2e?parseE2e(repo.githubReview.e2e):null,authorId:identity.authorId,commentId:old?.commentId??null,createdAt:this.clock(),ignoredReactionIds:ignored,published:false,statuses:await this.statuses(repo,job,scope,{baselineApprovalIds}),worker:'waiting',check:job.check,commands:[],baselineApprovalIds,reevaluation:null};
  if(reevaluation){request.reevaluation=parseReevaluation({...reevaluation,requestId:request.requestId});for(const item of request.statuses)if(item.reason==='specification')item.status='reevaluating';}
  await this.publish(repo,request,true);return request;
 }
 tick(snapshot:Snapshot):Promise<void>{if(this.stopped)return Promise.resolve();if(this.ticking)return this.ticking;this.ticking=this.step(snapshot).finally(()=>{this.ticking=null;});return this.ticking;}
 private async step(snapshot:Snapshot){
  const active=this.controller.view().scheduler?.active;
  if(active){
   const stored=this.state.requests.find(item=>item.repositoryId===active.repositoryId&&item.issue===active.issue);
   const repo=this.registry.repositories.find(item=>item.id===active.repositoryId);
   if(stored&&repo&&stored.worker!=='running'){this.comment(await this.api('GET',`repos/${repo.repo}/issues/comments/${stored.commentId}`),repo,stored);await this.publish(repo,{...stored,worker:'running'});}
   return;
  }
  for(const repo of this.registry.repositories){
   const observed=snapshot.repositories.find(item=>item.id===repo.id&&item.repo===repo.repo);if(!observed||observed.freshness==='unavailable')continue;
   const jobs=[...(observed.status==='needs-human'&&observed.current?[observed.current]:[]),...(observed.humanWaiting??[]).map(entry=>entry.job)];
   for(const job of jobs){
    if(this.stopped)return;
    let scope:Awaited<ReturnType<Approvals['scope']>>;try{scope=await this.approvals.scope(repo,job.issue);}catch(error){if(error instanceof ControlError&&error.message==='approval_requires_managed_repository')continue;throw new Error('review_scope_unavailable');}
    if(!scope.reasons.length)continue;
    let request=this.state.requests.find(item=>item.repositoryId===repo.id&&item.issue===job.issue);
    if(!request){await this.renew(repo,job,scope);continue;}
    if(!request.published||request.commentId===null)throw new Error('review_state_uncertain');
    const identity=await this.identity(repo);this.comment(await this.api('GET',`repos/${repo.repo}/issues/comments/${request.commentId}`),repo,request);
    if(identity.authorId!==request.authorId)throw new Error('review_author_changed');
    const spec=request.reasons.includes('specification');
    const diffMatches=same(request.bindings.diff,scope.bindings.diff);
    const issueMatches=same(request.bindings.issue,scope.bindings.issue);
    const consumed=request.reevaluation&&scope.current.processedSpecificationDigest===request.reevaluation.issue.issueDigest;
    if(!diffMatches||!same(request.reasons,scope.reasons)||consumed||!issueMatches&&!spec){await this.renew(repo,job,scope,request);continue;}
    if(request.reevaluation&&!same(request.reevaluation.issue,scope.bindings.issue)){await this.renew(repo,job,scope,request);continue;}
    const reactions=await this.reactions(repo,request.commentId);
    const accepted=reactions.some(item=>item.content==='+1'&&identity.reviewerIds.includes(item.actorId)&&!request!.ignoredReactionIds.includes(item.id)&&item.at>request!.createdAt&&(!spec||issueMatches||scope.issueUpdatedAt!==null&&item.at>scope.issueUpdatedAt));
    if(accepted){
     if(spec&&!issueMatches&&!request.reevaluation){
      const trigger=parseReevaluation({requestId:request.requestId,issue:scope.bindings.issue,previousIssueDigest:(request.bindings.issue as {issueDigest:string}).issueDigest,diff:scope.bindings.diff??null});
      if(scope.reasons.some(reason=>approvableReasons.includes(reason))){await this.renew(repo,job,scope,request,trigger);continue;}
      request=structuredClone(request);request.reevaluation=trigger;await this.save(request);
     }else if(issueMatches){
      for(const status of request.statuses.filter(item=>approvableReasons.includes(item.reason)&&['missing','stale'].includes(item.status))){
       let command=request.commands.find(item=>item.reason===status.reason);
       if(!command){command={requestId:randomUUID(),expectedRevision:this.approvals.revision(),repositoryId:repo.id,issue:job.issue,reason:status.reason,e2e:status.reason==='manual_e2e'?request.e2e:null};request=structuredClone(request);request.commands.push(command);await this.save(request);}
       if(!this.approvals.ack(command.requestId)){try{await this.approvals.apply(command,request.bindings);}catch(error){if(error instanceof ControlError&&error.message==='revision_conflict'){request=structuredClone(request);request.commands=request.commands.filter(item=>item.requestId!==command!.requestId);await this.save(request);}throw error;}}
      }
     }
    }
    const fresh=await this.approvals.scope(repo,job.issue);
    if(!same(fresh.bindings,scope.bindings))throw new Error('review_scope_changed');
    const statuses=await this.statuses(repo,job,fresh,request);
    if(request.reevaluation)for(const item of statuses)if(item.reason==='specification')item.status='reevaluating';
    const ready=statuses.every(item=>['approved','automatic','automatic_retry_pending','reevaluating'].includes(item.status));
    if(!same(statuses,request.statuses)||request.worker!==(ready?'resuming':'waiting')){request=structuredClone(request);request.statuses=statuses;request.worker=ready?'resuming':'waiting';await this.publish(repo,request);}
   }
   for(const stored of this.state.requests.filter(item=>item.repositoryId===repo.id&&!jobs.some(job=>job.issue===item.issue))){
    const worker:Worker=observed.current?.issue===stored.issue&&observed.status==='running'?'running':'idle';
    if(stored.worker===worker)continue;
    this.comment(await this.api('GET',`repos/${repo.repo}/issues/comments/${stored.commentId}`),repo,stored);
    await this.publish(repo,{...stored,worker});
   }
  }
 }
 start(snapshot:()=>Promise<Snapshot>):void{
  if(this.timer||this.stopped)return;
  const poll=async()=>{try{await this.tick(await snapshot());}catch{/* Fixed state and gates retain uncertainty; no authorization fallback. */}finally{if(!this.stopped)this.timer=setTimeout(()=>{void poll();},30000);}};
  this.timer=setTimeout(()=>{void poll();},30000);
 }
 async close():Promise<void>{this.stopped=true;if(this.timer)clearTimeout(this.timer);await this.ticking?.catch(()=>{});}
 async project(snapshot:Snapshot):Promise<Snapshot>{
  const value=structuredClone(snapshot);
  for(const repo of value.repositories){const configured=this.registry.repositories.find(item=>item.id===repo.id)!;for(const job of [...(repo.current?[repo.current]:[]),...(repo.humanWaiting??[]).map(item=>item.job)]){
   const request=this.state.requests.find(item=>item.repositoryId===repo.id&&item.issue===job.issue);if(!request)continue;
   try{const scope=await this.approvals.scope(configured,job.issue);
    const statuses=await this.statuses(configured,job,scope,request);job.githubReviewReady=request.published&&same(request.reevaluation?.issue??request.bindings.issue,scope.bindings.issue)&&same(request.bindings.diff,scope.bindings.diff)&&statuses.every(item=>item.status==='approved'||item.status==='automatic'||item.status==='automatic_retry_pending'||item.reason==='specification'&&request.reevaluation&&scope.current.processedSpecificationDigest!==request.reevaluation.issue.issueDigest);
    if(request.reevaluation)job.reevaluationReady=same(request.reevaluation.issue,scope.bindings.issue)&&same(request.reevaluation.diff,scope.bindings.diff??null)&&scope.current.processedSpecificationDigest!==request.reevaluation.issue.issueDigest;}catch{job.githubReviewReady=false;job.reevaluationReady=false;}
  }}return value;
 }
}
