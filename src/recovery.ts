import { constants } from 'node:fs';
import { open, realpath, lstat, mkdir, rename, unlink, link, opendir } from 'node:fs/promises';
import { join, sep, resolve, isAbsolute, dirname, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseOutcome } from './worker-adapter.ts';
import { initialControllerState, controllerTopology } from './controller.ts';
import { registryFingerprint, parseHandoff } from './handoff.ts';
import { record } from './registry.ts';
import { projectState } from './snapshot.ts';
import { assertRecoveryClear, replacementGate } from './recovery-guard.ts';
import type { Registry } from './types.ts';
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const missing=(error:unknown)=>error instanceof Error&&'code' in error&&error.code==='ENOENT';
async function privateFile(path:string):Promise<{bytes:Buffer;identity:string}|null> {
 let file;try{file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){if(missing(error))return null;throw new Error('recovery_file_unsafe');}
 try {
  const stat=await file.stat();if(!stat.isFile()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size>1_048_576)throw new Error('recovery_file_unsafe');
  const buffer=Buffer.alloc(1_048_577);const {bytesRead}=await file.read(buffer,0,buffer.length,0);if(bytesRead>1_048_576)throw new Error('recovery_file_unsafe');
  const bytes=buffer.subarray(0,bytesRead);
  return {bytes,identity:JSON.stringify([stat.dev,stat.ino,stat.mtimeMs,stat.size,createHash('sha256').update(bytes).digest('hex')])};
 }finally{await file.close();}
}
async function directory(registry:Registry,path:string):Promise<string> {
 if(!isAbsolute(path)||resolve(path)!==path)throw new Error('recovery_directory_unsafe');
 const info=await lstat(path);const root=await realpath(path);
 if(root!==path||!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0||registry.repositories.flatMap(repo=>[repo.clonePath,repo.stateDirectory]).some(other=>overlap(root,other)))throw new Error('recovery_directory_unsafe');
 return root;
}
const overlap=(a:string,b:string)=>a===b||a.startsWith(b+sep)||b.startsWith(a+sep);
export interface RecoveryPlan {
 version:1;registryFingerprint:string;planFingerprint:string;replacementDirectory:string;
 status:'ready-for-attestation'|'blocked';reason:'worker_lock_present'|'worker_state_unavailable'|'controller_evidence_unavailable'|'manual_stop_confirmation_required';
 nextRetryAt:string|null;unknownQuota:boolean;
 oldControllerLock:boolean;dispatchLock:boolean;dispatchJournal:boolean;schedulerJournal:boolean;
 repositories:{repositoryId:string;workerLock:boolean;status:string;issue:number|null;stage:string|null}[];
}
async function inspect(registry:Registry,source:string,replacement:string,replaying=false):Promise<{plan:RecoveryPlan;handoff:unknown;quota:{version:1;topology:string;nextRetryAt:number|null;unknown:boolean}}> {
 await directory(registry,source);
 if(!replaying)await assertRecoveryClear(replacement);
 if(!isAbsolute(replacement)||resolve(replacement)!==replacement||join(await realpath(dirname(replacement)),basename(replacement))!==replacement||[source,...registry.repositories.flatMap(repo=>[repo.clonePath,repo.stateDirectory])].some(path=>overlap(replacement,path)))throw new Error('recovery_directory_unsafe');
 const parentInfo=await lstat(dirname(replacement));if(parentInfo.uid!==process.getuid?.()||(parentInfo.mode&0o022)!==0)throw new Error('recovery_directory_unsafe');
 // An existing replacement, including an incomplete attempt, is never reused automatically.
 if(!replaying)try{await lstat(replacement);throw new Error('recovery_replacement_exists');}catch(error){if(!missing(error))throw error;}
 const identities:unknown[]=[];const files=new Map<string,{bytes:Buffer;identity:string}|null>();
 for(const name of ['controller.json','controller.lock','dispatch.json','dispatch.lock','scheduler.json','handoff.json','recovery-quota.json','dispatch-admission.lock',...registry.repositories.flatMap(repo=>[`dispatch.${repo.id}.json`,`dispatch.${repo.id}.lock`])]){const file=await privateFile(join(source,name));files.set(name,file);identities.push([name,file?.identity??null]);}
 if(!files.get('controller.json')||!files.get('handoff.json'))throw new Error('recovery_source_incomplete');
 const handoff:unknown=JSON.parse(files.get('handoff.json')!.bytes.toString('utf8'));parseHandoff(handoff,registry);
 let blocked:RecoveryPlan['reason']|null=null;
 let nextRetryAt:number|null=null,unknown=false;
 const retry=(value:unknown)=>{if(value===null)return;if(!Number.isSafeInteger(value)||(value as number)<0||(value as number)>8.64e15)throw new Error('invalid_retry');nextRetryAt=Math.max(nextRetryAt??0,value as number);};
 try {
  const controller:unknown=JSON.parse(files.get('controller.json')!.bytes.toString('utf8'));if(!record(controller)||controller.version!==1||controller.topology!==controllerTopology(registry))throw new Error('invalid_controller');
  const inherited=files.get('recovery-quota.json');if(inherited){const v:unknown=JSON.parse(inherited.bytes.toString('utf8'));if(!record(v)||Object.keys(v).length!==4||v.version!==1||v.topology!==registryFingerprint(registry)||typeof v.unknown!=='boolean')throw new Error('invalid_recovery_quota');retry(v.nextRetryAt);unknown=v.unknown;}
  const saved=files.get('scheduler.json');if(saved){const v:unknown=JSON.parse(saved.bytes.toString('utf8'));if(!record(v)||![1,2].includes(v.version as number)||v.topology!==registryFingerprint(registry)||!['idle','reserved','blocked'].includes(v.phase as string))throw new Error('invalid_scheduler');retry(v.nextRetryAt);if(v.reason==='shared_quota_wait'&&v.nextRetryAt===null&&v.phase==='blocked')unknown=true;}
  for(const name of ['dispatch.json',...registry.repositories.map(repo=>`dispatch.${repo.id}.json`)]){const dispatch=files.get(name);if(dispatch){const v:unknown=JSON.parse(dispatch.bytes.toString('utf8'));if(!record(v)||v.version!==1||!['reserved','settled'].includes(v.status as string)||typeof v.repositoryId!=='string'||!registry.repositories.some(repo=>repo.id===v.repositoryId)||!Number.isSafeInteger(v.issue)||(v.issue as number)<=0)throw new Error('invalid_dispatch');if(v.status==='settled'){const outcome=parseOutcome(v.outcome,v.issue as number);retry(outcome.nextRetryAt);if(outcome.status==='quota-wait'&&outcome.nextRetryAt===null)unknown=true;}else if(v.outcome!==null)throw new Error('invalid_dispatch');}}
 }catch{blocked='controller_evidence_unavailable';}
 const repositories:RecoveryPlan['repositories']=[];
 for(const repo of registry.repositories){
  if(await realpath(repo.stateDirectory)!==repo.stateDirectory||await realpath(repo.clonePath)!==repo.clonePath)throw new Error('recovery_registry_root_changed');
  const state=await privateFile(join(repo.stateDirectory,'state.json'));const lock=await privateFile(join(repo.stateDirectory,'worker.lock'));
  identities.push([repo.id,state?.identity??null,lock?.identity??null]);
  let status='unavailable',issue:number|null=null,stage:string|null=null;
  try{if(!state)throw new Error();const value=projectState(JSON.parse(state.bytes.toString('utf8')),repo,0,0);status=value.status;issue=value.current?.issue??null;stage=value.current?.stage??null;}catch{blocked='worker_state_unavailable';}
  if(lock)blocked='worker_lock_present';repositories.push({repositoryId:repo.id,workerLock:!!lock,status,issue,stage});
 }
 const fingerprint=registryFingerprint(registry);
 return {handoff,quota:{version:1,topology:fingerprint,nextRetryAt,unknown},plan:{version:1,nextRetryAt:nextRetryAt===null?null:new Date(nextRetryAt).toISOString(),unknownQuota:unknown,registryFingerprint:fingerprint,planFingerprint:createHash('sha256').update(JSON.stringify([fingerprint,source,replacement,identities])).digest('hex'),replacementDirectory:replacement,status:blocked?'blocked':'ready-for-attestation',reason:blocked??'manual_stop_confirmation_required',oldControllerLock:!!files.get('controller.lock'),dispatchLock:!!files.get('dispatch.lock')||!!files.get('dispatch-admission.lock')||registry.repositories.some(repo=>!!files.get(`dispatch.${repo.id}.lock`)),dispatchJournal:!!files.get('dispatch.json')||registry.repositories.some(repo=>!!files.get(`dispatch.${repo.id}.json`)),schedulerJournal:!!files.get('scheduler.json'),repositories}};
}
/** Read-only, bounded diagnostic. No process/PID lookup can establish child termination. */
export async function recoveryPlan(registry:Registry,source:string,replacement:string):Promise<RecoveryPlan> {
 await assertRecoveryClear(source);return (await inspect(registry,source,replacement)).plan;
}
interface Attestation {version:1;requestId:string;registryFingerprint:string;planFingerprint:string;replacementDirectory:string;scope:'all-registered-workers';allControllersAndWorkersStopped:true;restartsDisabled:true}
function attestation(value:unknown,plan:RecoveryPlan):Attestation {
 const keys=['version','requestId','registryFingerprint','planFingerprint','replacementDirectory','scope','allControllersAndWorkersStopped','restartsDisabled'];
 if(!record(value)||Object.keys(value).length!==keys.length||!keys.every(key=>Object.hasOwn(value,key))||value.version!==1||!uuid(value.requestId)||value.registryFingerprint!==plan.registryFingerprint||value.planFingerprint!==plan.planFingerprint||value.replacementDirectory!==plan.replacementDirectory||value.scope!=='all-registered-workers'||value.allControllersAndWorkersStopped!==true||value.restartsDisabled!==true)throw new Error('recovery_attestation_invalid');
 return value as unknown as Attestation;
}
async function sync(directory:string){const file=await open(directory,constants.O_RDONLY);try{await file.sync();}finally{await file.close();}}
async function persist(directory:string,name:string,value:unknown){
 const temporary=join(directory,randomUUID()+'.tmp');const file=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
 try{await file.writeFile(JSON.stringify(value)+'\n');await file.sync();}finally{await file.close();}
 try{await rename(temporary,join(directory,name));await sync(directory);}finally{await unlink(temporary).catch(()=>{});}
}
/** Offline, explicit rotation. Never clears worker locks/state or fabricates a job result.
 * Any partial mutation retains a recovery marker; failures are not automatically retried. */
export async function reconcileOffline({registry,source,replacement,attestationPath,write=persist}:{registry:Registry;source:string;replacement:string;attestationPath:string;write?:(directory:string,name:string,value:unknown)=>Promise<void>}):Promise<{status:'completed';requestId:string;replacementDirectory:string;dispatchPaused:true}> {
 const initial=await recoveryPlan(registry,source,replacement);if(initial.status!=='ready-for-attestation')throw new Error('recovery_blocked');
 const file=await privateFile(attestationPath);if(!file)throw new Error('recovery_attestation_missing');const approved=attestation(JSON.parse(file.bytes.toString('utf8')),initial);
 const lock=await open(join(source,'recovery.lock'),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
 let mutated=false;let targetLock:Awaited<ReturnType<typeof open>>|undefined;
 try{
  await lock.writeFile(JSON.stringify({version:1,requestId:approved.requestId,planFingerprint:initial.planFingerprint}));await lock.sync();await sync(source);
  const checked=await inspect(registry,source,replacement);if(checked.plan.planFingerprint!==initial.planFingerprint||checked.plan.status!=='ready-for-attestation')throw new Error('recovery_plan_changed');
  // Durable intent precedes every provisioning mutation and binds all source evidence.
  await persist(source,'recovery-journal.json',{version:2,sourceDirectory:source,approval:approved,phase:'pending'});
  mutated=true;
  // From here on, preserve the marker even if provisioning fails.
  targetLock=await open(replacementGate(replacement),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  mutated=true;await targetLock.writeFile(JSON.stringify({version:1,requestId:approved.requestId}));await targetLock.sync();await sync(dirname(replacement));
  await mkdir(replacement,{mode:0o700});
  await persist(replacement,'recovery.lock',{version:1,requestId:approved.requestId,status:'pending'});await sync(dirname(replacement));
  // Retire the old controller before a replacement can ever start.
  await write(source,'retired.json',{...approved,status:'retired'});
  await write(replacement,'controller.json',initialControllerState(registry));
  await write(replacement,'handoff.json',checked.handoff);
  await write(replacement,'recovery-quota.json',checked.quota);
  await write(replacement,'recovery-receipt.json',{...approved,status:'completed',dispatchPaused:true,sourceDirectory:source});
  await persist(source,'recovery-journal.json',{version:2,sourceDirectory:source,approval:approved,phase:'completed'});
  await unlink(join(replacement,'recovery.lock'));await sync(replacement);
  await targetLock.close();targetLock=undefined;await unlink(replacementGate(replacement));await sync(dirname(replacement));
  return {status:'completed',requestId:approved.requestId,replacementDirectory:replacement,dispatchPaused:true};
 }finally{
  await targetLock?.close();await lock.close();if(!mutated){await unlink(join(source,'recovery.lock'));await sync(source);}
 }
}

interface RecoveryJournal {version:2;sourceDirectory:string;approval:Attestation;phase:'pending'|'completed'}
export interface ResumePlan {version:1;status:'ready-for-attestation'|'completed';registryFingerprint:string;resumeFingerprint:string;replacementDirectory:string;originalRequestId:string;completedFiles:number;claimCount:number}
async function journal(registry:Registry,source:string,replacement:string):Promise<{value:RecoveryJournal;identity:string}> {
 await directory(registry,source);
 const file=await privateFile(join(source,'recovery-journal.json'));if(!file)throw new Error('recovery_journal_missing');
 const value:unknown=JSON.parse(file.bytes.toString('utf8'));
 if(!record(value)||Object.keys(value).length!==4||value.version!==2||value.sourceDirectory!==source||!['pending','completed'].includes(value.phase as string)||!record(value.approval))throw new Error('recovery_journal_invalid');
 const original=value.approval;
 attestation(original,{registryFingerprint:registryFingerprint(registry),planFingerprint:String(original.planFingerprint),replacementDirectory:replacement} as RecoveryPlan);
 if(typeof original.planFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(original.planFingerprint))throw new Error('recovery_journal_invalid');
 return {value:value as unknown as RecoveryJournal,identity:file.identity};
}
const same=(a:unknown,b:unknown):boolean=>{
 if(record(a)&&record(b))return Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>Object.hasOwn(b,key)&&same(a[key],b[key]));
 if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,i)=>same(v,b[i]));return a===b;
};
async function expectedFile(path:string,expected:unknown):Promise<string|null> {
 const file=await privateFile(path);if(!file)return null;
 if(!same(JSON.parse(file.bytes.toString('utf8')),expected))throw new Error('recovery_target_changed');return file.identity;
}
async function exists(path:string):Promise<boolean>{try{await lstat(path);return true;}catch(error){if(missing(error))return false;throw error;}}
async function inspectResume(registry:Registry,source:string,replacement:string,excludeClaim?:string):Promise<{plan:ResumePlan;original:Attestation;files:Record<string,unknown>}> {
 const saved=await journal(registry,source,replacement);const original=saved.value.approval;
 // Once released, the destination may be running. Completed retries are read-only.
 if(saved.value.phase==='completed'&&!await exists(join(replacement,'recovery.lock'))&&!await exists(replacementGate(replacement))){
  await directory(registry,replacement);
  const receipt=await expectedFile(join(replacement,'recovery-receipt.json'),{...original,status:'completed',dispatchPaused:true,sourceDirectory:source});if(!receipt)throw new Error('recovery_receipt_missing');
  return {original,files:{},plan:{version:1,status:'completed',registryFingerprint:registryFingerprint(registry),resumeFingerprint:createHash('sha256').update(saved.identity+receipt).digest('hex'),replacementDirectory:replacement,originalRequestId:original.requestId,completedFiles:4,claimCount:0}};
 }
 const checked=await inspect(registry,source,replacement,true);
 if(checked.plan.planFingerprint!==original.planFingerprint||checked.plan.status!=='ready-for-attestation')throw new Error('recovery_source_changed');
 const files:Record<string,unknown>={'controller.json':initialControllerState(registry),'handoff.json':checked.handoff,'recovery-quota.json':checked.quota,'recovery-receipt.json':{...original,status:'completed',dispatchPaused:true,sourceDirectory:source}};
 const identities:unknown[]=[saved.identity,checked.plan.planFingerprint];let completedFiles=0;
 const sourceLock=await expectedFile(join(source,'recovery.lock'),{version:1,requestId:original.requestId,planFingerprint:original.planFingerprint});if(!sourceLock)throw new Error('recovery_source_gate_missing');identities.push(sourceLock);
 identities.push(await expectedFile(join(source,'retired.json'),{...original,status:'retired'}));
 identities.push(await expectedFile(replacementGate(replacement),{version:1,requestId:original.requestId}));
 if(await exists(replacement)){
  await directory(registry,replacement);
  let scanned=0;for await(const entry of await opendir(replacement)){
   if(++scanned>256||(!Object.hasOwn(files,entry.name)&&entry.name!=='recovery.lock'&&!/^[a-f0-9-]{36}\.tmp$/.test(entry.name)))throw new Error('recovery_target_changed');
  }
  identities.push(await expectedFile(join(replacement,'recovery.lock'),{version:1,requestId:original.requestId,status:'pending'}));
  for(const [name,value] of Object.entries(files)){const identity=await expectedFile(join(replacement,name),value);identities.push([name,identity]);if(identity)completedFiles++;}
 }
 const claims:string[]=[];let scanned=0;for await(const entry of await opendir(source)){
  if(++scanned>4096)throw new Error('recovery_claim_limit');
  if(/^resume-[a-f0-9]{64}\.claim$/.test(entry.name)&&entry.name!==excludeClaim)claims.push(entry.name);
 }
 if(claims.length>128)throw new Error('recovery_claim_limit');
 for(const name of claims.sort()){const file=await privateFile(join(source,name));if(!file)throw new Error('recovery_claim_changed');identities.push([name,file.identity]);}
 return {original,files,plan:{version:1,status:'ready-for-attestation',registryFingerprint:registryFingerprint(registry),resumeFingerprint:createHash('sha256').update(JSON.stringify(identities)).digest('hex'),replacementDirectory:replacement,originalRequestId:original.requestId,completedFiles,claimCount:claims.length}};
}
export async function recoveryResumePlan(registry:Registry,source:string,replacement:string):Promise<ResumePlan>{return (await inspectResume(registry,source,replacement)).plan;}
// Creation-only replay: never overwrite a pre-existing file, even on a concurrent write.
async function ensureFile(directory:string,name:string,value:unknown):Promise<void>{
 const path=join(directory,name);if(await expectedFile(path,value))return;
 const temporary=join(directory,randomUUID()+'.tmp');const handle=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
 try{await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync();}finally{await handle.close();}
 try{try{await link(temporary,path);}catch(error){if(!(error instanceof Error)||!('code' in error)||error.code!=='EEXIST')throw error;if(!await expectedFile(path,value))throw new Error('recovery_target_changed');}await sync(directory);}finally{await unlink(temporary).catch(()=>{});}
}
export async function resumeRecoveryOffline({registry,source,replacement,attestationPath,checkpoint}:{registry:Registry;source:string;replacement:string;attestationPath:string;checkpoint?:(phase:string)=>Promise<void>}):Promise<{status:'completed';requestId:string;replacementDirectory:string;dispatchPaused:true|null;alreadyCompleted:boolean}> {
 const inspected=await inspectResume(registry,source,replacement);const plan=inspected.plan,original=inspected.original;
 if(plan.status==='completed')return {status:'completed',requestId:original.requestId,replacementDirectory:replacement,dispatchPaused:null,alreadyCompleted:true};
 const file=await privateFile(attestationPath);if(!file)throw new Error('recovery_attestation_missing');const approved:unknown=JSON.parse(file.bytes.toString('utf8'));
 const keys=['version','requestId','registryFingerprint','resumeFingerprint','replacementDirectory','scope','allControllersAndWorkersStopped','restartsDisabled','recoveryCommandsStopped'];
 if(!record(approved)||Object.keys(approved).length!==keys.length||!keys.every(key=>Object.hasOwn(approved,key))||approved.version!==1||!uuid(approved.requestId)||approved.registryFingerprint!==plan.registryFingerprint||approved.resumeFingerprint!==plan.resumeFingerprint||approved.replacementDirectory!==replacement||approved.scope!=='all-registered-workers'||approved.allControllersAndWorkersStopped!==true||approved.restartsDisabled!==true||approved.recoveryCommandsStopped!==true)throw new Error('recovery_resume_attestation_invalid');
 // The same inspected attempt can run once. A crash retains the claim; a new plan
 // includes it and requires a renewed assertion that prior recovery commands stopped.
 const claimName=`resume-${plan.resumeFingerprint}.claim`;const claim=await open(join(source,claimName),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
 try{
  await claim.writeFile(JSON.stringify(approved));await claim.sync();await sync(source);
  const current=await inspectResume(registry,source,replacement,claimName);if(current.plan.resumeFingerprint!==plan.resumeFingerprint)throw new Error('recovery_resume_plan_changed');
  await checkpoint?.('claimed');
  await ensureFile(dirname(replacement),basename(replacementGate(replacement)),{version:1,requestId:original.requestId});
  if(!await exists(replacement)){await mkdir(replacement,{mode:0o700});await sync(dirname(replacement));}
  await ensureFile(replacement,'recovery.lock',{version:1,requestId:original.requestId,status:'pending'});
  await ensureFile(source,'retired.json',{...original,status:'retired'});await checkpoint?.('retired');
  for(const [name,value] of Object.entries(current.files)){await ensureFile(replacement,name,value);await checkpoint?.(name);}
  await persist(source,'recovery-journal.json',{version:2,sourceDirectory:source,approval:original,phase:'completed'});await checkpoint?.('completed');
  await unlink(join(replacement,'recovery.lock'));await sync(replacement);await checkpoint?.('target-released');
  await unlink(replacementGate(replacement));await sync(dirname(replacement));
  return {status:'completed',requestId:original.requestId,replacementDirectory:replacement,dispatchPaused:true,alreadyCompleted:false};
 }finally{await claim.close();}
}
