import { isWorkerProfile, type WorkerProfile } from './profiles.ts';
import { assertRecoveryClear } from './recovery-guard.ts';
import { readApprovalGrants } from './approvals.ts';
import { diffBinding, issueBinding, recoveryState, parseRecovery } from './approval-policy.ts';
import { approvalGit } from './approvals.ts';
import { ghRead } from './github-queue.ts';
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
export async function runTrustedWorker(repo:Repository,issue:number,profile:WorkerProfile='care-record-v1',grants:Grant[]=[],recovery?:ReturnType<typeof parseRecovery>):Promise<DispatchOutcome> {
  if(!isWorkerProfile(profile))throw new Error('unsupported_profile');
  return new Promise((resolve,reject)=>{
    const child=fork(new URL(import.meta.url.endsWith('.ts')?'../engine/care-record/bridge.mjs':'../../engine/care-record/bridge.mjs',import.meta.url),[],{cwd:repo.clonePath,detached:process.platform!=='win32',execArgv:[],env:bridgeEnvironment(),stdio:['ignore','ignore','ignore','ipc']});
    let outcome:DispatchOutcome|null=null;let invalid=false;
    child.on('message',value=>{try{if(outcome)throw new Error('duplicate');outcome=parseOutcome(value,issue);}catch{invalid=true;}});
    child.once('error',()=>reject(new Error('worker_completion_unknown')));
    // Successful IPC alone is insufficient; wait for process and stdio closure.
    child.once('close',(code,signal)=>{if(code===0 && !signal && outcome && !invalid)resolve(outcome);else reject(new Error('worker_completion_unknown'));});
    child.send({version:1,profile,repo:repo.repo,clonePath:repo.clonePath,stateDirectory:repo.stateDirectory,expectedIssue:issue,...(recovery?{recovery}:{}),...(grants.length?{approval:{repositoryId:repo.id,repo:repo.repo,grants}}:{})},error=>{if(error)reject(new Error('worker_completion_unknown'));});
  });
}
interface Reservation {version:1;status:'reserved'|'settled';repositoryId:string;issue:number;reservationId:string;outcome:DispatchOutcome|null}
async function persist(directory:string,value:Reservation) {
  const temporary=join(directory,randomUUID()+'.tmp');const file=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{await file.writeFile(JSON.stringify(value));await file.sync();}finally{await file.close();}
  try{await rename(temporary,join(directory,'dispatch.json'));const handle=await open(directory,constants.O_RDONLY);try{await handle.sync();}finally{await handle.close();}}
  finally{await unlink(temporary).catch(()=>{});}
}
/** Internal controller boundary, deliberately absent from HTTP/launcher. Handoff is
 * a trusted administrator attestation, never inferred from an absent worker.lock. */
export async function dispatchOnce({registry,directory,handoff,repositoryId,expectedIssue,now=Date.now,run}:{registry:Registry;directory:string;handoff:Handoff;repositoryId:string;expectedIssue:number;now?:()=>number;run?:(repo:Repository,issue:number)=>Promise<DispatchOutcome>}):Promise<DispatchOutcome> {
  const repo=registry.repositories.find(item=>item.id===repositoryId);
  if(!repo || !repo.enabled || !record(handoff) || Object.keys(handoff).length!==4 || handoff.scope!=='all-registered-workers' || handoff.repositoryId!==repo.id || !isWorkerProfile(handoff.profile) || handoff.standaloneStopped!==true || !Number.isSafeInteger(expectedIssue) || expectedIssue<=0 || repo.defaultModel!=='gpt-6.1-sol' || repo.defaultEffort!=='medium')throw new Error('dispatch_not_authorized');
  const info=await lstat(directory);const root=await realpath(directory);
  if(!info.isDirectory() || info.isSymbolicLink() || info.uid!==process.getuid?.() || (info.mode&0o077)!==0 || registry.repositories.flatMap(item=>[item.clonePath,item.stateDirectory]).some(path=>root===path || root.startsWith(path+sep) || path.startsWith(root+sep)))throw new Error('dispatch_directory_unsafe');
  await assertRecoveryClear(root);
  const lock=await open(join(root,'dispatch.lock'),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  let reserved=false;
  try {
    await assertRecoveryClear(root);
    await lock.writeFile(JSON.stringify({version:1,reservationId:randomUUID()}));await lock.sync();
    try {
      const prior=(await readPrivateJson(join(root,'dispatch.json'))).value;
      if(!record(prior) || Object.keys(prior).length!==6 || prior.version!==1 || prior.status!=='settled' || typeof prior.repositoryId!=='string' || !registry.repositories.some(item=>item.id===prior.repositoryId) || !Number.isSafeInteger(prior.issue) || typeof prior.reservationId!=='string'){reserved=true;throw new Error('dispatch_reconciliation_required');}
      const previous=parseOutcome(prior.outcome,prior.issue as number);
      if(previous.status==='quota-wait' && (previous.nextRetryAt===null || now()<previous.nextRetryAt))throw new Error('shared_quota_wait');
    } catch(error) {if(!(error instanceof Error) || !('code' in error) || error.code!=='ENOENT')throw error;}
    // Any legacy lock, including another observed repository, blocks global execution.
    for(const registered of registry.repositories) {
      try{await lstat(join(registered.stateDirectory,'worker.lock'));throw new Error('standalone_worker_lock');}
      catch(error){if(!(error instanceof Error) || !('code' in error) || error.code!=='ENOENT')throw error;}
    }
    for(const registered of registry.repositories) {
      try {const state=(await readPrivateJson(join(registered.stateDirectory,'state.json'))).value;
        if(!record(state) || state.version!==1 || (state.repo!==null && state.repo!==registered.repo) || typeof state.status!=='string' || !['idle','running','quota-wait','needs-human','failed'].includes(state.status) || typeof state.paused!=='boolean' || (state.nextRetryAt!==null && (!Number.isSafeInteger(state.nextRetryAt) || (state.nextRetryAt as number)<0)))throw new Error('worker_state_unavailable');
        if((state.nextRetryAt!==null && now()<(state.nextRetryAt as number)) || (state.status==='quota-wait' && state.nextRetryAt===null))throw new Error('shared_quota_wait');
      }catch(error){if(!(error instanceof Error) || !('code' in error) || error.code!=='ENOENT')throw error;}
    }
    const reservation:Reservation={version:1,status:'reserved',repositoryId:repo.id,issue:expectedIssue,reservationId:randomUUID(),outcome:null};
    reserved=true;await persist(root,reservation);
    const grants=(await readApprovalGrants(root,registry)).filter(grant=>grant.repositoryId===repo.id&&grant.issue===expectedIssue);
    let recovery:ReturnType<typeof parseRecovery>|undefined;
    let saved:unknown;
    try{saved=(await readPrivateJson(join(repo.stateDirectory,'state.json'))).value;}catch(error){if(!(error instanceof Error)||!('code' in error)||error.code!=='ENOENT')throw error;}
    if(record(saved)){
      const parked=Array.isArray(saved.humanWaiting)?saved.humanWaiting.filter(record).find(item=>record(item.current)&&item.current.number===expectedIssue):undefined;
      const current=parked?.current??saved.current;
      if(record(current)&&current.number===expectedIssue&&recoveryState(current)==='automatic_retry_pending'){
        if(current.worktree!==join(repo.stateDirectory,'worktrees',`issue-${expectedIssue}`)||typeof current.branch!=='string')throw new Error('recovery_scope_invalid');
        const target=current as {worktree:string;branch:string;base?:unknown};
        if(await approvalGit('git',['rev-parse','--path-format=absolute','--git-common-dir'],{cwd:target.worktree})!==await approvalGit('git',['rev-parse','--path-format=absolute','--git-common-dir'],{cwd:repo.clonePath}))throw new Error('recovery_scope_invalid');
        const issue=await ghRead(repo.repo,`issues/${expectedIssue}`);
        if(!record(issue)||issue.number!==expectedIssue||issue.state!=='open'||typeof issue.body!=='string')throw new Error('recovery_scope_invalid');
        recovery=parseRecovery({issue:issueBinding({body:issue.body}),diff:await diffBinding(target,approvalGit)});
      }
    }
    const outcome=parseOutcome(await (run??((target,issue)=>runTrustedWorker(target,issue,handoff.profile,grants,recovery)))(repo,expectedIssue),expectedIssue);
    // A surviving lock is not treated as a safe completion, even with a successful IPC.
    try{await lstat(join(repo.stateDirectory,'worker.lock'));throw new Error('worker_completion_unknown');}
    catch(error){if(!(error instanceof Error) || !('code' in error) || error.code!=='ENOENT')throw error;}
    await persist(root,{...reservation,status:'settled',outcome});reserved=false;return outcome;
  } finally {
    await lock.close();
    // Unknown child termination or uncertain persistence leaves lock + reservation for
    // human reconciliation. Never guess that worker/Codex grandchildren are dead.
    if(!reserved)await unlink(join(root,'dispatch.lock'));
  }
}
