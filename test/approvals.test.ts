import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, mkdir, rm, writeFile, readFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from '../src/controller.ts';
import { Approvals, approvalGit, parseApproval, readApprovalGrants, type ApprovalRequest } from '../src/approvals.ts';
import { collectSnapshot } from '../src/snapshot.ts';
import { registryFingerprint } from '../src/handoff.ts';
import { startServer } from '../src/server.ts';
import type { Registry } from '../src/types.ts';

async function fixture(t:test.TestContext,number=48){
 const root=await realpath(await mkdtemp(join(tmpdir(),'human-approval-')));const clone=join(root,'clone'),state=join(root,'worker');
 await mkdir(clone);await mkdir(state,{mode:0o700});
 const repo={id:'test--repo',repo:'test/repo',clonePath:clone,stateDirectory:state,enabled:true,ownership:'observe-only' as const,defaultModel:'gpt-6.1-sol' as const,defaultEffort:'medium' as const,maximumConcurrency:1 as const};
 const registry:Registry={version:1,globalConcurrency:1,repositories:[repo]};
 const git=(args:string[],cwd=clone)=>approvalGit('git',args,{cwd});
 await git(['init','-b','main']);await git(['config','user.name','Test']);await git(['config','user.email','test@example.invalid']);
 await writeFile(join(clone,'file.txt'),'original\n');await git(['add','.']);await git(['commit','-m','base']);const base=await git(['rev-parse','HEAD']);
 let controller=await Controller.create(registry,join(root,'controller'));
 await writeFile(join(controller.directoryPath(),'handoff.json'),JSON.stringify({version:1,registryFingerprint:registryFingerprint(registry),standaloneStopped:true,scope:'all-registered-workers',repositories:[{repositoryId:repo.id,profile:'care-record-v1'}]}),{mode:0o600});
 const worktree=join(state,'worktrees',`issue-${number}`);const branch=`codex/issue-${number}-test`;
 const current:Record<string,unknown>={number,branch,worktree,stage:'prepare',failures:0,quotaWaits:0,session:null,preflight:{category:'manual_e2e',reason:'manual_e2e_required'}};
 const saved={version:1,repo:repo.repo,status:'needs-human',paused:true,current,quotaWaitStarted:null,nextRetryAt:null,lastReason:'manual_e2e_required'};
 const save=()=>writeFile(join(state,'state.json'),JSON.stringify(saved),{mode:0o600});await save();
 const issue={number,state:'open',labels:[{name:'codex:needs-human'}],body:'## Acceptance Criteria\nMust run E2E.\n'};
 const read=async(_repo:string,resource:string)=>resource.includes('pulls?')||resource.includes('/timeline?')?[]:resource===`issues/${number}`?issue:{number:Number(resource.split('/')[1]),state:'closed'};
 let approvals=await Approvals.create(registry,controller,{read});
 const request=(reason='manual_e2e'):ApprovalRequest=>({requestId:randomUUID(),expectedRevision:approvals.revision(),repositoryId:repo.id,issue:number,reason,e2e:reason==='manual_e2e'?{specs:['auth'],projects:['chromium','mobile-chrome']}:null});
 const restart=async()=>{await controller.close();controller=await Controller.create(registry,join(root,'controller'));approvals=await Approvals.create(registry,controller,{read});return approvals;};
 t.after(async()=>{await controller.close();await rm(root,{recursive:true,force:true});});
 const prepare=async()=>{await mkdir(join(state,'worktrees'));await git(['worktree','add','-b',branch,worktree,base]);current.base=base;current.stage='publish';delete current.preflight;saved.lastReason='parent_verification_safety_failed';await save();};
 return {root,repo,registry,get controller(){return controller;},get approvals(){return approvals;},request,current,saved,issue,save,prepare,git,base,worktree,restart};
}

test('explicit preflight grant is private, idempotent and survives restart; changed body is stale',async t=>{
 const f=await fixture(t);const before=await readFile(join(f.repo.stateDirectory,'state.json'),'utf8');const command=f.request();
 const ack=await f.approvals.apply(command);assert.equal(ack.status,'recorded');assert.deepEqual(await f.approvals.apply(command),ack);
 assert.equal(await readFile(join(f.repo.stateDirectory,'state.json'),'utf8'),before);assert.equal(f.controller.view().paused,true);
 assert.equal((await stat(join(f.controller.directoryPath(),'approvals.json'))).mode&0o777,0o600);
 const bytes=await readFile(join(f.controller.directoryPath(),'approvals.json'),'utf8');assert.ok(!bytes.includes(f.issue.body));assert.ok(!bytes.includes(f.repo.stateDirectory));
 let snapshot=await f.approvals.project(await collectSnapshot(f.registry));assert.equal(snapshot.repositories[0]?.current?.approvals?.[0]?.status,'approved');
 await f.restart();assert.deepEqual(await f.approvals.apply(command),ack);
 f.issue.body+='\nAdditional mobile acceptance condition';snapshot=await f.approvals.project(await collectSnapshot(f.registry));assert.equal(snapshot.repositories[0]?.current?.approvals?.[0]?.status,'stale');
 await f.restart();assert.equal((await f.approvals.project(await collectSnapshot(f.registry))).repositories[0]?.current?.approvals?.[0]?.status,'stale');
 await assert.rejects(f.approvals.apply({...command,e2e:{specs:['auth'],projects:['chromium']}}),/request_id_conflict/);
});

test('unregistered/wrong Issue/category, command injection and non-current reasons are rejected',async t=>{
 const f=await fixture(t);
 for(const command of [{...f.request(),repositoryId:'unknown--repo'},{...f.request(),issue:47},{...f.request(),reason:'production',e2e:null},{...f.request(),reason:'deploy',e2e:null},{...f.request(),reason:'credential',e2e:null},{...f.request(),reason:'destructive',e2e:null},{...f.request(),shell:'id'},{...f.request(),e2e:{specs:['auth; curl secret'],projects:['chromium']}},{...f.request(),e2e:{specs:['auth'],projects:['production']}},f.request('db')])await assert.rejects(async()=>f.approvals.apply(command));
 for(const reason of ['worktree_safety','sandbox_capability','external_service','unknown'])assert.throws(()=>parseApproval({...f.request(),reason,e2e:null},f.registry));
 assert.equal(f.approvals.revision(),0);
});

test('closed, blocked, failed and open dependencies never become authorized',async t=>{
 const f=await fixture(t);
 f.issue.state='closed';await assert.rejects(f.approvals.apply(f.request()),/ineligible/);f.issue.state='open';
 for(const name of ['codex:blocked','codex:failed','codex:running']){f.issue.labels=[{name}];await assert.rejects(f.approvals.apply(f.request()),/ineligible/);}
 f.issue.labels=[{name:'codex:needs-human'}];f.issue.body='<!-- codex-queue\ndepends_on: [47]\n-->\nMust run E2E';
 const service=await Approvals.create(f.registry,f.controller,{read:async(_repo,resource)=>resource==='issues/48'?f.issue:{number:47,state:'open'}});
 await assert.rejects(service.apply(f.request()),/dependency_blocked/);
});

test('CareRecord #47/#57/#59 bindings detect binary/untracked/protected content, base and HEAD changes',async t=>{
 const f=await fixture(t,59);await f.prepare();
 await mkdir(join(f.worktree,'supabase/migrations'),{recursive:true});await writeFile(join(f.worktree,'supabase/migrations/20261004_test.sql'),'CREATE POLICY tenant_policy ON records USING (tenant_id = 1);\n');
 f.current.humanReasons=['db','permission','tenant','security'];await f.save();
 for(const reason of ['db','permission','tenant','security'])await f.approvals.apply(f.request(reason));
 const statuses=async()=>((await f.approvals.project(await collectSnapshot(f.registry))).repositories[0]?.current?.approvals??[]).map(item=>item.status);
 assert.deepEqual(await statuses(),['approved','approved','approved','approved']);
 await f.restart();assert.deepEqual(await statuses(),['approved','approved','approved','approved']);
 await writeFile(join(f.worktree,'supabase/migrations/20261004_test.sql'),'CREATE POLICY tenant_policy ON records USING (true);\n');assert.ok((await statuses()).every(status=>status==='stale'));
 for(const reason of ['db','permission','tenant','security'])await f.approvals.apply(f.request(reason));
 await writeFile(join(f.worktree,'extra.bin'),Buffer.from([0,1,255]));assert.ok((await statuses()).every(status=>status==='stale'));
 for(const reason of ['db','permission','tenant','security'])await f.approvals.apply(f.request(reason));
 await f.git(['add','.'],f.worktree);await f.git(['commit','-m','new head'],f.worktree);assert.ok((await statuses()).every(status=>status==='stale'));
 f.current.base='a'.repeat(40);await f.save();assert.ok((await statuses()).every(status=>status==='stale'));
});

test('approval write failures block controller dispatch; active locks and unsafe saved state are preserved',async t=>{
 const f=await fixture(t);await writeFile(join(f.repo.stateDirectory,'worker.lock'),'existing');await assert.rejects(f.approvals.apply(f.request()),/worker_active/);assert.equal(await readFile(join(f.repo.stateDirectory,'worker.lock'),'utf8'),'existing');await rm(join(f.repo.stateDirectory,'worker.lock'));
 await mkdir(join(f.controller.directoryPath(),'approvals.json'));await assert.rejects(f.approvals.apply(f.request()),/storage_uncertain/);
 assert.equal(f.controller.view().status,'blocked');await assert.rejects(f.controller.dispatchGate(async()=>{}),/unavailable/);await assert.rejects(f.approvals.apply(f.request()),/unavailable/);
});

test('approval files reject public permissions, symlinks and inconsistent replay',async t=>{
 const f=await fixture(t);const outside=join(f.root,'outside.json');await writeFile(outside,'{}',{mode:0o600});const path=join(f.controller.directoryPath(),'approvals.json');
 await symlink(outside,path);await assert.rejects(readApprovalGrants(f.controller.directoryPath(),f.registry),/unsafe/);await rm(path);
 await f.approvals.apply(f.request());const raw=JSON.parse(await readFile(path,'utf8'));raw.operations[0].grant.reason='deploy';await writeFile(path,JSON.stringify(raw));await assert.rejects(readApprovalGrants(f.controller.directoryPath(),f.registry));
});

test('HTTP approval uses existing authentication/Origin/CSRF and exposes only a sanitized receipt',async t=>{
 const f=await fixture(t);await writeFile(join(f.root,'index.html'),'shell');
 const server=await startServer({webDirectory:f.root,controller:f.controller,approvals:f.approvals,snapshot:async()=>f.approvals.project(f.controller.project(await collectSnapshot(f.registry)))});t.after(()=>server.close());
 assert.equal((await fetch(server.origin+'/api/approvals',{method:'POST',body:'{}'})).status,401);
 const login=await fetch(server.origin+'/api/session',{method:'POST',headers:{Origin:server.origin,'Content-Type':'application/json','X-Local-Bootstrap':'1'},body:JSON.stringify({nonce:new URL(server.launchUrl).hash.slice(1)})});
 const cookie=login.headers.get('set-cookie')!.split(';')[0]!;const {csrf}=await login.json() as {csrf:string};const command=f.request();
 const headers={Cookie:cookie,Origin:server.origin,'Content-Type':'application/json','X-Local-CSRF':csrf};
 assert.equal((await fetch(server.origin+'/api/approvals',{method:'POST',headers:{...headers,'X-Local-CSRF':'wrong'},body:JSON.stringify(command)})).status,403);
 assert.equal((await fetch(server.origin+'/api/approvals',{method:'POST',headers:{...headers,Origin:'https://example.invalid'},body:JSON.stringify(command)})).status,403);
 const post=()=>fetch(server.origin+'/api/approvals',{method:'POST',headers,body:JSON.stringify(command)});
 const response=await post();assert.equal(response.status,200);const ack=await response.json();assert.deepEqual(await (await post()).json(),ack);
 assert.equal((await fetch(server.origin+'/api/controls',{method:'POST',headers,body:JSON.stringify({requestId:command.requestId,expectedRevision:0,target:'global',action:'resume'})})).status,409);
 assert.deepEqual(await (await fetch(server.origin+'/api/requests/'+command.requestId,{headers:{Cookie:cookie}})).json(),ack);
 const snapshot=await (await fetch(server.origin+'/api/status',{headers:{Cookie:cookie}})).text();assert.ok(snapshot.includes('approved'));for(const value of [f.repo.stateDirectory,f.issue.body,'diffDigest','issueDigest','session'])assert.ok(!snapshot.includes(value));
});

test('operational blockers never project Approval missing or accept grants; fixed recovery is separate',async t=>{
 const f=await fixture(t,59);await f.prepare();await writeFile(join(f.worktree,'file.txt'),'implemented\n');
 f.current.result={reasons:[{category:'local_verification',check:'test:ui'},{category:'sandbox_capability',check:'test:ui'}]};await f.save();
 let job=(await f.approvals.project(await collectSnapshot(f.registry))).repositories[0]!.current!;
 assert.deepEqual(job.approvals,[]);assert.equal(job.recovery,'automatic_retry_pending');
 for(const reason of ['local_verification','sandbox_capability','verification_retry_limit'])await assert.rejects(async()=>f.approvals.apply(f.request(reason)));
 f.current.recoveryStatus='investigation';await f.save();job=(await f.approvals.project(await collectSnapshot(f.registry))).repositories[0]!.current!;assert.equal(job.recovery,'human_investigation_required');
});

test('trusted opt-in #59 policy projects human categories automatic separately from operational recovery and survives restart',async t=>{
 const f=await fixture(t,59);await f.prepare();const registry:Registry={...f.registry,repositories:[{...f.repo,reviewPolicy:'local-automatic'}]};
 await writeFile(join(f.controller.directoryPath(),'handoff.json'),JSON.stringify({version:1,registryFingerprint:registryFingerprint(registry),standaloneStopped:true,scope:'all-registered-workers',repositories:[{repositoryId:f.repo.id,profile:'care-record-v1'}]}),{mode:0o600});
 f.current.humanReasons=['db','auth','permission','tenant','manual_e2e','security','retention','local_verification','sandbox_capability'];f.current.result={reasons:[{category:'local_verification',check:'test:ui'},{category:'sandbox_capability',check:'test:ui'}]};await f.save();
 const read=async(_repo:string,resource:string)=>resource.includes('pulls?')||resource.includes('/timeline?')?[]:f.issue;
 const approvals=await Approvals.create(registry,f.controller,{read});let job=(await approvals.project(await collectSnapshot(registry))).repositories[0]!.current!;
 assert.equal(job.recovery,'automatic_retry_pending');assert.equal(job.approvals!.length,7);assert.ok(job.approvals!.every(item=>item.status==='automatic'&&!item.approvable));assert.equal(approvals.grants().length,0);
 const restored=await Approvals.create(registry,f.controller,{read});job=(await restored.project(await collectSnapshot(registry))).repositories[0]!.current!;assert.ok(job.approvals!.every(item=>item.status==='automatic'));
 assert.notEqual(registryFingerprint(registry),registryFingerprint(f.registry));assert.equal(registryFingerprint({...f.registry,repositories:[{...f.repo,reviewPolicy:'manual'}]}),registryFingerprint(f.registry));
});
