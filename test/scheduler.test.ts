import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, mkdir, rm, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from '../src/controller.ts';
import { Scheduler } from '../src/scheduler.ts';
import { registryFingerprint, parseHandoff, loadHandoff } from '../src/handoff.ts';
import { projectState } from '../src/snapshot.ts';
import { startServer } from '../src/server.ts';
import type { Registry, Snapshot, ControlRequest } from '../src/types.ts';
import type { Handoff, DispatchOutcome } from '../src/worker-adapter.ts';
async function fixture() {
 const root=await realpath(await mkdtemp(join(tmpdir(),'scheduler-')));const clock={now:100_000};
 const registry:Registry={version:1,globalConcurrency:1,repositories:[]};
 for(const name of ['a','b']){await mkdir(join(root,'clone-'+name));await mkdir(join(root,'state-'+name));registry.repositories.push({id:'example--'+name,repo:'example/'+name,clonePath:join(root,'clone-'+name),stateDirectory:join(root,'state-'+name),enabled:true,ownership:'observe-only',defaultModel:'gpt-6.1-sol',defaultEffort:'medium',maximumConcurrency:1});}
 const controller=await Controller.create(registry,join(root,'controller'));
 const handoffs:Handoff[]=registry.repositories.map(repo=>({repositoryId:repo.id,profile:'care-record-v1',standaloneStopped:true,scope:'all-registered-workers'}));
 const snapshot:Snapshot={schemaVersion:1,generatedAt:new Date(clock.now).toISOString(),mode:'observe-only',controller:controller.view(),repositories:registry.repositories.map(repo=>projectState({version:1,repo:repo.repo,status:'idle',paused:false,current:null,nextRetryAt:null,quotaWaitStarted:null},repo,clock.now,clock.now)),queue:{status:'observed',reason:'observed',items:[],repositories:registry.repositories.map(repo=>({repositoryId:repo.id,repo:repo.repo,status:'observed',reason:'observed',updatedAt:new Date(clock.now).toISOString(),items:[{repositoryId:repo.id,repo:repo.repo,issue:11,priority:'p2',prioritySource:'default',dependencies:[],status:'ready',reason:'eligible'},{repositoryId:repo.id,repo:repo.repo,issue:10,priority:'p0',prioritySource:'metadata',dependencies:[],status:'ready',reason:'eligible'}]}))}};
 const request=(target:string,action:ControlRequest['action']):ControlRequest=>({requestId:randomUUID(),expectedRevision:controller.view().revision!,target,action});
 const resume=async()=>{for(const repo of registry.repositories)await controller.apply(request(repo.id,'resume'));await controller.apply(request('global','resume'));};
 return {root,clock,registry,controller,handoffs,snapshot,request,resume};
}
const outcome=(issue:number):DispatchOutcome=>({version:1,issue,status:'idle',paused:false,currentIssue:null,nextRetryAt:null});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
test('round-robin, priority, global slot and durable cursor survive restart',async t=>{
 const f=await fixture();const calls:string[]=[];let scheduler=await Scheduler.create({...f,snapshot:async()=>f.snapshot,now:()=>f.clock.now,dispatch:async(id,issue)=>{calls.push(id+':'+issue);return outcome(issue);}});
 t.after(async()=>{await scheduler.close();await f.controller.close();await rm(f.root,{recursive:true,force:true});});
 await scheduler.tick();assert.equal(calls.length,0);await f.resume();
 await scheduler.tick();await scheduler.settled();assert.deepEqual(calls,['example--a:10']);
 f.clock.now+=30_000;await scheduler.tick();await scheduler.settled();assert.deepEqual(calls,['example--a:10','example--b:10']);
 await scheduler.close();await f.controller.close();
 const controller=await Controller.create(f.registry,join(f.root,'controller'));f.controller=controller;
 scheduler=await Scheduler.create({...f,controller,snapshot:async()=>f.snapshot,now:()=>f.clock.now,dispatch:async(id,issue)=>{calls.push(id+':'+issue);return outcome(issue);}});
 f.clock.now+=30_000;await scheduler.tick();await scheduler.settled();assert.equal(calls.at(-1),'example--a:10');
});
test('Pause acknowledges drain, prevents new jobs and becomes applied at safe boundary',async t=>{
 const f=await fixture();const pending=deferred<DispatchOutcome>();let count=0;
 const scheduler=await Scheduler.create({...f,snapshot:async()=>f.snapshot,now:()=>f.clock.now,dispatch:async()=>{count++;return pending.promise;}});
 t.after(async()=>{pending.resolve(outcome(10));await scheduler.close();await f.controller.close();await rm(f.root,{recursive:true,force:true});});
 await f.resume();await Promise.all([scheduler.tick(),scheduler.tick()]);assert.equal(count,1);assert.equal(scheduler.view().status,'running');
 const pause=f.request('global','pause');const ack=await f.controller.apply(pause);assert.equal(ack.application?.status,'draining');assert.equal(scheduler.view().status,'draining');
 await scheduler.tick();assert.equal(count,1);pending.resolve(outcome(10));await scheduler.settled();assert.equal(f.controller.ack(pause.requestId)?.application?.status,'applied');assert.equal(scheduler.view().status,'paused');
 f.clock.now+=30_000;await scheduler.tick();assert.equal(count,1);
 await f.controller.apply(f.request('global','resume'));assert.equal(f.controller.ack(pause.requestId)?.application?.status,'superseded');
});
test('Disable drains selected repository; human protection and saved current precedence remain',async t=>{
 const f=await fixture();const pending=deferred<DispatchOutcome>();const calls:string[]=[];
 f.snapshot.repositories[0]!.current={issue:55,stage:'publish',failures:1,quotaWaits:2,model:null,effort:null,reasonCategories:[],check:null,prUrl:null};
 const scheduler=await Scheduler.create({...f,snapshot:async()=>f.snapshot,now:()=>f.clock.now,dispatch:async(id,issue)=>{calls.push(id+':'+issue);return id==='example--a'?pending.promise:outcome(issue);}});
 t.after(async()=>{pending.resolve(outcome(55));await scheduler.close();await f.controller.close();await rm(f.root,{recursive:true,force:true});});
 await f.resume();await scheduler.tick();assert.equal(calls[0],'example--a:55');
 const disable=f.request('example--a','disable');assert.equal((await f.controller.apply(disable)).application?.status,'draining');
 pending.resolve(outcome(55));await scheduler.settled();f.clock.now+=30_000;
 f.snapshot.repositories[1]!.status='needs-human';f.snapshot.repositories[1]!.paused=true;
 await f.controller.apply(f.request('example--b','resume'));await scheduler.tick();assert.equal(calls.length,1);assert.equal(scheduler.view().reason,'needs_human');assert.equal(f.snapshot.repositories[1]!.paused,true);
 f.snapshot.repositories[1]!.status='idle';f.snapshot.repositories[1]!.paused=false;await scheduler.tick();await scheduler.settled();assert.equal(calls.at(-1),'example--b:10');
});
test('shared quota survives restart; stale/partial queues and unavailable worker state never dispatch',async t=>{
 const f=await fixture();let calls=0;let scheduler=await Scheduler.create({...f,snapshot:async()=>f.snapshot,now:()=>f.clock.now,dispatch:async(_id,issue)=>{calls++;return {...outcome(issue),status:'quota-wait',currentIssue:issue,nextRetryAt:200_000};}});
 t.after(async()=>{await scheduler.close();await f.controller.close();await rm(f.root,{recursive:true,force:true});});
 await f.resume();await scheduler.tick();await scheduler.settled();assert.equal(calls,1);await scheduler.close();await f.controller.close();
 f.controller=await Controller.create(f.registry,join(f.root,'controller'));
 scheduler=await Scheduler.create({...f,snapshot:async()=>f.snapshot,now:()=>f.clock.now,dispatch:async(_id,issue)=>{calls++;return outcome(issue);}});
 f.clock.now=150_000;await scheduler.tick();assert.equal(calls,1);assert.equal(scheduler.view().reason,'shared_quota_wait');
 f.clock.now=200_000;f.snapshot.queue.repositories.forEach(queue=>{queue.status='partial';});await scheduler.tick();assert.equal(calls,1);
 f.snapshot.queue.repositories.forEach(queue=>{queue.status='observed';queue.updatedAt=new Date(0).toISOString();});f.clock.now=400_000;await scheduler.tick();assert.equal(calls,1);
 f.snapshot.queue.repositories.forEach(queue=>{queue.updatedAt=new Date(f.clock.now).toISOString();});f.snapshot.repositories[1]!.freshness='unavailable';await scheduler.tick();assert.equal(calls,1);assert.equal(scheduler.view().reason,'worker_state_unavailable');
});
test('unknown execution completion blocks; restart retains orphan reservation even without a lock',async t=>{
 const f=await fixture();let scheduler=await Scheduler.create({...f,snapshot:async()=>f.snapshot,now:()=>f.clock.now,dispatch:async()=>{throw new Error('PRIVATE_ERROR');}});
 t.after(async()=>{await scheduler.close();await f.controller.close();await rm(f.root,{recursive:true,force:true});});
 await f.resume();await scheduler.tick();await scheduler.settled();assert.equal(scheduler.view().status,'blocked');assert.ok(!JSON.stringify(scheduler.view()).includes('PRIVATE_ERROR'));
 await scheduler.close();await f.controller.close();
 const saved=JSON.parse(await readFile(join(f.root,'controller/scheduler.json'),'utf8'));saved.phase='reserved';saved.reason='running';await writeFile(join(f.root,'controller/scheduler.json'),JSON.stringify(saved));
 f.controller=await Controller.create(f.registry,join(f.root,'controller'));
 scheduler=await Scheduler.create({...f,snapshot:async()=>f.snapshot,dispatch:async()=>assert.fail('orphan executed')});await scheduler.tick();assert.equal(scheduler.view().reason,'reconciliation_required');
});
test('Pause accepted while reading queue wins dispatch race; shutdown drains without killing',async t=>{
 const f=await fixture();const reading=deferred<Snapshot>();const pending=deferred<DispatchOutcome>();let calls=0;
 const scheduler=await Scheduler.create({...f,snapshot:async()=>reading.promise,now:()=>f.clock.now,dispatch:async()=>{calls++;return pending.promise;}});
 t.after(async()=>{reading.resolve(f.snapshot);pending.resolve(outcome(10));await scheduler.close();await f.controller.close();await rm(f.root,{recursive:true,force:true});});
 await f.resume();const tick=scheduler.tick();await f.controller.apply(f.request('global','pause'));reading.resolve(f.snapshot);await tick;assert.equal(calls,0);
 await f.controller.apply(f.request('global','resume'));await scheduler.tick();assert.equal(calls,1);
 let closed=false;const closing=scheduler.close().then(()=>{closed=true;});assert.equal(scheduler.view().status,'draining');assert.equal(closed,false);pending.resolve(outcome(10));await closing;assert.equal(closed,true);await scheduler.tick();assert.equal(calls,1);
});
test('handoff binds full registry and private file; no hidden enablement',async t=>{
 const f=await fixture();t.after(async()=>{await f.controller.close();await rm(f.root,{recursive:true,force:true});});
 const doc={version:1,registryFingerprint:registryFingerprint(f.registry),standaloneStopped:true,scope:'all-registered-workers',repositories:[{repositoryId:'example--a',profile:'care-record-v1'}]};
 assert.equal(parseHandoff(doc,f.registry).length,1);
 for(const bad of [{...doc,shell:'id'},{...doc,standaloneStopped:false},{...doc,registryFingerprint:'wrong'},{...doc,repositories:[...doc.repositories,...doc.repositories]}])assert.throws(()=>parseHandoff(bad,f.registry));
 const changed={...f.registry,repositories:f.registry.repositories.map(repo=>({...repo,stateDirectory:repo.stateDirectory+'-changed'}))};assert.throws(()=>parseHandoff(doc,changed));
 const file=join(f.root,'controller/handoff.json');await writeFile(file,JSON.stringify(doc),{mode:0o600});assert.equal((await loadHandoff(file,f.registry)).length,1);await chmod(file,0o644);await assert.rejects(loadHandoff(file,f.registry),/unsafe_handoff/);
});
test('authenticated HTTP Pause returns draining and receipt updates after job completion',async t=>{
 const f=await fixture();const pending=deferred<DispatchOutcome>();const scheduler=await Scheduler.create({...f,snapshot:async()=>f.snapshot,now:()=>f.clock.now,dispatch:async()=>pending.promise});
 await writeFile(join(f.root,'index.html'),'shell');const server=await startServer({snapshot:async()=>f.controller.project(f.snapshot),webDirectory:f.root,controller:f.controller});
 t.after(async()=>{pending.resolve(outcome(10));await scheduler.close();await server.close();await f.controller.close();await rm(f.root,{recursive:true,force:true});});
 await f.resume();await scheduler.tick();
 const login=await fetch(server.origin+'/api/session',{method:'POST',headers:{Origin:server.origin,'Content-Type':'application/json','X-Local-Bootstrap':'1'},body:JSON.stringify({nonce:new URL(server.launchUrl).hash.slice(1)})});
 const cookie=login.headers.get('set-cookie')!.split(';')[0]!;const {csrf}=await login.json() as {csrf:string};const command=f.request('global','pause');
 const response=await fetch(server.origin+'/api/controls',{method:'POST',headers:{Cookie:cookie,Origin:server.origin,'Content-Type':'application/json','X-Local-CSRF':csrf},body:JSON.stringify(command)});
 const ack=await response.json();assert.equal(response.status,200);assert.equal(ack.application.status,'draining');
 pending.resolve(outcome(10));await scheduler.settled();const applied=await (await fetch(server.origin+'/api/requests/'+command.requestId,{headers:{Cookie:cookie}})).json();assert.equal(applied.application.status,'applied');
});

test('reservation storage failure never starts worker or acknowledges applied controls',async t=>{
 const f=await fixture();let calls=0;const scheduler=await Scheduler.create({...f,snapshot:async()=>f.snapshot,now:()=>f.clock.now,dispatch:async(_id,issue)=>{calls++;return outcome(issue);}});
 t.after(async()=>{await scheduler.close();await f.controller.close();await rm(f.root,{recursive:true,force:true});});
 await f.resume();await rm(join(f.root,'controller/scheduler.json'));await mkdir(join(f.root,'controller/scheduler.json'));
 await scheduler.tick();assert.equal(calls,0);assert.equal(scheduler.view().status,'blocked');assert.equal(scheduler.view().reason,'storage_uncertain');
 const ack=await f.controller.apply(f.request('global','pause'));assert.equal(ack.application?.status,'blocked');
});
