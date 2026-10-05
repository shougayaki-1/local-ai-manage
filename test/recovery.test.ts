import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Controller } from '../src/controller.ts';
import { recoveryPlan, reconcileOffline, recoveryResumePlan, resumeRecoveryOffline, type RecoveryPlan } from '../src/recovery.ts';
import { replacementGate } from '../src/recovery-guard.ts';
import { registryFingerprint, loadHandoff } from '../src/handoff.ts';
import { dispatchOnce } from '../src/worker-adapter.ts';
import { Scheduler } from '../src/scheduler.ts';
import { collectSnapshot } from '../src/snapshot.ts';
import type { Registry } from '../src/types.ts';
async function fixture(t:test.TestContext){
 const root=await realpath(await mkdtemp('/private/tmp/lam-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const clone=join(root,'clone'),worker=join(root,'worker'),source=join(root,'controller'),replacement=join(root,'replacement'),attestationPath=join(root,'attestation.json');
 await mkdir(clone);await mkdir(worker,{mode:0o700});
 const registry:Registry={version:1,globalConcurrency:1,repositories:[{id:'test--repo',repo:'test/repo',clonePath:clone,stateDirectory:worker,enabled:true,ownership:'observe-only',defaultModel:'gpt-6.1-sol',defaultEffort:'medium',maximumConcurrency:1}]};
 const controller=await Controller.create(registry,source);await controller.apply({requestId:randomUUID(),expectedRevision:0,target:'global',action:'resume'});await controller.apply({requestId:randomUUID(),expectedRevision:1,target:'test--repo',action:'resume'});await controller.close();
 const handoff={version:1,registryFingerprint:registryFingerprint(registry),standaloneStopped:true,scope:'all-registered-workers',repositories:[{repositoryId:'test--repo',profile:'care-record-v1'}]};
 await writeFile(join(source,'handoff.json'),JSON.stringify(handoff),{mode:0o600});await writeFile(join(source,'controller.lock'),'OLD_INSTANCE',{mode:0o600});
 await writeFile(join(source,'dispatch.lock'),'OLD_RESERVATION',{mode:0o600});await writeFile(join(source,'dispatch.json'),JSON.stringify({version:1,status:'reserved',repositoryId:'test--repo',issue:40,reservationId:randomUUID(),outcome:null,private:'TOKEN_CANARY'}),{mode:0o600});await writeFile(join(source,'scheduler.json'),JSON.stringify({version:1,topology:registryFingerprint(registry),phase:'reserved',nextRetryAt:Date.now()+1_800_000,private:'PRIVATE_SESSION'}),{mode:0o600});
 await writeFile(join(worker,'state.json'),JSON.stringify({version:1,repo:'test/repo',status:'quota-wait',paused:false,current:{number:40,stage:'implement',session:'PRIVATE_SESSION',worktree:'PRIVATE_PATH',progress:'PHI_TEXT',failures:1,quotaWaits:2},lastReason:'quota_wait',nextRetryAt:Date.now()+900_000,quotaWaitStarted:Date.now()}),{mode:0o600});
 return {root,worker,source,replacement,registry,attestationPath};
}
const attestation=(plan:RecoveryPlan)=>({version:1,requestId:randomUUID(),registryFingerprint:plan.registryFingerprint,planFingerprint:plan.planFingerprint,replacementDirectory:plan.replacementDirectory,scope:'all-registered-workers',allControllersAndWorkersStopped:true,restartsDisabled:true});
async function approve(f:Awaited<ReturnType<typeof fixture>>,value?:unknown){await writeFile(f.attestationPath,JSON.stringify(value??attestation(await recoveryPlan(f.registry,f.source,f.replacement))),{mode:0o600});}
test('read-only recovery plan is bound to raw evidence and excludes all private data',async t=>{
 const f=await fixture(t);const before=await readFile(join(f.worker,'state.json'),'utf8');const plan=await recoveryPlan(f.registry,f.source,f.replacement);
 assert.equal(plan.status,'ready-for-attestation');assert.equal(plan.oldControllerLock,true);assert.equal(plan.dispatchLock,true);assert.equal(plan.repositories[0]?.status,'quota-wait');assert.equal(plan.repositories[0]?.issue,40);
 for(const canary of ['TOKEN_CANARY','PRIVATE_SESSION','PRIVATE_PATH','PHI_TEXT'])assert.ok(!JSON.stringify(plan).includes(canary));assert.equal(await readFile(join(f.worker,'state.json'),'utf8'),before);
 await assert.rejects(readFile(join(f.source,'recovery.lock')),{code:'ENOENT'});
 await writeFile(join(f.source,'dispatch.json'),'changed',{mode:0o600});assert.notEqual((await recoveryPlan(f.registry,f.source,f.replacement)).planFingerprint,plan.planFingerprint);
});
test('explicit rotation preserves original locks/journals and worker bytes, retires old ownership and starts paused',async t=>{
 const f=await fixture(t);const paths=['controller.json','controller.lock','dispatch.json','dispatch.lock','scheduler.json','handoff.json'];const originals=await Promise.all(paths.map(path=>readFile(join(f.source,path),'utf8')));const worker=await readFile(join(f.worker,'state.json'),'utf8');await approve(f);
 const result=await reconcileOffline(f);assert.equal(result.status,'completed');assert.equal(result.dispatchPaused,true);
 assert.deepEqual(await Promise.all(paths.map(path=>readFile(join(f.source,path),'utf8'))),originals);assert.equal(await readFile(join(f.worker,'state.json'),'utf8'),worker);
 await assert.rejects(Controller.create(f.registry,f.source),/recovery_required/);await assert.rejects(dispatchOnce({registry:f.registry,directory:f.source,repositoryId:'test--repo',expectedIssue:40,handoff:{repositoryId:'test--repo',profile:'care-record-v1',standaloneStopped:true,scope:'all-registered-workers'},run:async()=>assert.fail('worker ran')}),/recovery_required/);
 const controller=await Controller.create(f.registry,f.replacement);assert.equal(controller.view().paused,true);assert.equal(controller.view().repositories?.[0]?.paused,true);assert.equal(controller.view().revision,0);
 const handoffs=await loadHandoff(join(f.replacement,'handoff.json'),f.registry);const scheduler=await Scheduler.create({registry:f.registry,controller,handoffs,snapshot:()=>collectSnapshot(f.registry),dispatch:async()=>assert.fail('must remain paused')});await scheduler.tick();assert.equal(scheduler.view().status,'paused');await scheduler.close();await controller.close();
 for(const path of ['controller.json','handoff.json','recovery-receipt.json'])assert.equal((await stat(join(f.replacement,path))).mode&0o777,0o600);
 assert.equal((await stat(f.replacement)).mode&0o777,0o700);await assert.rejects(readFile(replacementGate(f.replacement)),{code:'ENOENT'});
});
test('worker lock, unavailable state, missing confirmation, changed plan and wrong binding never rotate',async t=>{
 const f=await fixture(t);await writeFile(join(f.worker,'worker.lock'),'orphan',{mode:0o600});const blocked=await recoveryPlan(f.registry,f.source,f.replacement);assert.equal(blocked.status,'blocked');assert.equal(blocked.reason,'worker_lock_present');await approve(f);await assert.rejects(reconcileOffline(f),/recovery_blocked/);assert.equal(await readFile(join(f.worker,'worker.lock'),'utf8'),'orphan');await rm(join(f.worker,'worker.lock'));
 const valid=attestation(await recoveryPlan(f.registry,f.source,f.replacement));
 for(const value of [{...valid,allControllersAndWorkersStopped:false},{...valid,restartsDisabled:false},{...valid,planFingerprint:'0'.repeat(64)},{...valid,replacementDirectory:f.root},{...valid,scope:'one-worker'},{...valid,extra:'TOKEN_CANARY'}]){await writeFile(f.attestationPath,JSON.stringify(value),{mode:0o600});await assert.rejects(reconcileOffline(f),/attestation_invalid/);}
 await approve(f);await writeFile(join(f.worker,'state.json'),'{broken',{mode:0o600});assert.equal((await recoveryPlan(f.registry,f.source,f.replacement)).reason,'worker_state_unavailable');await assert.rejects(reconcileOffline(f),/recovery_blocked/);
 await assert.rejects(readFile(join(f.source,'recovery.lock')),{code:'ENOENT'});await assert.rejects(stat(f.replacement),{code:'ENOENT'});
});
test('private paths, file permissions, symlinks, existing destination and overlap fail closed',async t=>{
 const f=await fixture(t);const original=await recoveryPlan(f.registry,f.source,f.replacement);await approve(f);await rm(f.attestationPath);await writeFile(f.attestationPath,JSON.stringify(attestation(original)),{mode:0o644});await assert.rejects(reconcileOffline(f),/file_unsafe/);
 await rm(f.attestationPath);await symlink(join(f.source,'handoff.json'),f.attestationPath);await assert.rejects(reconcileOffline(f),/file_unsafe/);
 await assert.rejects(recoveryPlan(f.registry,f.source,join(f.worker,'nested')),/directory_unsafe/);await assert.rejects(recoveryPlan(f.registry,f.source,f.root),/directory_unsafe/);
 await mkdir(f.replacement);await assert.rejects(recoveryPlan(f.registry,f.source,f.replacement),/replacement_exists/);
});
test('partial provisioning preserves recovery gates and refuses both ownership paths',async t=>{
 const f=await fixture(t);await approve(f);await assert.rejects(reconcileOffline({...f,write:async()=>{throw new Error('synthetic disk failure');}}),/synthetic disk failure/);
 await assert.rejects(Controller.create(f.registry,f.source),/recovery_required/);await assert.rejects(Controller.create(f.registry,f.replacement),/recovery_required/);await assert.rejects(recoveryPlan(f.registry,f.source,f.replacement),/recovery_required/);
 assert.ok(await stat(join(f.source,'recovery.lock')));assert.ok(await stat(join(f.replacement,'recovery.lock')));assert.ok(await stat(replacementGate(f.replacement)));assert.ok(await stat(join(f.source,'dispatch.lock')));
});
test('destination provision gate prevents controller creation even before directory exists',async t=>{
 const f=await fixture(t);await writeFile(replacementGate(f.replacement),'pending',{mode:0o600});await assert.rejects(Controller.create(f.registry,f.replacement),/recovery_required/);await assert.rejects(stat(f.replacement),{code:'ENOENT'});
});
test('saved scheduler quota survives rotation even if current worker state is idle',async t=>{
 const f=await fixture(t);const deadline=Date.now()+1_800_000;await writeFile(join(f.source,'scheduler.json'),JSON.stringify({version:1,topology:registryFingerprint(f.registry),phase:'blocked',reason:'shared_quota_wait',nextRetryAt:deadline}),{mode:0o600});
 await writeFile(join(f.worker,'state.json'),JSON.stringify({version:1,repo:'test/repo',status:'idle',paused:false,current:null,lastReason:'completed',nextRetryAt:null,quotaWaitStarted:null}),{mode:0o600});await approve(f);await reconcileOffline(f);
 const controller=await Controller.create(f.registry,f.replacement);await controller.apply({requestId:randomUUID(),expectedRevision:0,target:'global',action:'resume'});await controller.apply({requestId:randomUUID(),expectedRevision:1,target:'test--repo',action:'resume'});
 const scheduler=await Scheduler.create({registry:f.registry,controller,handoffs:await loadHandoff(join(f.replacement,'handoff.json'),f.registry),snapshot:()=>collectSnapshot(f.registry),dispatch:async()=>assert.fail('quota was lost')});await scheduler.tick();assert.equal(scheduler.view().reason,'shared_quota_wait');assert.equal(scheduler.view().nextRetryAt,new Date(deadline).toISOString());await scheduler.close();await controller.close();
});
test('unknown quota stays blocked after rotation; malformed quota evidence refuses the plan',async t=>{
 const f=await fixture(t);await writeFile(join(f.source,'scheduler.json'),JSON.stringify({version:1,topology:registryFingerprint(f.registry),phase:'blocked',reason:'shared_quota_wait',nextRetryAt:null}),{mode:0o600});assert.equal((await recoveryPlan(f.registry,f.source,f.replacement)).unknownQuota,true);await approve(f);await reconcileOffline(f);
 const controller=await Controller.create(f.registry,f.replacement);const scheduler=await Scheduler.create({registry:f.registry,controller,handoffs:await loadHandoff(join(f.replacement,'handoff.json'),f.registry),snapshot:()=>collectSnapshot(f.registry),dispatch:async()=>assert.fail('unknown quota')});assert.equal(scheduler.view().status,'blocked');assert.equal(scheduler.view().reason,'shared_quota_wait');await scheduler.close();await controller.close();
 const other=await fixture(t);await writeFile(join(other.source,'scheduler.json'),'{corrupt',{mode:0o600});assert.equal((await recoveryPlan(other.registry,other.source,other.replacement)).reason,'controller_evidence_unavailable');await approve(other);await assert.rejects(reconcileOffline(other),/recovery_blocked/);
});
test('CLI recovery plan is offline and rejects mixed execution flags before touching ownership',async t=>{
 const {execFileSync}=await import('node:child_process');const f=await fixture(t);const clone=f.registry.repositories[0]!.clonePath;
 execFileSync('git',['init',clone],{stdio:'ignore'});execFileSync('git',['-C',clone,'remote','add','origin','https://github.com/test/repo.git'],{stdio:'ignore'});
 const config=join(f.root,'registry.json');await writeFile(config,JSON.stringify(f.registry),{mode:0o600});
 const args=['--experimental-strip-types',new URL('../src/cli.ts',import.meta.url).pathname,'--registry',config,'--controller-state',f.source,'--recovery-plan',f.replacement];
 const output=execFileSync(process.execPath,args,{encoding:'utf8'});const plan=JSON.parse(output);assert.equal(plan.status,'ready-for-attestation');assert.equal(plan.oldControllerLock,true);
 for(const canary of ['TOKEN_CANARY','PRIVATE_SESSION','PHI_TEXT'])assert.ok(!output.includes(canary));
 assert.throws(()=>execFileSync(process.execPath,[...args,'--execute','--github'],{stdio:'pipe'}));await assert.rejects(readFile(join(f.source,'recovery.lock')),{code:'ENOENT'});
});

async function interruptRotation(f:Awaited<ReturnType<typeof fixture>>,cut='controller.json'){
 await approve(f);await assert.rejects(reconcileOffline({...f,write:async(dir,name,value)=>{await writeFile(join(dir,name),JSON.stringify(value)+'\n',{mode:0o600});if(name===cut)throw new Error('synthetic power loss');}}),/synthetic power loss/);
}
async function approveResume(f:Awaited<ReturnType<typeof fixture>>){const plan=await recoveryResumePlan(f.registry,f.source,f.replacement);const value={version:1,requestId:randomUUID(),registryFingerprint:plan.registryFingerprint,resumeFingerprint:plan.resumeFingerprint,replacementDirectory:f.replacement,scope:'all-registered-workers',allControllersAndWorkersStopped:true,restartsDisabled:true,recoveryCommandsStopped:true};await writeFile(f.attestationPath,JSON.stringify(value),{mode:0o600});return {plan,value};}
test('journal replay completes every interrupted file boundary with paused settings and unchanged source data',async t=>{
 for(const cut of ['retired.json','controller.json','handoff.json','recovery-quota.json','recovery-receipt.json']){
  const f=await fixture(t);const source=await readFile(join(f.source,'controller.json'),'utf8');const state=await readFile(join(f.worker,'state.json'),'utf8');await interruptRotation(f,cut);
  const {plan}=await approveResume(f);assert.equal(plan.status,'ready-for-attestation');for(const canary of ['PRIVATE_SESSION','PHI_TEXT','TOKEN_CANARY'])assert.ok(!JSON.stringify(plan).includes(canary));
  const existing=await readFile(join(f.replacement,'recovery.lock'),'utf8');assert.ok(existing);const result=await resumeRecoveryOffline(f);assert.equal(result.status,'completed');
  assert.equal(await readFile(join(f.source,'controller.json'),'utf8'),source);assert.equal(await readFile(join(f.worker,'state.json'),'utf8'),state);assert.ok(await stat(join(f.source,'dispatch.lock')));
  const controller=await Controller.create(f.registry,f.replacement);assert.equal(controller.view().paused,true);assert.equal(controller.view().repositories?.[0]?.paused,true);await controller.close();assert.equal((await recoveryResumePlan(f.registry,f.source,f.replacement)).status,'completed');
 }
});
test('interrupted replay requires a renewed fingerprint and confirmation and never replays an old claim',async t=>{
 for(const cut of ['claimed','retired','controller.json','completed','target-released']){
  const f=await fixture(t);await interruptRotation(f,'retired.json');const first=await approveResume(f);
  await assert.rejects(resumeRecoveryOffline({...f,checkpoint:async phase=>{if(phase===cut)throw new Error('synthetic replay interruption');}}),/synthetic replay interruption/);
  const changed=await recoveryResumePlan(f.registry,f.source,f.replacement);assert.notEqual(changed.resumeFingerprint,first.plan.resumeFingerprint);await assert.rejects(resumeRecoveryOffline(f),/attestation_invalid/);
  await approveResume(f);await resumeRecoveryOffline(f);assert.equal((await recoveryResumePlan(f.registry,f.source,f.replacement)).status,'completed');
 }
});
test('replay rejects changed files, new worker locks, unexpected runtime files and missing explicit recovery stop',async t=>{
 for(const change of ['target','source','worker-lock','runtime']){
  const f=await fixture(t);await interruptRotation(f);await approveResume(f);
  if(change==='target'){const file=join(f.replacement,'controller.json');const raw=JSON.parse(await readFile(file,'utf8'));raw.paused=false;await writeFile(file,JSON.stringify(raw),{mode:0o600});}
  if(change==='source')await writeFile(join(f.source,'dispatch.lock'),'changed',{mode:0o600});
  if(change==='worker-lock')await writeFile(join(f.worker,'worker.lock'),'orphan',{mode:0o600});
  if(change==='runtime')await writeFile(join(f.replacement,'controller.lock'),'active',{mode:0o600});
  await assert.rejects(resumeRecoveryOffline(f),/target_changed|source_changed/);await assert.rejects(Controller.create(f.registry,f.replacement),/recovery_required/);
 }
 const f=await fixture(t);await interruptRotation(f);const {value}=await approveResume(f);await writeFile(f.attestationPath,JSON.stringify({...value,recoveryCommandsStopped:false}),{mode:0o600});await assert.rejects(resumeRecoveryOffline(f),/attestation_invalid/);
});
test('concurrent same-plan replay has one claimant; completed retries do not overwrite live preferences',async t=>{
 const f=await fixture(t);await interruptRotation(f);await approveResume(f);const results=await Promise.allSettled([resumeRecoveryOffline(f),resumeRecoveryOffline(f)]);assert.equal(results.filter(v=>v.status==='fulfilled').length,1);
 const controller=await Controller.create(f.registry,f.replacement);await controller.apply({requestId:randomUUID(),expectedRevision:0,target:'global',action:'resume'});const before=await readFile(join(f.replacement,'controller.json'),'utf8');assert.equal((await resumeRecoveryOffline(f)).status,'completed');assert.equal(await readFile(join(f.replacement,'controller.json'),'utf8'),before);await controller.close();
});
test('replay can provision a not-yet-created destination; legacy marker without journal is unavailable',async t=>{
 const f=await fixture(t);await interruptRotation(f,'retired.json');await rm(f.replacement,{recursive:true,force:true});await rm(replacementGate(f.replacement));await approveResume(f);await resumeRecoveryOffline(f);assert.equal((await recoveryResumePlan(f.registry,f.source,f.replacement)).status,'completed');
 const old=await fixture(t);await writeFile(join(old.source,'recovery.lock'),'legacy',{mode:0o600});await assert.rejects(recoveryResumePlan(old.registry,old.source,old.replacement),/journal_missing/);
});

test('resume CLI prints a private-safe plan and completes only with offline renewed approval',async t=>{
 const {execFileSync}=await import('node:child_process');const f=await fixture(t);const clone=f.registry.repositories[0]!.clonePath;execFileSync('git',['init',clone],{stdio:'ignore'});execFileSync('git',['-C',clone,'remote','add','origin','https://github.com/test/repo.git'],{stdio:'ignore'});const config=join(f.root,'registry.json');await writeFile(config,JSON.stringify(f.registry),{mode:0o600});await interruptRotation(f);
 const base=['--experimental-strip-types',new URL('../src/cli.ts',import.meta.url).pathname,'--registry',config,'--controller-state',f.source];const output=execFileSync(process.execPath,[...base,'--recovery-resume-plan',f.replacement],{encoding:'utf8'});assert.equal(JSON.parse(output).status,'ready-for-attestation');for(const canary of ['PRIVATE_SESSION','PHI_TEXT','TOKEN_CANARY'])assert.ok(!output.includes(canary));
 assert.throws(()=>execFileSync(process.execPath,[...base,'--resume-recovery',f.replacement,'--attestation',f.attestationPath,'--github'],{stdio:'pipe'}));await approveResume(f);const result=JSON.parse(execFileSync(process.execPath,[...base,'--resume-recovery',f.replacement,'--attestation',f.attestationPath],{encoding:'utf8'}));assert.equal(result.alreadyCompleted,false);assert.equal(result.dispatchPaused,true);
 const repeated=await resumeRecoveryOffline(f);assert.equal(repeated.alreadyCompleted,true);assert.equal(repeated.dispatchPaused,null);
});

test('a second rotation before scheduler startup retains inherited quota floors',async t=>{
 const f=await fixture(t);const deadline=Date.now()+1_800_000;await writeFile(join(f.source,'scheduler.json'),JSON.stringify({version:1,topology:registryFingerprint(f.registry),phase:'blocked',reason:'shared_quota_wait',nextRetryAt:deadline}),{mode:0o600});await writeFile(join(f.worker,'state.json'),JSON.stringify({version:1,repo:'test/repo',status:'idle',paused:false,current:null,lastReason:'completed',nextRetryAt:null,quotaWaitStarted:null}),{mode:0o600});await approve(f);await reconcileOffline(f);
 const second={...f,source:f.replacement,replacement:join(f.root,'second-replacement')};assert.equal((await recoveryPlan(second.registry,second.source,second.replacement)).nextRetryAt,new Date(deadline).toISOString());await approve(second);await reconcileOffline(second);assert.equal(JSON.parse(await readFile(join(second.replacement,'recovery-quota.json'),'utf8')).nextRetryAt,deadline);
});

test('parallel journals and admission evidence bind recovery and retain shared quota',async t=>{
 const f=await fixture(t);const deadline=Date.now()+3600000;const path=join(f.source,'dispatch.test--repo.json');
 await writeFile(path,JSON.stringify({version:1,status:'settled',repositoryId:'test--repo',issue:40,reservationId:randomUUID(),outcome:{version:1,issue:40,status:'quota-wait',paused:false,currentIssue:40,nextRetryAt:deadline}}),{mode:0o600});
 await writeFile(join(f.source,'dispatch-admission.lock'),'admission',{mode:0o600});const first=await recoveryPlan(f.registry,f.source,f.replacement);assert.equal(first.nextRetryAt,new Date(deadline).toISOString());assert.equal(first.dispatchLock,true);
 await writeFile(path,JSON.stringify({version:1,status:'reserved',repositoryId:'test--repo',issue:40,reservationId:randomUUID(),outcome:null}),{mode:0o600});assert.notEqual((await recoveryPlan(f.registry,f.source,f.replacement)).planFingerprint,first.planFingerprint);
});
