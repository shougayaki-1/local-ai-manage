import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { homedir } from 'node:os';
import { githubEnvironment } from './github-queue.ts';
import { loadHandoff, registryFingerprint } from './handoff.ts';
import { assertRecoveryClear } from './recovery-guard.ts';
import { observeRepository, readPrivateJson } from './snapshot.ts';
import { record } from './registry.ts';
import type { Registry } from './types.ts';
export interface Finding {repositoryId:string|null;check:string;status:'pass'|'blocked'|'review-required'|'unavailable';reason:string}
async function exists(path:string):Promise<boolean>{try{await lstat(path);return true;}catch(error){if(error instanceof Error&&'code' in error&&error.code==='ENOENT')return false;throw error;}}
export async function checkGitHubAuthentication():Promise<boolean>{return new Promise(resolve=>{execFile('gh',['auth','status','--hostname','github.com'],{cwd:homedir(),env:githubEnvironment(process.env),shell:false,timeout:5000,killSignal:'SIGKILL',maxBuffer:65536},error=>resolve(!error));});}
/** Diagnostic only: never acquires a lock, creates a directory, or authorizes dispatch. */
export async function preflight(registry:Registry,directory:string,{github=false,authenticate=checkGitHubAuthentication,now=Date.now(),activeDashboard=false}:{activeDashboard?:boolean;github?:boolean;authenticate?:()=>Promise<boolean>;now?:number}={}){
 const findings:Finding[]=[];const add=(repositoryId:string|null,check:string,status:Finding['status'],reason:string)=>findings.push({repositoryId,check,status,reason});
 add(null,'registry','pass','canonical_registry_loaded');
 let safe=false;
 try{const info=await lstat(directory);const root=await realpath(directory);const overlap=registry.repositories.flatMap(r=>[r.clonePath,r.stateDirectory]).some(path=>root===path||root.startsWith(path+sep)||path.startsWith(root+sep));if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0||root!==directory||overlap)throw new Error('unsafe');safe=true;add(null,'controller-directory','pass','private_canonical_directory');}
 catch{add(null,'controller-directory','blocked','directory_missing_or_unsafe');}
 const handoffs=safe?await loadHandoff(join(directory,'handoff.json'),registry).catch(()=>null):null;
 add(null,'handoff',handoffs?'pass':'blocked',handoffs?'registry_bound_attestation_present':'handoff_missing_or_invalid');
 if(safe){
  try{await assertRecoveryClear(directory);add(null,'recovery','pass','no_recovery_markers');}catch{add(null,'recovery','blocked','recovery_required');}
  for(const name of ['controller.lock','dispatch.lock']){try{const present=await exists(join(directory,name));add(null,name,present&&!(name==='controller.lock'&&activeDashboard)?'blocked':'pass',present?(name==='controller.lock'&&activeDashboard?'dashboard_controller_active':'lock_present_no_automatic_reclaim'):'lock_absence_is_not_stop_proof');}catch{add(null,name,'blocked','lock_unavailable');}}
  for(const name of ['dispatch.json','scheduler.json','recovery-quota.json','controller.json']){try{if(await exists(join(directory,name)))add(null,name,'review-required','saved_controller_evidence_requires_review');}catch{add(null,name,'blocked','controller_evidence_unavailable');}}
 }
 const engine=await import(new URL(import.meta.url.endsWith('.ts')?'../engine/care-record/profile.mjs':'../../engine/care-record/profile.mjs',import.meta.url).href);
 for(const repo of registry.repositories){
  add(repo.id,'enabled',repo.enabled?'pass':'review-required',repo.enabled?'registry_enabled':'registry_observe_only');
  try{if(await realpath(repo.stateDirectory)!==repo.stateDirectory||await realpath(repo.clonePath)!==repo.clonePath)throw new Error('changed');const info=await lstat(repo.stateDirectory);if(!info.isDirectory()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)throw new Error('unsafe');add(repo.id,'state-directory','pass','private_canonical_directory');}catch{add(repo.id,'state-directory','blocked','state_directory_changed_or_unsafe');continue;}
  const handoff=handoffs?.find(h=>h.repositoryId===repo.id);
  let profile=handoff?.profile;
  try{if(!profile){const pkg=(await readPrivateJson(join(repo.clonePath,'package.json'))).value;profile=record(pkg)&&pkg.name==='care-record-app'?'care-record-v1':record(pkg)&&pkg.name==='local-ai-manage'?'local-ai-manage-v1':undefined;}if(!profile)throw new Error('unsupported');await engine.assertProfile(repo.clonePath,profile);add(repo.id,'profile','pass',profile);}catch{add(repo.id,'profile','blocked','profile_or_check_scripts_unsupported');}
  add(repo.id,'model',repo.defaultEffort==='medium'?'pass':'blocked',repo.defaultEffort==='medium'?'sol_medium':'managed_effort_requires_medium');
  try{const present=await exists(join(repo.stateDirectory,'worker.lock'));add(repo.id,'worker.lock',present?'blocked':'pass',present?'worker_lock_present':'lock_absence_is_not_stop_proof');}catch{add(repo.id,'worker.lock','blocked','worker_lock_unavailable');}
  try{const info=await lstat(join(repo.stateDirectory,'state.json'));if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)throw new Error('unsafe');}catch{add(repo.id,'state-permissions','blocked','worker_state_missing_or_unsafe');}
  if(profile==='care-record-v1'){try{const raw=(await readPrivateJson(join(repo.stateDirectory,'state.json'))).value;const branch=record(raw)&&record(raw.current)&&typeof raw.current.branch==='string'?raw.current.branch:'';const publication=await import(new URL(import.meta.url.endsWith('.ts')?'../engine/care-record/lib/publication.mjs':'../../engine/care-record/lib/publication.mjs',import.meta.url).href);await publication.readSuppressedDeployment(repo.clonePath,branch);add(repo.id,'deployment','pass','branch_deployment_disabled');}catch{add(repo.id,'deployment','review-required','deployment_suppression_required_before_publication');}}
  const observed=await observeRepository(repo,now);add(repo.id,'state',observed.status==='unavailable'?'blocked':'pass',observed.status==='unavailable'?'worker_state_unavailable':'legacy_state_projected');
  if(observed.status!=='unavailable'){
   try{const raw=(await readPrivateJson(join(repo.stateDirectory,'state.json'))).value;if(!record(raw)||!(raw.nextRetryAt===null||(Number.isSafeInteger(raw.nextRetryAt)&&(raw.nextRetryAt as number)>=0&&(raw.nextRetryAt as number)<=8.64e15)))throw new Error('invalid');const waiting=raw.status==='quota-wait'&&raw.nextRetryAt===null||typeof raw.nextRetryAt==='number'&&raw.nextRetryAt>now;add(repo.id,'quota',waiting?'blocked':'pass',waiting?'shared_quota_wait':'no_saved_future_quota');if(profile&&((raw.profile!==undefined&&raw.profile!==profile)||(profile==='local-ai-manage-v1'&&raw.current!==null&&raw.profile!==profile)))add(repo.id,'profile-state','blocked','saved_session_profile_mismatch');}catch{add(repo.id,'quota','blocked','quota_evidence_unavailable');}
   if(observed.paused||['needs-human','failed'].includes(observed.status))add(repo.id,'worker-intervention','review-required','worker_pause_or_intervention_preserved');
   if(observed.current)add(repo.id,'current','review-required','saved_work_requires_review');
  }
  add(repo.id,'telemetry',observed.heartbeat?'pass':'unavailable',observed.heartbeat?'producer_sidecar_observed':'legacy_worker_has_no_valid_sidecar');
 }
 add(null,'github-auth',github?(await authenticate().catch(()=>false)?'pass':'blocked'):'unavailable',github?'github_auth_checked':'github_auth_not_checked_offline');
 add(null,'codex-auth','review-required','chatgpt_login_and_cli_compatibility_require_manual_check');
 add(null,'process-stop','review-required','all_workers_children_and_restarts_require_human_confirmation');
 return {version:1 as const,registryFingerprint:registryFingerprint(registry),checkedAt:new Date(now).toISOString(),status:findings.some(f=>f.status==='blocked')?'blocked':'review-required',authorizesDispatch:false as const,findings};
}
