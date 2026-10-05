import { isWorkerProfile, type WorkerProfile } from './profiles.ts';
import { assertRecoveryClear } from './recovery-guard.ts';
import { readApprovalGrants } from './approvals.ts';
import type { Grant } from './approval-policy.ts';
import { fork } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath, lstat, unlink, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, sep } from 'node:path';
import { record } from './registry.ts';
import { readPrivateJson } from './snapshot.ts';
import type { Registry, Repository } from './types.ts';
export interface DispatchOutcome {version:1;issue:number;status:'idle'|'running'|'quota-wait'|'needs-human'|'failed';paused:boolean;currentIssue:number|null;nextRetryAt:number|null}
export interface Handoff {repositoryId:string;profile:WorkerProfile;standaloneStopped:true;scope:'all-registered-workers'}
export function parseOutcome(value:unknown,issue:number):DispatchOutcome {
  const keys=['version','issue','status','paused','currentIssue','nextRetryAt'];
  if(!record(value) || Object.keys(value).length!==keys.length || !keys.every(key=>Object.hasOwn(value,key)) || value.version!==1 || value.issue!==issue || typeof value.status!=='string' || !['idle','running','quota-wait','needs-human','failed'].includes(value.status) || typeof value.paused!=='boolean' || (value.currentIssue!==null && (!Number.isSafeInteger(value.currentIssue) || (value.currentIssue as number)<=0)) || (value.nextRetryAt!==null && (!Number.isSafeInteger(value.nextRetryAt) || ((value.nextRetryAt as number)<0||(value.nextRetryAt as number)>8.64e15))))throw new Error('worker_outcome_invalid');
  return value as unknown as DispatchOutcome;
}
export function bridgeEnvironment(env:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv {
  // Only the trusted bridge receives both capabilities; inherited worker purpose filters
  // split these again into Codex, GitHub and credential-free build subprocesses.
  const names=['PATH','USER','LOGNAME','SHELL','LANG','LC_ALL','HOME','CODEX_HOME','TMPDIR','GH_TOKEN','GITHUB_TOKEN','GH_CONFIG_DIR','SSH_AUTH_SOCK','DBUS_SESSION_BUS_ADDRESS','XDG_RUNTIME_DIR'];
  return Object.fromEntries(names.filter(name=>typeof env[name]==='string').map(name=>[name,env[name]]));
}
export async function runTrustedWorker(repo:Repository,issue:number,profile:WorkerProfile='care-record-v1',grants:Grant[]=[]):Promise<DispatchOutcome> {
  if(!isWorkerProfile(profile))throw new Error('unsupported_profile');
  return new Promise((resolve,reject)=>{
    const child=fork(new URL(import.meta.url.endsWith('.ts')?'../engine/care-record/bridge.mjs':'../../engine/care-record/bridge.mjs',import.meta.url),[],{cwd:repo.clonePath,detached:process.platform!=='win32',execArgv:[],env:bridgeEnvironment(),stdio:['ignore','ignore','ignore','ipc']});
    let outcome:DispatchOutcome|null=null;let invalid=false;
    child.on('message',value=>{try{if(outcome)throw new Error('duplicate');outcome=parseOutcome(value,issue);}catch{invalid=true;}});
    child.once('error',()=>reject(new Error('worker_completion_unknown')));
    // Successful IPC alone is insufficient; wait for process and stdio closure.
    child.once('close',(code,signal)=>{if(code===0 && !signal && outcome && !invalid)resolve(outcome);else reject(new Error('worker_completion_unknown'));});
    child.send({version:1,profile,repo:repo.repo,clonePath:repo.clonePath,stateDirectory:repo.stateDirectory,expectedIssue:issue,...(repo.reviewPolicy==='local-automatic'?{reviewPolicy:repo.reviewPolicy}:{}),...(grants.length?{approval:{repositoryId:repo.id,repo:repo.repo,grants}}:{})},error=>{if(error)reject(new Error('worker_completion_unknown'));});
  });
}
interface Reservation {version:1;status:'reserved'|'settled';repositoryId:string;issue:number;reservationId:string;outcome:DispatchOutcome|null}
async function persist(directory:string,value:Reservation,journal='dispatch.json') {
  const temporary=join(directory,randomUUID()+'.tmp');const file=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{await file.writeFile(JSON.stringify(value));await file.sync();}finally{await file.close();}
  try{await rename(temporary,join(directory,journal));const handle=await open(directory,constants.O_RDONLY);try{await handle.sync();}finally{await handle.close();}}
  finally{await unlink(temporary).catch(()=>{});}
}
/** Internal controller boundary, deliberately absent from HTTP/launcher. Handoff is
 * a trusted administrator attestation, never inferred from an absent worker.lock. */
interface DispatchOptions {registry:Registry;directory:string;handoff:Handoff;repositoryId:string;expectedIssue:number;now?:()=>number;run?:(repo:Repository,issue:number)=>Promise<DispatchOutcome>;managedActiveRepositoryIds?:string[]}
export async function dispatchOnce(options:DispatchOptions):Promise<DispatchOutcome> {
 if(options.registry.globalConcurrency>1)return dispatchParallel(options);
 try{await lstat(join(options.directory,'dispatch-admission.lock'));throw new Error('dispatch_reconciliation_required');}catch(error){if(!(error instanceof Error)||!('code' in error)||error.code!=='ENOENT')throw error;}
 // A reduction in concurrency never hides reservations made by the parallel adapter.
 for(const repo of options.registry.repositories){
  try{await lstat(join(options.directory,`dispatch.${repo.id}.lock`));throw new Error('dispatch_reconciliation_required');}
  catch(error){if(!(error instanceof Error)||!('code' in error)||error.code!=='ENOENT')throw error;}
  try{const prior=(await readPrivateJson(join(options.directory,`dispatch.${repo.id}.json`))).value;if(!record(prior)||prior.status!=='settled')throw new Error('dispatch_reconciliation_required');const result=parseOutcome(prior.outcome,prior.issue as number);if(result.status==='quota-wait'&&(result.nextRetryAt===null||(options.now??Date.now)()<result.nextRetryAt))throw new Error('shared_quota_wait');}
  catch(error){if(!(error instanceof Error)||!('code' in error)||error.code!=='ENOENT')throw error;}
 }
 return dispatchInLane(options);
}
async function dispatchInLane({registry,directory,handoff,repositoryId,expectedIssue,now=Date.now,run}:DispatchOptions,journal='dispatch.json',lockName='dispatch.lock',active:string[]=[]):Promise<DispatchOutcome> {
  const repo=registry.repositories.find(item=>item.id===repositoryId);
  if(!repo || !repo.enabled || !record(handoff) || Object.keys(handoff).length!==4 || handoff.scope!=='all-registered-workers' || handoff.repositoryId!==repo.id || !isWorkerProfile(handoff.profile) || handoff.standaloneStopped!==true || !Number.isSafeInteger(expectedIssue) || expectedIssue<=0 || repo.defaultModel!=='gpt-6.1-sol' || repo.defaultEffort!=='medium')throw new Error('dispatch_not_authorized');
  const info=await lstat(directory);const root=await realpath(directory);
  if(!info.isDirectory() || info.isSymbolicLink() || info.uid!==process.getuid?.() || (info.mode&0o077)!==0 || registry.repositories.flatMap(item=>[item.clonePath,item.stateDirectory]).some(path=>root===path || root.startsWith(path+sep) || path.startsWith(root+sep)))throw new Error('dispatch_directory_unsafe');
  await assertRecoveryClear(root);
  const lock=await open(join(root,lockName),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  let reserved=false;
  try {
    await assertRecoveryClear(root);
    await lock.writeFile(JSON.stringify({version:1,reservationId:randomUUID()}));await lock.sync();
    try {
      const prior=(await readPrivateJson(join(root,journal))).value;
      if(!record(prior) || Object.keys(prior).length!==6 || prior.version!==1 || prior.status!=='settled' || typeof prior.repositoryId!=='string' || !registry.repositories.some(item=>item.id===prior.repositoryId) || !Number.isSafeInteger(prior.issue) || typeof prior.reservationId!=='string'){reserved=true;throw new Error('dispatch_reconciliation_required');}
      const previous=parseOutcome(prior.outcome,prior.issue as number);
      if(previous.status==='quota-wait' && (previous.nextRetryAt===null || now()<previous.nextRetryAt))throw new Error('shared_quota_wait');
    } catch(error) {if(!(error instanceof Error) || !('code' in error) || error.code!=='ENOENT')throw error;}
    // Any legacy lock, including another observed repository, blocks global execution.
    for(const registered of registry.repositories) {
      try{await lstat(join(registered.stateDirectory,'worker.lock'));if(active.includes(registered.id))continue;throw new Error('standalone_worker_lock');}
      catch(error){if(!(error instanceof Error) || !('code' in error) || error.code!=='ENOENT')throw error;}
    }
    for(const registered of registry.repositories) {
      try {const state=(await readPrivateJson(join(registered.stateDirectory,'state.json'))).value;
        if(!record(state) || state.version!==1 || (state.repo!==null && state.repo!==registered.repo) || typeof state.status!=='string' || !['idle','running','quota-wait','needs-human','failed'].includes(state.status) || typeof state.paused!=='boolean' || (state.nextRetryAt!==null && (!Number.isSafeInteger(state.nextRetryAt) || (state.nextRetryAt as number)<0)))throw new Error('worker_state_unavailable');
        if((state.nextRetryAt!==null && now()<(state.nextRetryAt as number)) || (state.status==='quota-wait' && state.nextRetryAt===null))throw new Error('shared_quota_wait');
      }catch(error){if(!(error instanceof Error) || !('code' in error) || error.code!=='ENOENT')throw error;}
    }
    const reservation:Reservation={version:1,status:'reserved',repositoryId:repo.id,issue:expectedIssue,reservationId:randomUUID(),outcome:null};
    reserved=true;await persist(root,reservation,journal);
    const grants=(await readApprovalGrants(root,registry)).filter(grant=>grant.repositoryId===repo.id&&grant.issue===expectedIssue);
    const outcome=parseOutcome(await (run??((target,issue)=>runTrustedWorker(target,issue,handoff.profile,grants)))(repo,expectedIssue),expectedIssue);
    // A surviving lock is not treated as a safe completion, even with a successful IPC.
    try{await lstat(join(repo.stateDirectory,'worker.lock'));throw new Error('worker_completion_unknown');}
    catch(error){if(!(error instanceof Error) || !('code' in error) || error.code!=='ENOENT')throw error;}
    await persist(root,{...reservation,status:'settled',outcome},journal);reserved=false;return outcome;
  } finally {
    await lock.close();
    // Unknown child termination or uncertain persistence leaves lock + reservation for
    // human reconciliation. Never guess that worker/Codex grandchildren are dead.
    if(!reserved)await unlink(join(root,lockName));
  }
}

// Hold one short admission lane only while checking shared gates and saving the
// repository reservation. Worker execution and its journal use independent lanes.
async function dispatchParallel(options:DispatchOptions):Promise<DispatchOutcome> {
 const {registry,directory,repositoryId}=options;
 if(!Number.isSafeInteger(registry.globalConcurrency)||registry.globalConcurrency<2||registry.globalConcurrency>32||!registry.repositories.some(repo=>repo.id===repositoryId))throw new Error('dispatch_not_authorized');
 const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0||await realpath(directory)!==directory)throw new Error('dispatch_directory_unsafe');
 await assertRecoveryClear(directory);
 const admissionPath=join(directory,'dispatch-admission.lock');
 let admission:Awaited<ReturnType<typeof open>>|undefined;
 for(let attempt=0;attempt<50;attempt++){
  try{admission=await open(admissionPath,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);break;}
  catch(error){if(!(error instanceof Error)||!('code' in error)||error.code!=='EEXIST')throw error;await new Promise(resolve=>setTimeout(resolve,20));}
 }
 if(!admission)throw new Error('dispatch_reconciliation_required');
 const release=async()=>{if(admission){await admission.close();admission=undefined;await unlink(admissionPath);}};
 try{
  await assertRecoveryClear(directory);
  try{await lstat(join(directory,'dispatch.lock'));throw new Error('dispatch_reconciliation_required');}catch(error){if(!(error instanceof Error)||!('code' in error)||error.code!=='ENOENT')throw error;}
  const known=new Set(options.managedActiveRepositoryIds??[]);const active:string[]=[];
  for(const name of ['dispatch.json',...registry.repositories.map(repo=>`dispatch.${repo.id}.json`)]){
   let value:unknown;try{value=(await readPrivateJson(join(directory,name))).value;}catch(error){if(error instanceof Error&&'code' in error&&error.code==='ENOENT')continue;throw error;}
   if(!record(value)||Object.keys(value).length!==6||value.version!==1||typeof value.repositoryId!=='string'||!registry.repositories.some(repo=>repo.id===value.repositoryId)||!Number.isSafeInteger(value.issue)||(value.issue as number)<=0||typeof value.reservationId!=='string'||!['settled','reserved'].includes(String(value.status))||name!=='dispatch.json'&&name!==`dispatch.${value.repositoryId}.json`)throw new Error('dispatch_reconciliation_required');
   if(value.status==='reserved'){
    if(name==='dispatch.json'||value.outcome!==null||value.repositoryId===repositoryId||!known.has(value.repositoryId))throw new Error('dispatch_reconciliation_required');
    await lstat(join(directory,`dispatch.${value.repositoryId}.lock`));active.push(value.repositoryId);
   }else{
    const prior=parseOutcome(value.outcome,value.issue as number);
    if(prior.status==='quota-wait'&&(prior.nextRetryAt===null||(options.now??Date.now)()<prior.nextRetryAt))throw new Error('shared_quota_wait');
   }
  }
  for(const repo of registry.repositories){
   try{await lstat(join(directory,`dispatch.${repo.id}.lock`));if(!active.includes(repo.id))throw new Error('dispatch_reconciliation_required');}
   catch(error){if(!(error instanceof Error)||!('code' in error)||error.code!=='ENOENT')throw error;}
  }
  if(active.length>=registry.globalConcurrency)throw new Error('dispatch_capacity_reached');
  return await dispatchInLane({...options,run:async(repo,issue)=>{
   // The per-repository lock and synced reservation already exist at this point.
   const grants=(await readApprovalGrants(directory,registry)).filter(grant=>grant.repositoryId===repo.id&&grant.issue===issue);
   await release();
   return options.run?options.run(repo,issue):runTrustedWorker(repo,issue,options.handoff.profile,grants);
  }},`dispatch.${repositoryId}.json`,`dispatch.${repositoryId}.lock`,active);
 }finally{await release();}
}
