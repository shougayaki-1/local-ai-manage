import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile, readFile, mkdir, symlink, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from '../src/controller.ts';
import { startServer } from '../src/server.ts';
import { demoSnapshot } from '../src/snapshot.ts';
import type { Registry, ControlRequest } from '../src/types.ts';
const registry:Registry={version:1,globalConcurrency:1,repositories:[{id:'example--care-record',repo:'example/care-record',clonePath:'/unused/clone',stateDirectory:'/unused/worker-state',enabled:false,ownership:'observe-only',defaultModel:'gpt-6.1-sol',defaultEffort:'medium',maximumConcurrency:1}]};
const command=(expectedRevision:number,target='global',action:ControlRequest['action']='resume'):ControlRequest=>({requestId:randomUUID(),expectedRevision,target,action});
async function fixture(t:test.TestContext) {const root=await realpath(await mkdtemp(join(tmpdir(),'local-ai-control-')));void t;return root;}
test('durable control, exclusive ownership, restart replay and idempotent retry',async t=>{
 const root=await fixture(t);const directory=join(root,'controller');let controller=await Controller.create(registry,directory);
 assert.equal(controller.view().paused,true);assert.equal(controller.view().repositories?.[0]?.paused,true);
 await assert.rejects(Controller.create(registry,directory));
 const request=command(0);const ack=await controller.apply(request);assert.equal(ack.revision,1);
 assert.deepEqual(await controller.apply({...request}),ack);
 await assert.rejects(controller.apply({...request,action:'pause'}),/request_id_conflict/);
 await assert.rejects(controller.apply(command(0)),/revision_conflict/);
 await controller.close();controller=await Controller.create(registry,directory);t.after(async()=>{await controller.close();await rm(root,{recursive:true,force:true});});
 assert.equal(controller.view().paused,false);assert.deepEqual(controller.ack(request.requestId),ack);assert.deepEqual(await controller.apply(request),ack);
 assert.equal((await stat(join(directory,'controller.json'))).mode&0o777,0o600);
 assert.equal((await stat(directory)).mode&0o777,0o700);
 await controller.apply(command(1,'example--care-record','enable'));await controller.apply(command(2,'example--care-record','resume'));
 assert.deepEqual(controller.view().repositories,[{id:'example--care-record',enabled:true,paused:false}]);
 assert.equal(controller.view().execution,'not-managed');
});
test('concurrent revisions serialize; invalid commands never change durable bytes',async t=>{
 const root=await fixture(t);const directory=join(root,'controller');const controller=await Controller.create(registry,directory);t.after(async()=>{await controller.close();await rm(root,{recursive:true,force:true});});
 const results=await Promise.allSettled([controller.apply(command(0)),controller.apply(command(0))]);assert.equal(results.filter(item=>item.status==='fulfilled').length,1);
 const bytes=await readFile(join(directory,'controller.json'),'utf8');
 for(const value of [{...command(1),shell:'id'},command(1,'unknown--repo'),command(1,'global','enable'),{...command(1),action:'reset'},{...command(1),action:['pause']},{...command(1),expectedRevision:-1}])await assert.rejects(async()=>controller.apply(value));
 assert.equal(await readFile(join(directory,'controller.json'),'utf8'),bytes);
});
test('crash lock, malformed state, changed topology and symlink paths fail closed',async t=>{
 const root=await fixture(t);t.after(()=>rm(root,{recursive:true,force:true}));const directory=join(root,'controller');const controller=await Controller.create(registry,directory);await controller.close();
 const original=await readFile(join(directory,'controller.json'),'utf8');
 await assert.rejects(Controller.create({...registry,repositories:[]},directory));
 await writeFile(join(directory,'controller.json'),'{broken');await assert.rejects(Controller.create(registry,directory));
 await writeFile(join(directory,'controller.json'),original);await writeFile(join(directory,'controller.lock'),'orphan');await assert.rejects(Controller.create(registry,directory));
 await mkdir(join(root,'real'),{mode:0o700});await symlink(join(root,'real'),join(root,'link'));await assert.rejects(Controller.create(registry,join(root,'link')));
 const shared={...registry,repositories:registry.repositories.map(repo=>({...repo,stateDirectory:root}))};await assert.rejects(Controller.create(shared,join(root,'nested')),/overlap/);
});
test('HTTP controls require authentication, Origin and CSRF; resume preserves human and quota state',async t=>{
 const root=await fixture(t);await writeFile(join(root,'index.html'),'shell');const directory=join(root,'controller');const controller=await Controller.create(registry,directory);
 const worker=demoSnapshot();const before=JSON.stringify(worker);const app=await startServer({snapshot:async()=>controller.project(worker),webDirectory:root,controller});t.after(async()=>{await app.close();await controller.close();await rm(root,{recursive:true,force:true});});
 assert.equal((await fetch(app.origin+'/api/controls',{method:'POST',body:'{}'})).status,401);
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json','X-Local-Bootstrap':'1'},body:JSON.stringify({nonce:new URL(app.launchUrl).hash.slice(1)})});
 const cookie=login.headers.get('set-cookie')!.split(';')[0]!;const {csrf}=await login.json() as {csrf:string};
 const request=command(0);const headers={Cookie:cookie,Origin:app.origin,'Content-Type':'application/json','X-Local-CSRF':csrf};
 assert.equal((await fetch(app.origin+'/api/controls',{method:'POST',headers:{...headers,'X-Local-CSRF':'bad'},body:JSON.stringify(request)})).status,403);
 const {Origin:ignored,...withoutOrigin}=headers;void ignored;
 assert.equal((await fetch(app.origin+'/api/controls',{method:'POST',headers:withoutOrigin,body:JSON.stringify(request)})).status,403);
 const post=()=>fetch(app.origin+'/api/controls',{method:'POST',headers,body:JSON.stringify(request)});
 const response=await post();assert.equal(response.status,200);const ack=await response.json();assert.deepEqual(await (await post()).json(),ack);
 assert.deepEqual(await (await fetch(app.origin+'/api/requests/'+request.requestId,{headers:{Cookie:cookie}})).json(),ack);
 assert.equal((await fetch(app.origin+'/api/controls',{method:'POST',headers,body:JSON.stringify(command(0))})).status,409);
 assert.equal((await fetch(app.origin+'/api/controls',{method:'POST',headers,body:JSON.stringify({...command(1),path:'/private/worker-state'})})).status,400);
 const snapshot=await (await fetch(app.origin+'/api/status',{headers:{Cookie:cookie}})).json() as ReturnType<typeof demoSnapshot>;
 assert.equal(snapshot.controller.paused,false);assert.equal(snapshot.repositories[0]?.status,'needs-human');assert.equal(snapshot.repositories[0]?.paused,true);assert.equal(snapshot.repositories[1]?.quota.status,'waiting');assert.equal(JSON.stringify(worker),before);
});

test('storage failure stops subsequent writes; inconsistent saved preferences are rejected',async t=>{
 const root=await fixture(t);const directory=join(root,'controller');const controller=await Controller.create(registry,directory);
 t.after(async()=>{await controller.close();await rm(root,{recursive:true,force:true});});
 await unlink(join(directory,'controller.json'));await mkdir(join(directory,'controller.json'));
 await assert.rejects(controller.apply(command(0)));assert.equal(controller.view().revision,0);
 await assert.rejects(controller.apply(command(0)),/controller_storage_uncertain/);
 const another=join(root,'another');const valid=await Controller.create(registry,another);await valid.close();
 const raw=JSON.parse(await readFile(join(another,'controller.json'),'utf8'));raw.paused=false;
 await writeFile(join(another,'controller.json'),JSON.stringify(raw));await assert.rejects(Controller.create(registry,another),/controller_state_invalid/);
});

test('saved human waiting overrides a ready label in the queue projection without mutating observation',async t=>{
 const root=await fixture(t);const controller=await Controller.create({...registry,globalConcurrency:2},join(root,'controller'));t.after(async()=>{await controller.close();await rm(root,{recursive:true,force:true});});
 const snapshot=demoSnapshot();const job=snapshot.repositories[0]!.current!;snapshot.repositories[0]!.humanWaiting=[{job:{...job,issue:73},reason:'needs_human',since:new Date(0).toISOString()}];
 const before=JSON.stringify(snapshot);assert.equal(controller.project(snapshot).queue.items[0]!.status,'needs-human');assert.equal(controller.view().globalConcurrency,2);assert.equal(JSON.stringify(snapshot),before);
});
