import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { Controller } from '../src/controller.ts';
import { Approvals, approvalGit } from '../src/approvals.ts';
import { GitHubReviews, reviewComment, parseReviewState, readReevaluation, githubReviewApi, type GitHubReviewApi } from '../src/github-review.ts';
import { registryFingerprint } from '../src/handoff.ts';
import { collectSnapshot } from '../src/snapshot.ts';
import { Scheduler } from '../src/scheduler.ts';
import { parseRegistry } from '../src/registry.ts';
import type { Registry } from '../src/types.ts';

async function fixture(t:test.TestContext,reasons=['security'],e2e:{specs:string[];projects:string[]}|null=null,options:{canonicalSpecs?:string[];reviewPolicy?:'local-automatic'}={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'github-review-'))),clone=join(root,'clone'),stateDirectory=join(root,'worker');await mkdir(clone);await mkdir(stateDirectory,{mode:0o700});
 const repo={id:'test--repo',repo:'test/repo',clonePath:clone,stateDirectory,enabled:true,ownership:'observe-only' as const,defaultModel:'gpt-6.1-sol' as const,defaultEffort:'medium' as const,maximumConcurrency:1 as const,githubReview:{reviewerIds:[12],e2e},...options};
 const registry:Registry={version:1,globalConcurrency:1,repositories:[repo]},clock={now:100000};
 const git=(args:string[],cwd=clone)=>approvalGit('git',args,{cwd});await git(['init','-b','main']);await git(['config','user.name','Test']);await git(['config','user.email','test@example.invalid']);await writeFile(join(clone,'file.txt'),'base\n');await git(['add','.']);await git(['commit','-m','base']);const base=await git(['rev-parse','HEAD']);
 const worktree=join(stateDirectory,'worktrees/issue-59');await mkdir(join(stateDirectory,'worktrees'));await git(['worktree','add','-b','codex/issue-59-test',worktree,base]);await writeFile(join(worktree,'file.txt'),'implemented\n');
 const current:Record<string,unknown>={number:59,branch:'codex/issue-59-test',worktree,base,session:'private-session',failures:0,quotaWaits:0,stage:'implement',humanReasons:reasons,result:{reasons:reasons.filter(r=>['local_verification','sandbox_capability'].includes(r)).map(category=>({category,check:'test:ui'}))}};
 const saved={version:1,repo:repo.repo,status:'needs-human',paused:true,current,quotaWaitStarted:null,nextRetryAt:null,lastReason:'needs_human'};
 const save=()=>writeFile(join(stateDirectory,'state.json'),JSON.stringify(saved),{mode:0o600});await save();
 const issue={number:59,state:'open',labels:[{name:'codex:needs-human'}],body:'Private Issue details',updated_at:new Date(clock.now).toISOString()};
 const read=async(_repo:string,resource:string)=>resource.includes('pulls?')||resource.includes('/timeline?')?[]:resource==='issues/59'?issue:{number:Number(resource.split('/')[1]),state:'closed'};
 let controller=await Controller.create(registry,join(root,'controller'));const handoff={version:1,registryFingerprint:registryFingerprint(registry),standaloneStopped:true,scope:'all-registered-workers',repositories:[{repositoryId:repo.id,profile:'care-record-v1'}]};await writeFile(join(controller.directoryPath(),'handoff.json'),JSON.stringify(handoff),{mode:0o600});
 let approvals=await Approvals.create(registry,controller,{read});
 const comments=new Map<number,{id:number;body:string;user:{id:number;login:string};issue_url:string}>();let posts=0,patches=0;
 const reactions:{id:number;content:string;user:{id:number;login:string};created_at:string}[]=[];const calls:{method:string;resource:string}[]=[];let failResource:string|null=null;
 const canonical={content:'Canonical base decision',mode:'100644'};
 const api:GitHubReviewApi=async(method,resource,payload)=>{
  calls.push({method,resource});if(failResource&&resource.includes(failResource))throw new Error('PRIVATE stdout secret');
  const blobSha=createHash('sha1').update(`blob ${Buffer.byteLength(canonical.content)}\0`).update(canonical.content).digest('hex');
  if(resource.endsWith('/commits?per_page=1'))return [{sha:'c'.repeat(40),commit:{tree:{sha:'a'.repeat(40)}}}];
  if(resource.endsWith('/git/trees/'+'a'.repeat(40)))return {sha:'a'.repeat(40),truncated:false,tree:[{path:'docs',sha:'b'.repeat(40),type:'tree',mode:'040000'}]};
  if(resource.endsWith('/git/trees/'+'b'.repeat(40)))return {sha:'b'.repeat(40),truncated:false,tree:[{path:'system-decisions.md',sha:blobSha,type:'blob',mode:canonical.mode}]};
  if(resource.endsWith('/git/blobs/'+blobSha))return {sha:blobSha,encoding:'base64',size:Buffer.byteLength(canonical.content),content:Buffer.from(canonical.content).toString('base64')};
  if(resource==='user')return {id:77,login:'manager'};
  if(resource===`repos/${repo.repo}`)return {full_name:repo.repo,owner:{id:11,type:'User',login:'owner'}};
  if(resource.includes('/reactions?'))return structuredClone(reactions);
  if(method==='POST'){posts++;const comment={id:101,body:payload!.body,user:{id:77,login:'manager'},issue_url:'https://api.github.com/repos/test/repo/issues/59'};comments.set(comment.id,comment);return structuredClone(comment);}
  const number=Number(resource.split('/').at(-1));const comment=comments.get(number);if(!comment)throw new Error('unknown comment');
  if(method==='PATCH'){patches++;comment.body=payload!.body;}return structuredClone(comment);
 };
 let reviews=await GitHubReviews.create(registry,controller,approvals,{api,now:()=>clock.now});
 const snapshot=async()=>reviews.project(await approvals.project(controller.project(await collectSnapshot(registry,clock.now))));
 const tick=async()=>reviews.tick(await snapshot());
 const thumb=(actorId=11,content='+1')=>{clock.now+=1000;reactions.push({id:reactions.length+1,content,user:{id:actorId,login:'owner'},created_at:new Date(clock.now).toISOString()});};
 const document=async()=>JSON.parse(await readFile(join(controller.directoryPath(),'github-reviews.json'),'utf8'));
 const restart=async()=>{await controller.close();controller=await Controller.create(registry,join(root,'controller'));approvals=await Approvals.create(registry,controller,{read});reviews=await GitHubReviews.create(registry,controller,approvals,{api,now:()=>clock.now});};
 const resume=async()=>{for(const target of [repo.id,'global'])await controller.apply({requestId:randomUUID(),expectedRevision:controller.view().revision!,target,action:'resume'});};
 t.after(async()=>{await controller.close();await rm(root,{recursive:true,force:true});});
 return {root,repo,registry,canonical,clock,current,saved,issue,save,git,worktree,comments,reactions,calls,api,get controller(){return controller;},get approvals(){return approvals;},get reviews(){return reviews;},tick,thumb,snapshot,document,restart,resume,get posts(){return posts;},get patches(){return patches;},fail:(resource:string|null)=>{failResource=resource;}};
}

test('current manager request + stable owner thumbs-up records isolated private grants; polling/restart are idempotent',async t=>{
 const f=await fixture(t,['db','auth','permission','tenant','security','retention','manual_e2e'],{specs:['auth'],projects:['chromium','mobile-chrome']});const workerBefore=await readFile(join(f.repo.stateDirectory,'state.json'),'utf8');
 await f.tick();assert.equal(f.posts,1);assert.match(f.comments.get(101)!.body,/security: approval required/);assert.match(f.comments.get(101)!.body,/Local E2E specs: auth/);
 f.thumb();await f.tick();assert.equal(f.approvals.revision(),7);assert.equal((await f.snapshot()).repositories[0]!.current!.approvals!.every(item=>item.status==='approved'),true);
 assert.match(f.comments.get(101)!.body,/Worker: resuming/);assert.equal(await readFile(join(f.repo.stateDirectory,'state.json'),'utf8'),workerBefore);
 await f.tick();await f.restart();await f.tick();assert.equal(f.approvals.revision(),7);assert.equal(f.posts,1);
 const bytes=await readFile(join(f.controller.directoryPath(),'github-reviews.json'),'utf8');for(const forbidden of ['private-session',f.worktree,f.issue.body,'PRIVATE stdout'])assert.ok(!bytes.includes(forbidden));assert.equal((await stat(join(f.controller.directoryPath(),'github-reviews.json'))).mode&0o777,0o600);
});
test('login lookalikes, unrelated comments, free text and labels never authorize; configured stable reviewer can approve',async t=>{
 const f=await fixture(t);await f.tick();f.thumb(99);await f.tick();assert.equal(f.approvals.revision(),0);
 f.issue.body+=' approved';f.issue.labels.push({name:'codex:ready'});await f.tick();await f.tick();assert.equal(f.approvals.revision(),0);
 assert.ok(f.calls.filter(call=>call.resource.includes('/reactions?')).every(call=>call.resource.includes('/comments/101/')));
 f.thumb(12);await f.tick();assert.equal(f.approvals.revision(),1);
});
for(const tamper of ['author','comment_id','marker','body'] as const)test(`forged request ${tamper} is rejected despite owner reaction`,async t=>{
 const f=await fixture(t);await f.tick();f.thumb();const comment=f.comments.get(101)!;
 if(tamper==='author')comment.user.id=99;if(tamper==='comment_id')comment.id=102;if(tamper==='marker')comment.body=comment.body.replace(/codex-worker-review: [a-f0-9-]+/,'codex-worker-review: '+randomUUID());if(tamper==='body')comment.body+=' approved';
 await assert.rejects(f.tick(),/untrusted/);assert.equal(f.approvals.revision(),0);
});
test('diff/Issue changes rotate the same comment; old reaction cannot approve a new request or stale private grant',async t=>{
 const f=await fixture(t);await f.tick();const first=(await f.document()).requests[0].requestId;f.thumb();
 await writeFile(join(f.worktree,'file.txt'),'changed diff\n');await f.tick();assert.notEqual((await f.document()).requests[0].requestId,first);assert.equal(f.posts,1);await f.tick();assert.equal(f.approvals.revision(),0);
 f.thumb();await f.tick();assert.equal(f.approvals.revision(),1);await writeFile(join(f.worktree,'file.txt'),'new diff\n');await f.tick();await f.tick();assert.equal((await f.snapshot()).repositories[0]!.current!.approvals![0]!.status,'stale');assert.equal(f.approvals.revision(),1);
 f.issue.body+=' changed Issue revision';f.thumb();await f.tick();await f.tick();assert.equal(f.approvals.revision(),1);f.thumb();await f.tick();assert.equal(f.approvals.revision(),2);
});
test('reaction predating current request publication is not reused, even with an allowlisted owner',async t=>{
 const f=await fixture(t);f.thumb();await f.tick();await f.tick();assert.equal(f.approvals.revision(),0);f.thumb();await f.tick();assert.equal(f.approvals.revision(),1);
});
test('last approval automatically dispatches the saved job without ready label, queue insertion or extra Resume',async t=>{
 const f=await fixture(t);await f.resume();let dispatched=0;
 const scheduler=await Scheduler.create({registry:f.registry,controller:f.controller,handoffs:[{repositoryId:f.repo.id,profile:'care-record-v1',standaloneStopped:true,scope:'all-registered-workers'}],snapshot:async()=>{await f.tick();return f.snapshot();},now:()=>f.clock.now,dispatch:async(_id,issue)=>{assert.equal(issue,59);assert.equal(f.approvals.grants()[0]!.reason,'security');dispatched++;return {version:1,issue,status:'idle',paused:false,currentIssue:null,nextRetryAt:null};}});t.after(()=>scheduler.close());
 await scheduler.tick();assert.equal(dispatched,0);f.thumb();await scheduler.tick();await scheduler.settled();assert.equal(dispatched,1);
 assert.ok(!f.issue.labels.some(item=>item.name==='codex:ready'));assert.match(f.comments.get(101)!.body,/resuming/);
});
test('global Pause and Disable remain authoritative after a valid GitHub approval',async t=>{
 const f=await fixture(t);let dispatched=0;const scheduler=await Scheduler.create({registry:f.registry,controller:f.controller,handoffs:[{repositoryId:f.repo.id,profile:'care-record-v1',standaloneStopped:true,scope:'all-registered-workers'}],snapshot:async()=>{await f.tick();return f.snapshot();},dispatch:async()=>{dispatched++;throw new Error('unexpected');}});t.after(()=>scheduler.close());
 await f.tick();f.thumb();await scheduler.tick();assert.equal(f.approvals.revision(),1);assert.equal(dispatched,0);assert.equal(f.controller.view().paused,true);
});
test('operational-only review requires no reaction; exhaustion and forbidden categories cannot be approved',async t=>{
 const f=await fixture(t,['local_verification','sandbox_capability']);await f.tick();const body=f.comments.get(101)!.body;assert.match(body,/automatic retry/);assert.ok(!body.includes('承認対象'));assert.equal((await f.snapshot()).repositories[0]!.current!.recovery,'automatic_retry_pending');
 f.current.recoveryStatus='investigation';await f.save();await f.tick();assert.match(f.comments.get(101)!.body,/human investigation required/);f.thumb();await f.tick();assert.equal(f.approvals.revision(),0);
 f.current.humanReasons=['production','deploy','credential','destructive'];f.current.result={reasons:[]};await f.save();await f.tick();f.thumb();await f.tick();assert.equal(f.approvals.revision(),0);assert.ok(!f.comments.get(101)!.body.includes('承認対象'));
});
test('specification is never a grant: only a fresh post-revision thumbs-up triggers one saved-session reevaluation',async t=>{
 const f=await fixture(t,['specification']);await f.tick();f.thumb();await f.tick();assert.equal(f.approvals.revision(),0);assert.equal((await f.snapshot()).repositories[0]!.current!.reevaluationReady,undefined);
 f.clock.now+=1000;f.issue.body+=' canonical decision';f.issue.updated_at=new Date(f.clock.now).toISOString();await f.tick();assert.equal(await readReevaluation(f.controller.directoryPath(),f.registry,f.repo.id,59),undefined);
 f.thumb();await f.tick();assert.equal(f.approvals.revision(),0);let trigger=await readReevaluation(f.controller.directoryPath(),f.registry,f.repo.id,59);assert.ok(trigger);assert.equal((await f.snapshot()).repositories[0]!.current!.reevaluationReady,true);
 await f.restart();trigger=await readReevaluation(f.controller.directoryPath(),f.registry,f.repo.id,59);assert.ok(trigger);f.current.processedSpecificationDigest=trigger.issue.issueDigest;await f.save();assert.equal(await readReevaluation(f.controller.directoryPath(),f.registry,f.repo.id,59),undefined);
 await f.tick();assert.match(f.comments.get(101)!.body,/decision required/);assert.ok(!f.comments.get(101)!.body.includes('承認対象'));assert.equal(f.posts,1);
});
for(const resource of ['reactions?','repos/test/repo','user','issues/comments/101'])test(`GitHub API uncertainty at ${resource} never creates a grant or resumes`,async t=>{
 const f=await fixture(t);await f.tick();f.thumb();f.fail(resource);await assert.rejects(f.tick());assert.equal(f.approvals.revision(),0);assert.equal(f.controller.view().paused,true);
});
test('binding race between reaction and grant fails closed; uncertain grant persistence blocks controller',async t=>{
 const f=await fixture(t);await f.tick();f.thumb();
 const raced=await GitHubReviews.create(f.registry,f.controller,f.approvals,{now:()=>f.clock.now,api:async(method,resource,payload)=>{const value=await f.api(method,resource,payload);if(resource.includes('reactions?'))await writeFile(join(f.worktree,'file.txt'),'racing diff\n');return value;}});
 await assert.rejects(raced.tick(await f.snapshot()),/scope_changed/);assert.equal(f.approvals.revision(),0);
 await f.tick();f.thumb();await mkdir(join(f.controller.directoryPath(),'approvals.json'));await assert.rejects(f.tick(),/storage_uncertain/);assert.equal(f.controller.view().status,'blocked');
});
test('private request and fixed API schemas reject corruption, credentials, arbitrary routes and E2E flags',async t=>{
 const f=await fixture(t,['manual_e2e']);await f.tick();assert.match(f.comments.get(101)!.body,/explicit local E2E scope required/);f.thumb();await f.tick();assert.equal(f.approvals.revision(),0);
 const document=await f.document();document.requests[0].secret='private';assert.throws(()=>parseReviewState(document,f.registry));delete document.requests[0].secret;document.requests[0].requestId=randomUUID();assert.notEqual(reviewComment(document.requests[0]),f.comments.get(101)!.body);
 for(const githubReview of [{reviewerIds:['owner'],e2e:null},{reviewerIds:[11],e2e:{specs:['auth; id'],projects:['chromium']}},{reviewerIds:[11],e2e:null,command:'id'}])assert.throws(()=>parseRegistry({...f.registry,repositories:[{...f.repo,githubReview}]}));
 await assert.rejects(githubReviewApi('GET','repos/test/repo/../credentials'));await assert.rejects(githubReviewApi('POST','repos/test/repo/issues/59/comments',{body:'x',command:'id'} as never));
});
test('uncertain comment creation retains unpublished private request and prevents restart rather than duplicating it',async t=>{
 const f=await fixture(t);const reviews=await GitHubReviews.create(f.registry,f.controller,f.approvals,{api:async(method,resource,payload)=>{const value=await f.api(method,resource,payload);if(method==='POST')throw new Error('response lost');return value;},now:()=>f.clock.now});
 await assert.rejects(reviews.tick(await f.snapshot()),/publication_uncertain/);assert.equal(f.controller.view().status,'blocked');assert.equal(f.posts,1);await assert.rejects(GitHubReviews.create(f.registry,f.controller,f.approvals,{api:f.api}),/state_uncertain/);
});

test('Issue-only revision change requires a new current reaction even though the original #5 diff grant is valid',async t=>{
 const f=await fixture(t);await f.tick();f.thumb();await f.tick();assert.equal((await f.snapshot()).repositories[0]!.current!.githubReviewReady,true);
 f.issue.body+=' updated requirement';await f.tick();await f.tick();const job=(await f.snapshot()).repositories[0]!.current!;
 assert.equal(job.approvals![0]!.status,'approved');assert.equal(job.githubReviewReady,false);assert.match(f.comments.get(101)!.body,/security: stale/);assert.equal(f.approvals.revision(),1);
 f.thumb();await f.tick();assert.equal(f.approvals.revision(),2);assert.equal((await f.snapshot()).repositories[0]!.current!.githubReviewReady,true);
});
test('review status uses the same comment while running/idle and never publishes private worker state',async t=>{
 const f=await fixture(t);await f.tick();f.thumb();await f.tick();
 let active:{repositoryId:string;issue:number}|null={repositoryId:f.repo.id,issue:59};
 f.controller.attachRuntime({view:()=>({status:active?'running':'idle',reason:active?'running':'idle',active,managedRepositoryIds:[f.repo.id],nextRetryAt:null}),application:()=>({status:'applied',reason:'idle'})});
 await f.tick();assert.match(f.comments.get(101)!.body,/Worker: running/);active=null;f.saved.status='idle';f.saved.paused=false;f.saved.current=null as never;await f.save();await f.tick();assert.match(f.comments.get(101)!.body,/Worker: idle/);assert.equal(f.posts,1);
 for(const value of ['private-session',f.worktree,f.issue.body,'Private Issue details'])assert.ok(!f.comments.get(101)!.body.includes(value));
});

test('related PR and incomplete association observations block approval and automatic resume before dispatch',async t=>{
 const f=await fixture(t);await f.tick();f.thumb();
 for(const associations of [{pulls:[{head:{ref:'codex/issue-59-existing'}}],timeline:[]},{pulls:[],timeline:[{source:{issue:{state:'open',pull_request:{}}}}]},{pulls:[],timeline:Array.from({length:100},()=>({}))}]){
  const approvals=await Approvals.create(f.registry,f.controller,{read:async(_repo,resource)=>resource.startsWith('pulls?')?associations.pulls:resource.includes('/timeline?')?associations.timeline:f.issue});
  const reviews=await GitHubReviews.create(f.registry,f.controller,approvals,{api:f.api,now:()=>f.clock.now});await assert.rejects(reviews.tick(await f.snapshot()),/scope_unavailable/);assert.equal(approvals.revision(),0);
 }
});

test('specification reaction in the same timestamp second as body revision is ambiguous and cannot trigger reevaluation',async t=>{
 const f=await fixture(t,['specification']);await f.tick();f.clock.now+=1000;f.issue.body+=' decision';f.issue.updated_at=new Date(f.clock.now).toISOString();
 f.reactions.push({id:1,content:'+1',user:{id:11,login:'owner'},created_at:f.issue.updated_at});await f.tick();assert.equal(await readReevaluation(f.controller.directoryPath(),f.registry,f.repo.id,59),undefined);
 f.thumb();await f.tick();assert.ok(await readReevaluation(f.controller.directoryPath(),f.registry,f.repo.id,59));
});
test('unsupported manual E2E profile never displays an approval operation or converts a reaction into a grant',async t=>{
 const f=await fixture(t,['manual_e2e'],{specs:['auth'],projects:['chromium']});
 await writeFile(join(f.controller.directoryPath(),'handoff.json'),JSON.stringify({version:1,registryFingerprint:registryFingerprint(f.registry),standaloneStopped:true,scope:'all-registered-workers',repositories:[{repositoryId:f.repo.id,profile:'local-ai-manage-v1'}]}),{mode:0o600});
 await writeFile(join(f.repo.stateDirectory,'state.json'),JSON.stringify({...f.saved,profile:'local-ai-manage-v1'}),{mode:0o600});await f.tick();f.thumb();await f.tick();
 const body=f.comments.get(101)!.body;assert.match(body,/not approvable/);assert.ok(!body.includes('承認対象'));assert.equal(f.approvals.revision(),0);
});

test('specification plus manual E2E renews the current request after a decision; a separate fresh approval unblocks reevaluation',async t=>{
 const f=await fixture(t,['specification','manual_e2e','security'],{specs:['auth'],projects:['chromium']});await f.tick();f.thumb();await f.tick();assert.equal(f.approvals.revision(),2);
 const before=(await f.document()).requests[0].requestId;f.clock.now+=1000;f.issue.body+=' canonical decision';f.issue.updated_at=new Date(f.clock.now).toISOString();f.thumb();await f.tick();
 const renewed=(await f.document()).requests[0];assert.notEqual(renewed.requestId,before);assert.equal(renewed.reevaluation.requestId,renewed.requestId);assert.equal(f.approvals.revision(),2);assert.equal((await f.snapshot()).repositories[0]!.current!.githubReviewReady,false);
 await f.restart();await f.tick();assert.equal(f.approvals.revision(),2);assert.match(f.comments.get(101)!.body,/manual_e2e: stale/);
 f.thumb();await f.tick();assert.equal(f.approvals.revision(),4);assert.equal((await f.snapshot()).repositories[0]!.current!.githubReviewReady,true);assert.ok(await readReevaluation(f.controller.directoryPath(),f.registry,f.repo.id,59));assert.equal(f.posts,1);
});

test('canonical spec update without Issue body revision requires a new current reaction and only triggers saved reevaluation',async t=>{
 const f=await fixture(t,['specification'],null,{canonicalSpecs:['docs/system-decisions.md']});await f.tick();const initial=(await f.document()).requests[0].requestId;f.thumb();await f.tick();assert.equal(await readReevaluation(f.controller.directoryPath(),f.registry,f.repo.id,59),undefined);
 const body=f.issue.body;f.canonical.content='New canonical decision';await f.tick();assert.notEqual((await f.document()).requests[0].requestId,initial);await f.tick();assert.equal(await readReevaluation(f.controller.directoryPath(),f.registry,f.repo.id,59),undefined);
 f.thumb();await f.tick();assert.equal(f.approvals.revision(),0);const trigger=await readReevaluation(f.controller.directoryPath(),f.registry,f.repo.id,59);assert.ok(trigger?.canonical);assert.equal(f.issue.body,body);assert.equal((await f.snapshot()).repositories[0]!.current!.githubReviewReady,true);
 await f.restart();assert.ok(await readReevaluation(f.controller.directoryPath(),f.registry,f.repo.id,59));f.current.processedSpecificationRequestId=trigger.requestId;f.current.processedSpecificationDigest=trigger.issue.issueDigest;await f.save();await f.tick();assert.equal(await readReevaluation(f.controller.directoryPath(),f.registry,f.repo.id,59),undefined);assert.equal(f.posts,1);
 f.canonical.content='Second canonical decision';await f.tick();f.thumb();await f.tick();const next=await readReevaluation(f.controller.directoryPath(),f.registry,f.repo.id,59);assert.ok(next?.canonical);assert.notEqual(next.requestId,trigger.requestId);
 for(const privateValue of ['New canonical decision','Second canonical decision',f.worktree])assert.ok(!f.comments.get(101)!.body.includes(privateValue));
});
test('canonical API uncertainty, symlink and changed source binding prevent dispatch and grant reuse',async t=>{
 const f=await fixture(t,['security'],null,{canonicalSpecs:['docs/system-decisions.md']});await f.tick();f.thumb();await f.tick();assert.equal(f.approvals.revision(),1);
 f.canonical.content='Changed security specification';assert.equal((await f.snapshot()).repositories[0]!.current!.githubReviewReady,false);await f.tick();await f.tick();assert.equal(f.approvals.revision(),1);
 f.thumb();f.canonical.mode='120000';await assert.rejects(f.tick(),/scope_unavailable/);assert.equal((await f.snapshot()).repositories[0]!.current!.githubReviewReady,false);
 f.canonical.mode='100644';f.fail('/git/blobs/');await assert.rejects(f.tick(),/scope_unavailable/);assert.equal(f.approvals.revision(),1);
 assert.throws(()=>parseRegistry({...f.registry,repositories:[{...f.repo,canonicalSpecs:['docs/../../.env']}]}));
});
test('#59 automatic human categories and operational retry need no GitHub reaction or manual E2E scope',async t=>{
 const f=await fixture(t,['db','auth','permission','tenant','manual_e2e','security','local_verification','sandbox_capability'],null,{reviewPolicy:'local-automatic'});await f.tick();await f.tick();
 assert.equal(f.approvals.revision(),0);const job=(await f.snapshot()).repositories[0]!.current!;assert.equal(job.githubReviewReady,true);assert.ok(job.approvals!.every(item=>item.status==='automatic'));assert.match(f.comments.get(101)!.body,/security: automatic/);assert.ok(!f.comments.get(101)!.body.includes('承認対象'));assert.ok(!f.comments.get(101)!.body.includes('scope required'));
});

test('parked automatic review during quota wait preserves quota and lets the active session resume only after reset',async t=>{
 const f=await fixture(t,['auth','local_verification'],null,{reviewPolicy:'local-automatic'});
 const path=join(f.repo.stateDirectory,'state.json');const nextRetryAt=f.clock.now+1000;
 const active={...f.current,number:84,branch:'codex/issue-84-test',worktree:join(f.repo.stateDirectory,'worktrees/issue-84'),failures:1,quotaWaits:2,session:'active-saved-session'};
 const saved={...f.saved,status:'quota-wait',paused:false,current:active,nextRetryAt,quotaWaitStarted:f.clock.now,humanWaiting:[{current:f.current,reason:'needs_human',since:f.clock.now}]};
 await writeFile(path,JSON.stringify(saved),{mode:0o600});const before=await readFile(path,'utf8');
 const calls:number[]=[];const scheduler=await Scheduler.create({registry:f.registry,controller:f.controller,handoffs:[{repositoryId:f.repo.id,profile:'care-record-v1',standaloneStopped:true,scope:'all-registered-workers'}],snapshot:async()=>{await f.tick();return f.snapshot();},now:()=>f.clock.now,dispatch:async(_id,issue)=>{calls.push(issue);return {version:1,issue,status:'idle',paused:false,currentIssue:null,nextRetryAt:null};}});
 t.after(()=>scheduler.close());await f.resume();await scheduler.tick();
 assert.equal(f.posts,1);assert.deepEqual(calls,[]);assert.equal(scheduler.view().reason,'shared_quota_wait');assert.equal(f.approvals.revision(),0);
 f.clock.now=nextRetryAt;await scheduler.tick();await scheduler.settled();assert.deepEqual(calls,[84]);assert.equal(await readFile(path,'utf8'),before);
});


test('DB/E2E verification failure remains an investigation and can publish its fixed check identifier',async t=>{
 const f=await fixture(t,['local_verification']);
 f.current.recoveryStatus='investigation';f.current.repair={category:'local_verification',check:'local_db_e2e',diagnostic:'check_failed'};f.current.result={reasons:[{category:'local_verification',check:'local_db_e2e'}]};await f.save();
 await f.tick();assert.match(f.comments.get(101)!.body,/Check: local_db_e2e/);assert.match(f.comments.get(101)!.body,/human investigation required/);
 f.thumb();await f.tick();assert.equal(f.approvals.revision(),0);assert.equal((await f.snapshot()).repositories[0]!.current!.githubReviewReady,false);
 parseReviewState(await f.document(),f.registry);
});
