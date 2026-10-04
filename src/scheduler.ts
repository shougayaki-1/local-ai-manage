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
interface State {nextDispatchAt:number;version:1;topology:string;cursor:number;phase:'idle'|'reserved'|'blocked';active:{repositoryId:string;issue:number}|null;nextRetryAt:number|null;reason:SchedulerReason}
interface Options {registry:Registry;controller:Controller;handoffs:Handoff[];snapshot:()=>Promise<Snapshot>;now?:()=>number;dispatch?:(repositoryId:string,issue:number,handoff:Handoff)=>Promise<DispatchOutcome>}
const reasons:SchedulerReason[]=['idle','running','shared_quota_wait','reconciliation_required','storage_uncertain','dispatch_unavailable'];
export class Scheduler {
 private options:Options;private state:State;private ticking:Promise<void>|null=null;private job:Promise<void>|null=null;
 private timer:ReturnType<typeof setTimeout>|undefined;private stopped=false;private closing=false;private started=false;private reason:SchedulerReason='idle';
 private constructor(options:Options,state:State) {this.options=options;this.state=state;options.controller.attachRuntime({view:()=>this.view(),application:command=>this.application(command)});}
 static async create(options:Options):Promise<Scheduler> {
  const topology=registryFingerprint(options.registry);const ids=options.registry.repositories.map(repo=>repo.id);
  if(!options.handoffs.length || options.handoffs.some(item=>!ids.includes(item.repositoryId) || !isWorkerProfile(item.profile) || item.standaloneStopped!==true || item.scope!=='all-registered-workers') || new Set(options.handoffs.map(item=>item.repositoryId)).size!==options.handoffs.length)throw new Error('invalid_scheduler_handoff');
  parseHandoff({version:1,registryFingerprint:topology,standaloneStopped:true,scope:'all-registered-workers',repositories:options.handoffs.map(item=>({repositoryId:item.repositoryId,profile:item.profile}))},options.registry);
  let state:State={nextDispatchAt:0,version:1,topology,cursor:0,phase:'idle',active:null,nextRetryAt:null,reason:'idle'};
  try {
   const value=(await readPrivateJson(join(options.controller.directoryPath(),'scheduler.json'))).value;
   if(!record(value) || Object.keys(value).length!==8 || !Number.isSafeInteger(value.nextDispatchAt)||(value.nextDispatchAt as number)<0 || value.version!==1 || value.topology!==topology || !Number.isSafeInteger(value.cursor) || (value.cursor as number)<0 || (value.cursor as number)>=Math.max(ids.length,1) || typeof value.phase!=='string' || !['idle','reserved','blocked'].includes(value.phase) || !reasons.includes(value.reason as SchedulerReason) || (value.nextRetryAt!==null&&(!Number.isSafeInteger(value.nextRetryAt)||((value.nextRetryAt as number)<0||(value.nextRetryAt as number)>8.64e15))) || (value.active!==null&&(!record(value.active)||Object.keys(value.active).length!==2||typeof value.active.repositoryId!=='string'||!ids.includes(value.active.repositoryId)||!Number.isSafeInteger(value.active.issue)||(value.active.issue as number)<=0)) || (value.phase==='idle'&&value.active!==null) || (value.phase==='reserved'&&value.active===null))throw new Error('invalid_scheduler_state');
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
  if(state.phase==='reserved'){state.phase='blocked';state.reason='reconciliation_required';}
  try{await lstat(join(options.controller.directoryPath(),'dispatch.lock'));state.phase='blocked';state.reason='reconciliation_required';}
  catch(error){if(!(error instanceof Error)||!('code' in error)||error.code!=='ENOENT')throw error;}
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
  const prefs=this.preferences();const active=this.state.active;
  const target=active?prefs.repositories?.find(item=>item.id===active.repositoryId):null;
  const draining=!!this.job&&(this.closing||prefs.paused||target?.paused||target?.enabled===false);
  const status=this.state.phase==='blocked'?'blocked':draining?'draining':this.job?'running':this.closing||prefs.paused?'paused':'idle';
  return {status,reason:this.state.phase==='blocked'?this.state.reason:draining?'draining':this.job?'running':this.closing?'stopping':prefs.paused?'paused':this.reason,active:active?{...active}:null,managedRepositoryIds:this.options.handoffs.map(item=>item.repositoryId),nextRetryAt:this.state.nextRetryAt===null?null:new Date(this.state.nextRetryAt).toISOString()};
 }
 application(command:ControlRequest):NonNullable<ControlAck['application']> {
  const view=this.view();if(view.status==='blocked')return {status:'blocked',reason:view.reason};
  if(command.target!=='global'&&!view.managedRepositoryIds.includes(command.target))return {status:'not-managed',reason:'observe_only'};
  if((command.action==='pause'||command.action==='disable')&&this.job&&(command.target==='global'||command.target===view.active?.repositoryId))return {status:'draining',reason:'draining'};
  return {status:'applied',reason:command.action==='pause'?'paused':command.action==='disable'?'disabled':'idle'};
 }
 tick():Promise<void> {
  if(this.ticking)return this.ticking;
  this.ticking=this.step().catch(()=>{this.state.phase='blocked';this.state.reason='storage_uncertain';}).finally(()=>{this.ticking=null;});return this.ticking;
 }
 private async step():Promise<void> {
  if(this.stopped||this.closing||this.job||this.state.phase==='blocked')return;
  let snapshot:Snapshot;try{snapshot=await this.options.snapshot();}catch{this.reason='worker_state_unavailable';return;}
  await this.options.controller.dispatchGate(async prefs=>{
   if(this.stopped||this.closing||this.job||prefs.paused)return;
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
    if(!handoff||!configured.enabled||!preference?.enabled||preference.paused)continue;
    const humanStop=repo.status==='needs-human'&&repo.paused===true&&repo.current!==null&&repo.current.stage!=='unknown'&&repo.quota.nextRetryAt===null;
    const reviewed=(job:NonNullable<typeof repo.current>)=>!!job.approvals?.length&&job.approvals.every(item=>item.status==='approved');
    if(humanStop&&repo.current&&reviewed(repo.current)){selected={repositoryId:repo.id,issue:repo.current.issue,handoff,index};break;}
    if(!repo.current&&repo.paused===false&&repo.status==='idle'){const waiting=repo.humanWaiting?.find(entry=>reviewed(entry.job));if(waiting){selected={repositoryId:repo.id,issue:waiting.job.issue,handoff,index};break;}}
    if(!humanStop&&(repo.paused!==false||['needs-human','failed'].includes(repo.status))){skipped='needs_human';continue;}
    if(repo.current&&!humanStop) {if(repo.current.stage==='unknown'){skipped='worker_state_unavailable';continue;}selected={repositoryId:repo.id,issue:repo.current.issue,handoff,index};break;}
    const queue=snapshot.queue.repositories.find(item=>item.repositoryId===repo.id&&item.repo===repo.repo);
    const stamp=queue?.updatedAt?Date.parse(queue.updatedAt):NaN;
    if(!queue||queue.status!=='observed'||!Number.isFinite(stamp)||this.now()-stamp>300_000||stamp>this.now()){skipped='queue_unverified';continue;}
    const order=['p0','p1','p2','p3','unspecified'];
    const ready=queue.items.filter(item=>item.repositoryId===repo.id&&item.repo===repo.repo&&item.status==='ready'&&item.reason==='eligible'&&(!humanStop||item.issue!==repo.current?.issue)&&!repo.humanWaiting?.some(waiting=>waiting.job.issue===item.issue)).sort((a,b)=>order.indexOf(a.priority)-order.indexOf(b.priority)||a.issue-b.issue)[0];
    if(!ready&&humanStop)skipped='needs_human';
    if(ready){selected={repositoryId:repo.id,issue:ready.issue,handoff,index};break;}
   }
   if(!selected){this.reason=skipped;return;}
   const next:State={...this.state,phase:'reserved',active:{repositoryId:selected.repositoryId,issue:selected.issue},reason:'running',cursor:(selected.index+1)%registry.repositories.length,nextRetryAt:null};
   // The controller write lane makes preference checks + reservation indivisible
   // relative to Pause/Disable acceptance. Never hold that lane during worker execution.
   this.state=next;await this.persist(next);
   const selection=selected;
   this.job=Promise.resolve().then(()=>this.execute(selection)).finally(()=>{this.job=null;});
  });
 }
 private async execute(selected:{repositoryId:string;issue:number;handoff:Handoff}):Promise<void> {
  try {
   const raw=this.options.dispatch?await this.options.dispatch(selected.repositoryId,selected.issue,selected.handoff):await dispatchOnce({registry:this.options.registry,directory:this.options.controller.directoryPath(),repositoryId:selected.repositoryId,expectedIssue:selected.issue,handoff:selected.handoff,now:()=>this.now()});
   const outcome=parseOutcome(raw,selected.issue);
   const next:State={...this.state,nextDispatchAt:this.now()+30_000,phase:outcome.status==='quota-wait'&&outcome.nextRetryAt===null?'blocked':'idle',active:null,nextRetryAt:outcome.nextRetryAt,reason:outcome.status==='quota-wait'?'shared_quota_wait':'idle'};
   await this.persist(next);this.state=next;this.reason=next.reason;
  }catch(error) {
   if(error instanceof Error&&error.message==='shared_quota_wait'){const next:State={...this.state,phase:'idle',active:null,nextDispatchAt:this.now()+30_000,reason:'shared_quota_wait'};try{await this.persist(next);this.state=next;this.reason=next.reason;return;}catch{/* Keep reserved slot on persistence failure. */}}
   this.state={...this.state,phase:'blocked',reason:'dispatch_unavailable'};
   await this.persist(this.state).catch(()=>{this.state.reason='storage_uncertain';});
  }
 }
 start():void {
  if(this.started||this.stopped||this.closing)throw new Error('scheduler_already_started');
  this.started=true;
  const loop=async()=>{await this.tick();if(!this.closing&&!this.stopped)this.timer=setTimeout(()=>{void loop();},1000);};void loop();
 }
 async settled():Promise<void>{await this.ticking;await this.job;}
 async close():Promise<void>{this.closing=true;clearTimeout(this.timer);await this.ticking;await this.job;this.stopped=true;}
}
