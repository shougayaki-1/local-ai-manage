import test from 'node:test';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseRegistry, loadRegistry } from '../src/registry.ts';
import { projectState, collectSnapshot, readPrivateJson } from '../src/snapshot.ts';
import { privateIPv4, tailscaleIPv4, startServer } from '../src/server.ts';
import type { Repository } from '../src/types.ts';
const repo:Repository={id:'example--care-record',repo:'example/care-record',clonePath:'/unused/clone',stateDirectory:'/unused/state',enabled:false,ownership:'observe-only',defaultModel:'gpt-6.1-sol',defaultEffort:'medium',maximumConcurrency:1};
const registry=(r=repo)=>({version:1,globalConcurrency:1,repositories:[r]});
const state=()=>({version:1,repo:repo.repo,status:'needs-human',paused:true,current:{number:55,stage:'implement',failures:1,quotaWaits:0,session:'PRIVATE_SESSION',worktree:'/PRIVATE_PATH',branch:'PHI_BRANCH',progress:'PHI_TEXT',result:{summary:'PHI_TEXT',remaining_work:'PHI_TEXT',reasons:[{category:'local_verification',check:'test:ui'},{category:'PRIVATE_REASON'}]},repair:{category:'local_verification',check:'test:ui'},pr:'https://github.com/example/care-record/pull/65'},lastReason:'verification_retry_exhausted',quotaWaitStarted:null,nextRetryAt:null,secret:'TOKEN_CANARY'});
async function fixture(t:test.TestContext) { const root=await realpath(await mkdtemp(join(tmpdir(),'local-ai-manage-test-')));t.after(()=>rm(root,{recursive:true,force:true}));return root; }
test('registry rejects secrets, duplicate identities, arbitrary execution and parallelism',()=>{
 assert.equal(parseRegistry(registry()).repositories.length,1);
 for (const value of [{...registry(),secret:'key'},{...registry(),globalConcurrency:2},{...registry(),repositories:[repo,repo]},{...registry(),repositories:[{...repo,shell:'id'}]},{...registry(),repositories:[{...repo,ownership:'managed'}]},{...registry(),repositories:[{...repo,stateDirectory:'../escape'}]},{...registry(),repositories:[{...repo,maximumConcurrency:2}]}]) assert.throws(()=>parseRegistry(value));
});
test('projection excludes all private/free-text fields and validates PR boundary',()=>{
 const raw=state(); const publicState=projectState(raw,repo,1000,1100);
 assert.equal(publicState.current?.issue,55);assert.equal(publicState.current?.model,null);assert.equal(publicState.heartbeat,null);assert.equal(publicState.current?.prUrl,raw.current.pr);
 const serialized=JSON.stringify(publicState);
 for (const canary of ['PRIVATE_SESSION','PRIVATE_PATH','PHI_BRANCH','PHI_TEXT','PRIVATE_REASON','TOKEN_CANARY']) assert.ok(!serialized.includes(canary),canary);
 for (const url of ['https://github.com.evil/example/care-record/pull/1','https://github.com/example/project-b/pull/1','https://github.com/example/care-record/pull/1?token=secret','javascript:alert(1)']) assert.equal(projectState({...raw,current:{...raw.current,pr:url}},repo,1000,1100).current?.prUrl,null);
 assert.equal(projectState({...raw,lastReason:'PHI_TEXT'},repo,1000,1100).reason,'unknown');
 assert.throws(()=>projectState({...raw,repo:'evil/other'},repo,1000,1100));
 assert.throws(()=>projectState({...raw,version:2},repo,1000,1100));
 assert.equal(projectState(raw,repo,1000,400_000).freshness,'stale');
});
test('observer preserves state bytes; malformed state, symlink and oversized reads fail closed',async t=>{
 const root=await fixture(t); const file=join(root,'state.json'); const bytes=JSON.stringify(state()); await writeFile(file,bytes);
 const r={...repo,stateDirectory:root};
 const snapshot=await collectSnapshot(parseRegistry(registry(r)));assert.equal(snapshot.repositories[0]?.current?.issue,55);assert.equal(await readFile(file,'utf8'),bytes);
 await writeFile(join(root,'issue-55.json'),JSON.stringify(state().current));
 assert.equal((await collectSnapshot(parseRegistry(registry(r)))).repositories[0]?.runs.length,1);
 await writeFile(file,'{corrupt');assert.equal((await collectSnapshot(parseRegistry(registry(r)))).repositories[0]?.status,'unavailable');
 await writeFile(join(root,'large'),Buffer.alloc(1_048_577));await assert.rejects(readPrivateJson(join(root,'large')));
 await symlink(join(root,'large'),join(root,'link'));await assert.rejects(readPrivateJson(join(root,'link')));
});
test('registry validates clone origin and rejects nested state roots',async t=>{
 const root=await fixture(t); const clone=join(root,'clone'); const stateRoot=join(root,'state'); await mkdir(clone);await mkdir(stateRoot);
 const git=(args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:clone,stdio:'pipe'});
 git(['init']);git(['remote','add','origin','https://github.com/example/care-record.git']);
 const path=join(root,'registry.json');const r={...repo,clonePath:clone,stateDirectory:stateRoot};await writeFile(path,JSON.stringify(registry(r)));assert.equal((await loadRegistry(path)).repositories.length,1);
 await writeFile(path,JSON.stringify(registry({...r,repo:'example/other',id:'example--other'})));await assert.rejects(loadRegistry(path));
 await mkdir(join(clone,'state'));await writeFile(path,JSON.stringify(registry({...r,stateDirectory:join(clone,'state')})));await assert.rejects(loadRegistry(path));
});
test('HTTP loopback auth, one-use bootstrap, origin/host gates and read-only methods',async t=>{
 const root=await fixture(t);await writeFile(join(root,'index.html'),'<div>static shell</div>');
 const r={...repo,stateDirectory:join(root,'private')};await mkdir(r.stateDirectory);const stateFile=join(r.stateDirectory,'state.json');const original=JSON.stringify(state());await writeFile(stateFile,original);
 const app=await startServer({snapshot:()=>collectSnapshot(parseRegistry(registry(r))),webDirectory:root});t.after(()=>app.close());
 const address=app.server.address(); assert.equal(address && typeof address==='object' ? address.address : null,'127.0.0.1');
 assert.equal((await fetch(`${app.origin}/api/status`)).status,401);
 assert.equal(await new Promise<number>(resolve=>{ const req=request(app.origin,{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode!);});req.end();}),403);
 assert.equal((await fetch(app.origin,{headers:{Origin:'null'}})).status,403);
 assert.equal((await fetch(app.origin,{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
 const headers={'Content-Type':'application/json','X-Local-Bootstrap':'1',Origin:app.origin};
 const nonce=new URL(app.launchUrl).hash.slice(1);
 assert.equal((await fetch(`${app.origin}/api/session`,{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:JSON.stringify({nonce})})).status,403);
 const login=await fetch(`${app.origin}/api/session`,{method:'POST',headers,body:JSON.stringify({nonce})});assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie')!.split(';')[0]!;assert.ok(login.headers.get('set-cookie')!.includes('HttpOnly; SameSite=Strict'));
 assert.equal((await fetch(`${app.origin}/api/session`,{method:'POST',headers,body:JSON.stringify({nonce})})).status,403);
 const response=await fetch(`${app.origin}/api/status`,{headers:{Cookie:cookie}});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.ok(response.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
 const text=await response.text();for(const canary of ['PRIVATE_SESSION','PRIVATE_PATH','PHI_TEXT','TOKEN_CANARY'])assert.ok(!text.includes(canary));
 for (const path of ['/shell','/exec','/api/repositories/example--care-record/resume']) assert.equal((await fetch(app.origin+path,{method:'POST',headers:{Cookie:cookie,...headers},body:'{}'})).status,405);
 assert.equal((await fetch(`${app.origin}/api/status?path=/private`,{headers:{Cookie:cookie}})).status,400);
 assert.equal((await fetch(`${app.origin}/api/repositories/example--care-record/status`,{headers:{Cookie:cookie}})).status,200);
 assert.equal((await fetch(`${app.origin}/api/repositories/unknown--repo/status`,{headers:{Cookie:cookie}})).status,404);
 assert.equal((await fetch(`${app.origin}/api/status`,{headers:{Cookie:cookie,Origin:'https://evil.example'}})).status,403);
 for (let i=0;i<121;i++) await fetch(`${app.origin}/api/status`,{headers:{Cookie:cookie}});
 assert.equal((await fetch(`${app.origin}/api/status`,{headers:{Cookie:cookie}})).status,429);
 assert.equal(await readFile(stateFile,'utf8'),original);
});
test('expired nonce fails and concurrent redemption allows only one session',async t=>{
 const root=await fixture(t);await writeFile(join(root,'index.html'),'shell');let now=0;
 const app=await startServer({snapshot:()=>collectSnapshot(parseRegistry({version:1,globalConcurrency:1,repositories:[]})),webDirectory:root,now:()=>now});t.after(()=>app.close());
 const login=()=>fetch(`${app.origin}/api/session`,{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json','X-Local-Bootstrap':'1'},body:JSON.stringify({nonce:new URL(app.launchUrl).hash.slice(1)})});
 now=120_001;assert.equal((await login()).status,403);now=0;
 assert.deepEqual((await Promise.all([login(),login()])).map(r=>r.status).sort(),[200,403]);
});

test('LAN is opt-in, private-interface-only, authenticated and origin restricted',async t=>{
 const root=await fixture(t);await writeFile(join(root,'index.html'),'shell');
 for(const address of ['0.0.0.0','8.8.8.8','localhost','192.168.999.1','::1']) {
  assert.equal(privateIPv4(address),false);
  await assert.rejects(startServer({snapshot:async()=>({}) as never,webDirectory:root,lanAddress:address}));
 }
 const address=Object.values(networkInterfaces()).flat().find(e=>e?.family==='IPv4'&&!e.internal&&privateIPv4(e.address))?.address;
 if(!address){t.skip('No private LAN interface');return;}
 const app=await startServer({snapshot:()=>collectSnapshot(parseRegistry({version:1,globalConcurrency:1,repositories:[]})),webDirectory:root,lanAddress:address});t.after(()=>app.close());
 assert.ok(app.mobileOrigin);
 assert.equal((await fetch(app.origin)).status,200);
 assert.equal((await fetch(app.mobileOrigin!+'/api/status')).status,401);
 const link=app.issueLaunchUrl(true);assert.equal(new URL(link).origin,app.mobileOrigin);
 const headers={Origin:app.mobileOrigin!,'Content-Type':'application/json','X-Local-Bootstrap':'1'};
 const nonce=new URL(link).hash.slice(1);
 assert.equal((await fetch(app.mobileOrigin!+'/api/session',{method:'POST',headers:{...headers,Origin:app.origin},body:JSON.stringify({nonce})})).status,403);
 const login=await fetch(app.mobileOrigin!+'/api/session',{method:'POST',headers,body:JSON.stringify({nonce})});assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie')!.split(';')[0]!;
 assert.equal((await fetch(app.mobileOrigin!+'/api/status',{headers:{Cookie:cookie}})).status,200);
 assert.equal((await fetch(app.mobileOrigin!+'/api/mobile-link',{headers:{Cookie:cookie}})).status,403);
 const mobile=await fetch(app.origin+'/api/mobile-link',{headers:{Cookie:cookie}});assert.equal(mobile.status,200);assert.equal(new URL((await mobile.json() as {url:string}).url).origin,app.mobileOrigin);
 assert.equal((await fetch(app.mobileOrigin!+'/api/status',{headers:{Cookie:cookie,Origin:'https://evil.example'}})).status,403);
 assert.equal(await new Promise<number>(resolve=>{const req=request(app.mobileOrigin!,{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode!);});req.end();}),403);
 assert.equal((await fetch(app.mobileOrigin!+'/api/session',{method:'POST',headers,body:JSON.stringify({nonce})})).status,403);
});

test('Tailscale listener rejects LAN, wildcard and public addresses before binding',async t=>{
 const root=await fixture(t);await writeFile(join(root,'index.html'),'shell');
 for(const address of ['100.64.0.1','100.127.255.254'])assert.equal(tailscaleIPv4(address),true);
 for(const address of ['100.63.255.255','100.128.0.0','192.168.1.11','0.0.0.0','8.8.8.8','::1','100.64.999.1']){
  assert.equal(tailscaleIPv4(address),false);
  await assert.rejects(startServer({snapshot:async()=>({}) as never,webDirectory:root,tailscaleAddress:address}));
 }
 await assert.rejects(startServer({snapshot:async()=>({}) as never,webDirectory:root,tailscaleAddress:'100.64.0.1',lanAddress:'192.168.1.1'}));
});

test('automatic Tailscale setup keeps local dashboard available before VPN login',async t=>{
 const root=await fixture(t);await writeFile(join(root,'index.html'),'shell');
 const app=await startServer({snapshot:()=>collectSnapshot(parseRegistry({version:1,globalConcurrency:1,repositories:[]})),webDirectory:root,tailscaleAddress:'auto'});t.after(()=>app.close());
 assert.equal((await fetch(app.origin)).status,200);
 if(!app.mobileOrigin)assert.throws(()=>app.issueLaunchUrl(true),/mobile_not_enabled/);
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json','X-Local-Bootstrap':'1'},body:JSON.stringify({nonce:new URL(app.launchUrl).hash.slice(1)})});
 assert.equal(login.status,200);
});
