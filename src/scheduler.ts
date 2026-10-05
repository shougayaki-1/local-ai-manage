import { isWorkerProfile } from './profiles.ts';
import { constants } from 'node:fs';
import { open, rename, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Controller } from './controller.ts';
import { readPrivateJson } from './snapshot.ts';
import { record } from './registry.ts';
import { registryFingerprint, parseHandoff } from './handoff.ts';
import { dispatchOnce, parseOutcome, type DispatchOutcome, type Handoff } from './worker-adapter.ts';
import type { Registry, Snapshot, ControllerView, ControlRequest, ControlAck, SchedulerView, SchedulerReason } from './types.ts';
interface State {nextDispatchAt:number;version:2;cooldowns:Record<string,number>;topology:string;cursor:number;phase:'idle'|'reserved'|'blocked';active:{repositoryId:string;issue:number}[];nextRetryAt:number|null;reason:SchedulerReason}
interface Options {registry:Registry;controller:Controller;handoffs:Handoff[];snapshot:()=>Promise<Snapshot>;now?:()=>number;dispatch?:(repositoryId:string,issue:number,handoff:Handoff)=>Promise<DispatchOutcome>}
const reasons:SchedulerReason[]=['idle','running','shared_quota_wait','reconciliation_required','storage_uncertain','dispatch_unavailable'];
export class Scheduler {
 private options:Options;private state:State;private ticking:Promise<void>|null=null;private jobs=new Map<string,Promise<void>>();
 private timer:ReturnType<typeof setTimeout>|undefined;private stopped=false;private closing=false;private started=false;private reason:SchedulerReason='idle';
 private constructor(options:Options,state:State) {this.options=options;this.state=state;options.controller.attachRuntime({view:()=>this.view(),application:command=>this.application(command)});}
 static async create(options:Options):Promise<Scheduler> {
  const topology=registryFingerprint(options.registry);const ids=options.registry.repositories.map(repo=>repo.id);
  if(!options.handoffs.length || options.handoffs.some(item=>!ids.includes(item.repositoryId) || !isWorkerProfile(item.profile) || item.standaloneStopped!==true || item.scope!=='all-registered-workers') || new Set(options.handoffs.map(item=>item.repositoryId)).size!==options.handoffs.length)throw new Error('invalid_scheduler_handoff');
  parseHandoff({version:1,registryFingerprint:topology,standaloneStopped:true,scope:'all-registered-workers',repositories:options.handoffs.map(item=>({repositoryId:item.repositoryId,profile:item.profile}))},options.registry);
  let state:State={nextDispatchAt:0,version:2,cooldowns:{},topology,cursor:0,phase:'idle',active:[],nextRetryAt:null,reason:'idle'};
  try {
   const raw=(await readPrivateJson(join(options.controller.directoryPath(),'scheduler.json'))).value;
   if(!record(raw))throw new Error('invalid_scheduler_state');
   const value=raw.version===1?{...raw,version:2,cooldowns:{},active:raw.active===null?[]:[raw.active]}:raw;
   if(Object.keys(value).length!==9 || !Number.isSafeInteger(value.nextDispatchAt)||(value.nextDispatchAt as number)<0 || value.version!==2 || value.topology!==topology || !Number.isSafeInteger(value.cursor) || (value.cursor as number)<0 || (value.cursor as number)>=Math.max(ids.length,1) || typeof value.phase!=='string' || !['idle','reserved','blocked'].includes(value.phase) || !reasons.includes(value.reason as SchedulerReason) || (value.nextRetryAt!==null&&(!Number.isSafeInteger(value.nextRetryAt)||((value.nextRetryAt as number)<0||(value.nextRetryAt as number)>8.64e15))) || !Array.isArray(value.active) || value.active.length>ids.length || value.active.some(item=>!record(item)||Object.keys(item).length!==2||typeof item.repositoryId!=='string'||!ids.includes(item.repositoryId)||!Number.isSafeInteger(item.issue)||(item.issue as number)<=0) || new Set(value.active.map(item=>item.repositoryId)).size!==value.active.length || !record(value.cooldowns) || Object.entries(value.cooldowns).some(([id,time])=>!ids.includes(id)||!Number.isSafeInteger(time)||(time as number)<0) || (value.phase==='idle'&&value.active.length!==0) || (value.phase==='reserved'&&value.active.length===0))throw new Error('invalid_scheduler_state');
   state=value as unknown as State;
  }catch(error){if(!(error instanceof Error)||!('code' in error)||error.code!=='ENOENT')throw error;}
  // A reviewed offline rotation retains known shared quota even when a worker state
  // no longer records it. Unknown reset remains blocked rather than resetting usage.
  try {
   const quota=(await readPrivateJson(join(options.controller.directoryPath(),'recovery-quota.json'))).value;
   if(!record(quota)||Object.keys(quota).length!==4||quota.version!==1||quota.topology!==topology||typeof quota.unknown!=='boolean'||(quota.nextRetryAt!==null&&(!Number.isSafeInteger(quota.nextRetryAt)||(quota.nextRetryAt as number)<0||(quota.nextRetryAt as number)>8.64e15)))throw new Error('invalid_recovery_quota');
   if(quota.nextRetryAt!==null)state.nextRetryAt=Math.max(state.nextRetryAt??0,quota.nextRetryAt as number);
   if(quota.unknown){state.phase='blocked';state.reason='shared_quota_wait';}
  }catch(error){if(!(error instanceof Error)||!('code' in error)||error.code!=='ENOENT')throw error;}
  // A reserved slot after a crash is never reconciled from PID or lock absence.
  if(state.phase==='reserved'||state.active.length){state.phase='blocked';state.reason='reconciliation_required';}
  for(const name of ['dispatch.lock','dispatch-admission.lock',...ids.map(id=>`dispatch.${id}.lock`)]) {
   try{await lstat(join(options.controller.directoryPath(),name));state.phase='blocked';state.reason='reconciliation_required';}
   catch(error){if(!(error instanceof Error)||!('code' in error)||error.code!=='ENOENT')throw error;}
  }
  const scheduler=new Scheduler(options,state);await scheduler.persist(state);return scheduler;
 }
 private now():number{return (this.options.now??Date.now)();}
 private async persist(state:State):Promise<void> {
  const directory=this.options.controller.directoryPath();const path=join(directory,randomUUID()+'.tmp');const handle=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{await handle.writeFile(JSON.stringify(state));await handle.sync();}finally{await handle.close();}
  try{await rename(path,join(directory,'scheduler.json'));const parent=await open(directory,constants.O_RDONLY);try{await parent.sync();}finally{await parent.close();}}
  finally{await unlink(path).catch(()=>{});}
 }
 private preferences():ControllerView {
  // Avoid calling controller.view here: it calls back into scheduler.view.
  return this.options.controller.preferences();
 }
 view():SchedulerView {
  const prefs=this.preferences();const active=this.state.active[0]??null;
  const draining=this.jobs.size>0&&(this.closing||prefs.paused||this.state.active.some(job=>{const target=prefs.repositories?.find(item=>item.id===job.repositoryId);return target?.paused||target?.enabled===false;}));
  const status=this.state.phase==='blocked'?'blocked':draining?'draining':this.jobs.size?'running':this.closing||prefs.paused?'paused':'idle';
  return {status,reason:this.state.phase==='blocked'?this.state.reason:draining?'draining':this.jobs.size?'running':this.closing?'stopping':prefs.paused?'paused':this.reason,active:active?{...active}:null,activeJobs:this.state.active.map(item=>({...item})),managedRepositoryIds:this.options.handoffs.map(item=>item.repositoryId),nextRetryAt:this.state.nextRetryAt===null?null:new Date(this.state.nextRetryAt).toISOString()};
 }
 application(command:ControlRequest):NonNullable<ControlAck['application']> {
  const view=this.view();if(view.status==='blocked')return {status:'blocked',reason:view.reason};
  if(command.target!=='global'&&!view.managedRepositoryIds.includes(command.target))return {status:'not-managed',reason:'observe_only'};
  if((command.action==='pause'||command.action==='disable')&&this.jobs.size&&(command.target==='global'||this.jobs.has(command.target)))return {status:'draining',reason:'draining'};
  return {status:'applied',reason:command.action==='pause'?'paused':command.action==='disable'?'disabled':'idle'};
 }
 tick():Promise<void> {
  if(this.ticking)return this.ticking;
  this.ticking=this.step().catch(()=>{this.state.phase='blocked';this.state.reason='storage_uncertain';}).finally(()=>{this.ticking=null;});return this.ticking;
 }
 private async step():Promise<void> {
  if(this.stopped||this.closing||this.jobs.size>=this.options.registry.globalConcurrency||this.state.phase==='blocked')return;
  let snapshot:Snapshot;try{snapshot=await this.options.snapshot();}catch{this.reason='worker_state_unavailable';return;}
  await this.options.controller.dispatchGate(async prefs=>{
   if(this.stopped||this.closing||this.jobs.size>=this.options.registry.globalConcurrency||this.state.phase==='blocked'||prefs.paused)return;
   if(this.now()<this.state.nextDispatchAt){this.reason=this.state.nextRetryAt!==null&&this.now()<this.state.nextRetryAt?'shared_quota_wait':'idle';return;}
   if(this.state.nextRetryAt!==null&&this.now()<this.state.nextRetryAt){this.reason='shared_quota_wait';return;}
   // All registered worker state must be readable to establish the shared quota gate.
   if(snapshot.repositories.length!==this.options.registry.repositories.length||this.options.registry.repositories.some(repo=>!snapshot.repositories.some(item=>item.id===repo.id&&item.repo===repo.repo&&item.freshness!=='unavailable'))){this.reason='worker_state_unavailable';return;}
   for(const repo of snapshot.repositories) {
    const retry=repo.quota.nextRetryAt===null?null:Date.parse(repo.quota.nextRetryAt);
    if((retry!==null&&(!Number.isFinite(retry)||this.now()<retry))||(repo.quota.status==='waiting'&&retry===null)){this.reason='shared_quota_wait';return;}
   }
   const registry=this.options.registry;let selected:{repositoryId:string;issue:number;handoff:Handoff;index:number}|null=null;
   let skipped:SchedulerReason='idle';
   for(let offset=0;offset<registry.repositories.length;offset++) {
    const index=(this.state.cursor+offset)%registry.repositories.length;const configured=registry.repositories[index]!;
    const handoff=this.options.handoffs.find(item=>item.repositoryId===configured.id);const preference=prefs.repositories?.find(item=>item.id===configured.id);const repo=snapshot.repositories.find(item=>item.id===configured.id)!;
    if(this.jobs.has(configured.id)||this.now()<(this.state.cooldowns[configured.id]??0)||!handoff||!configured.enabled||!preference?.enabled||preference.paused)continue;
    const humanStop=repo.status==='needs-human'&&repo.paused===true&&repo.current!==null&&repo.current.stage!=='unknown'&&repo.quota.nextRetryAt===null;
    const reviewed=(job:NonNullable<typeof repo.current>)=>job.githubReviewReady!==false&&!!job.reasonCategories.length&&job.reasonCategories.every(reason=>reason==='specification'?job.reevaluationReady===true:['local_verification','sandbox_capability','verification_retry_limit'].includes(reason)?job.recovery==='automatic_retry_pending':job.approvals?.some(item=>item.reason===reason&&['approved','automatic'].includes(item.status)));
    if(humanStop&&repo.current&&!['automatic_verification_failed','verification_retry_exhausted','unsafe_or_unavailable_verification','parent_verification_safety_failed'].includes(repo.reason)&&(reviewed(repo.current)||(handoff.profile==='care-record-v1'&&repo.reason==='branch_deployment_not_disabled'&&repo.current.stage==='publish'&&repo.current.reasonCategories.length===1&&repo.current.reasonCategories[0]==='deploy'))){selected={repositoryId:repo.id,issue:repo.current.issue,handoff,index};break;}
    if((!repo.current&&repo.paused===false&&repo.status==='idle')||humanStop){const waiting=repo.humanWaiting?.find(entry=>!['automatic_verification_failed','verification_retry_exhausted','unsafe_or_unavailable_verification','parent_verification_safety_failed'].includes(entry.reason)&&reviewed(entry.job));if(waiting){selected={repositoryId:repo.id,issue:waiting.job.issue,handoff,index};break;}}
    if(!humanStop&&(repo.paused!==false||['needs-human','failed'].includes(repo.status))){skipped='needs_human';continue;}
    if(repo.current&&!humanStop) {if(repo.current.stage==='unknown'){skipped='worker_state_unavailable';continue;}selected={repositoryId:repo.id,issue:repo.current.issue,handoff,index};break;}
    const queue=snapshot.queue.repositories.find(item=>item.repositoryId===repo.id&&item.repo===repo.repo);
    const stamp=queue?.updatedAt?Date.parse(queue.updatedAt):NaN;
    if(!queue||!['observed','partial'].includes(queue.status)||!Number.isFinite(stamp)||this.now()-stamp>300_000||stamp>this.now()){skipped='queue_unverified';continue;}
    const order=['p0','p1','p2','p3','unspecified'];
    const ready=queue.items.filter(item=>item.repositoryId===repo.id&&item.repo===repo.repo&&item.status==='ready'&&item.reason==='eligible'&&(!humanStop||item.issue!==repo.current?.issue)&&!repo.humanWaiting?.some(waiting=>waiting.job.issue===item.issue)).sort((a,b)=>order.indexOf(a.priority)-order.indexOf(b.priority)||a.issue-b.issue)[0];
    if(!ready&&humanStop)skipped='needs_human';
    if(ready){selected={repositoryId:repo.id,issue:ready.issue,handoff,index};break;}
   }
   if(!selected){this.reason=skipped;return;}
   const next:State={...this.state,phase:'reserved',active:[...this.state.active,{repositoryId:selected.repositoryId,issue:selected.issue}],reason:'running',cursor:(selected.index+1)%registry.repositories.length,nextRetryAt:this.state.nextRetryAt};
   // The controller write lane makes preference checks + reservation indivisible
   // relative to Pause/Disable acceptance. Never hold that lane during worker execution.
   this.state=next;await this.persist(next);
   const selection=selected;
   const job=Promise.resolve().then(()=>this.execute(selection)).finally(()=>{this.jobs.delete(selection.repositoryId);});
   this.jobs.set(selection.repositoryId,job);
  });
 }
 private async execute(selected:{repositoryId:string;issue:number;handoff:Handoff}):Promise<void> {
  try {
   const raw=this.options.dispatch?await this.options.dispatch(selected.repositoryId,selected.issue,selected.handoff):await dispatchOnce({registry:this.options.registry,directory:this.options.controller.directoryPath(),repositoryId:selected.repositoryId,expectedIssue:selected.issue,handoff:selected.handoff,now:()=>this.now(),managedActiveRepositoryIds:[...this.jobs.keys()].filter(id=>id!==selected.repositoryId)});
   const outcome=parseOutcome(raw,selected.issue);
   await this.options.controller.dispatchGate(async()=>{
    const active=this.state.active.filter(item=>item.repositoryId!==selected.repositoryId);
    const quotaUnknown=outcome.status==='quota-wait'&&outcome.nextRetryAt===null;
    const next:State={...this.state,nextDispatchAt:this.options.registry.globalConcurrency===1?this.now()+30_000:0,cooldowns:{...this.state.cooldowns,[selected.repositoryId]:this.now()+30_000},phase:this.state.phase==='blocked'||quotaUnknown?'blocked':active.length?'reserved':'idle',active,nextRetryAt:outcome.nextRetryAt===null?this.state.nextRetryAt:Math.max(this.state.nextRetryAt??0,outcome.nextRetryAt),reason:this.state.phase==='blocked'?this.state.reason:outcome.status==='quota-wait'?'shared_quota_wait':'idle'};
    await this.persist(next);this.state=next;this.reason=next.reason;
   });
  }catch(error) {
   const quota=error instanceof Error&&error.message==='shared_quota_wait';
   try{await this.options.controller.dispatchGate(async()=>{
    const active=quota?this.state.active.filter(item=>item.repositoryId!==selected.repositoryId):this.state.active;
    const next:State={...this.state,active,phase:quota&&this.state.phase!=='blocked'?(active.length?'reserved':'idle'):'blocked',nextDispatchAt:this.now()+30_000,reason:quota?'shared_quota_wait':'dispatch_unavailable'};
    await this.persist(next);this.state=next;this.reason=next.reason;
   });}catch{this.state={...this.state,phase:'blocked',reason:'storage_uncertain'};}
  }
 }
 start():void {
  if(this.started||this.stopped||this.closing)throw new Error('scheduler_already_started');
  this.started=true;
  const loop=async()=>{await this.tick();if(!this.closing&&!this.stopped)this.timer=setTimeout(()=>{void loop();},1000);};void loop();
 }
 async settled():Promise<void>{await this.ticking;await Promise.all(this.jobs.values());}
 async close():Promise<void>{this.closing=true;clearTimeout(this.timer);await this.ticking;await Promise.all(this.jobs.values());this.stopped=true;}
}
