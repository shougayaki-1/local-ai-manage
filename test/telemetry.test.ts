import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, realpath, symlink } from 'node:fs/promises';
import { projectTelemetry } from '../src/telemetry.ts';
import { projectState, observeRepository } from '../src/snapshot.ts';
import type { Repository } from '../src/types.ts';
const repo:Repository={id:'test--repo',repo:'test/repo',stateDirectory:'/unused',clonePath:'/unused',enabled:false,ownership:'observe-only',defaultModel:'gpt-6.1-sol',defaultEffort:'medium',maximumConcurrency:1};
const raw={version:1,repo:repo.repo,status:'running',paused:false,current:{number:1,stage:'implement'},lastReason:'running'};
const sidecar=()=>({version:1,repo:repo.repo,runId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',sequence:1,updatedAt:1000,lifecycle:'active',issue:1,stage:'implement',status:'running',invocation:{issue:1,model:'gpt-6.1-sol',effort:'medium',source:'cli-spawn'},events:[{at:1000,type:'codex.started',issue:1,stage:'implement',status:'running'}]});
const snapshot=()=>projectState(raw,repo,1000,1000);
test('telemetry distinguishes updating, stale, stopped and CLI invocation from configured defaults',()=>{
 const value=sidecar();const result=snapshot();projectTelemetry(value,result,1001);assert.equal(result.heartbeat?.status,'updating');assert.equal(result.current?.model,'gpt-6.1-sol');assert.equal(result.logs.events[0]?.type,'codex.started');
 const stale=snapshot();projectTelemetry(value,stale,61001);assert.equal(stale.heartbeat?.status,'stale');assert.equal(stale.logs.status,'stale');
 const stopped=snapshot();projectTelemetry({...value,lifecycle:'stopped'},stopped,1001);assert.equal(stopped.heartbeat?.status,'stopped');
 const noLaunch=snapshot();projectTelemetry({...value,invocation:null},noLaunch,1001);assert.equal(noLaunch.current?.model,null);
});
test('unknown fields, private canaries, future dates, invalid events and mismatched state fail closed',()=>{
 const value=sidecar();const variants=[{...value,secret:'TOKEN_CANARY'},{...value,repo:'other/repo'},{...value,issue:2},{...value,stage:'publish'},{...value,status:'idle'},{...value,updatedAt:2000},{...value,events:[{...value.events[0],text:'PHI_TEXT'}]},{...value,events:[{...value.events[0],type:'PRIVATE_SESSION'}]},{...value,events:Array(101).fill(value.events[0])},{...value,invocation:{...value.invocation,model:'unknown'}},{...value,invocation:{...value.invocation,issue:2}},{...value,invocation:{...value.invocation,session:'PRIVATE_SESSION'}}];
 for(const variant of variants){const result=snapshot();projectTelemetry(variant,result,1001);assert.equal(result.heartbeat,null);assert.equal(result.logs.status,'unavailable');assert.equal(result.current?.model,null);for(const canary of ['PHI_TEXT','TOKEN_CANARY','PRIVATE_SESSION'])assert.ok(!JSON.stringify(result).includes(canary));}
});
test('observer reads fixed sidecar without modifying legacy bytes; unsafe files remain unavailable',async t=>{
 const root=await realpath(await mkdtemp('/private/tmp/telemetry-observer-'));t.after(()=>rm(root,{recursive:true,force:true}));const r={...repo,stateDirectory:root};const original=JSON.stringify(raw);await writeFile(root+'/state.json',original);
 assert.equal((await observeRepository(r,1001)).heartbeat,null);
 await writeFile(root+'/telemetry.json',JSON.stringify(sidecar()));assert.equal((await observeRepository(r,1001)).heartbeat?.status,'updating');assert.equal(await readFile(root+'/state.json','utf8'),original);
 await writeFile(root+'/telemetry.json','{');assert.equal((await observeRepository(r,1001)).logs.status,'unavailable');
 await rm(root+'/telemetry.json');await symlink(root+'/state.json',root+'/telemetry.json');assert.equal((await observeRepository(r,1001)).heartbeat,null);
});
test('logs API requires local session and never exposes raw state or an arbitrary path',async t=>{
 const {startServer}=await import('../src/server.ts');
 const root=await realpath(await mkdtemp('/private/tmp/telemetry-http-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(root+'/index.html','shell');await writeFile(root+'/state.json',JSON.stringify({...raw,secret:'TOKEN_CANARY',current:{...raw.current,session:'PRIVATE_SESSION',progress:'PHI_TEXT'}}));await writeFile(root+'/telemetry.json',JSON.stringify(sidecar()));
 const r={...repo,stateDirectory:root};const app=await startServer({snapshot:async()=>({schemaVersion:1,generatedAt:new Date(1001).toISOString(),mode:'observe-only',controller:{status:'observing',globalConcurrency:1,execution:'not-managed'},repositories:[await observeRepository(r,1001)],queue:{status:'unavailable',reason:'github_adapter_not_connected',items:[],repositories:[]}}),webDirectory:root});t.after(()=>app.close());
 assert.equal((await fetch(app.origin+'/api/logs')).status,401);
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json','X-Local-Bootstrap':'1'},body:JSON.stringify({nonce:new URL(app.launchUrl).hash.slice(1)})});
 const headers={Cookie:login.headers.get('set-cookie')!.split(';')[0]!};const response=await fetch(app.origin+'/api/logs',{headers});assert.equal(response.status,200);
 const bytes=await response.text();assert.equal(JSON.parse(bytes)[0].events[0].type,'codex.started');for(const canary of ['PHI_TEXT','PRIVATE_SESSION','TOKEN_CANARY'])assert.ok(!bytes.includes(canary));
 assert.equal((await fetch(app.origin+'/api/logs?path=/private',{headers})).status,400);
 assert.equal((await fetch(app.origin+'/api/logs',{headers:{...headers,Origin:'https://evil.example'}})).status,403);
});
