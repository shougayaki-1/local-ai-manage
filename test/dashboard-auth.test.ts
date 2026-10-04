import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dashboardAuth, dashboardSessionLifetime } from '../src/dashboard-auth.ts';
import { Controller } from '../src/controller.ts';
import { startServer } from '../src/server.ts';
import { demoSnapshot } from '../src/snapshot.ts';

async function fixture(t:test.TestContext){const root=await realpath(await mkdtemp('/private/tmp/lam-auth-'));await chmod(root,0o700);t.after(()=>rm(root,{recursive:true,force:true}));return root;}

test('browser authentication renews, survives restart, and expires after inactivity',async t=>{
 const root=await realpath(await mkdtemp('/private/tmp/lam-auth-http-'));await chmod(root,0o700);const web=join(root,'web');await mkdir(web);await writeFile(join(web,'index.html'),'shell');
 const controller=await Controller.create({version:1,globalConcurrency:1,repositories:[]},join(root,'controller'));
 let now=1000;
 const start=()=>startServer({snapshot:async()=>demoSnapshot(),webDirectory:web,controller,now:()=>now});
 let app=await start();t.after(async()=>{await app.close();await controller.close();await rm(root,{recursive:true,force:true});});
 const login=()=>fetch(app.origin+'/api/session',{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json','X-Local-Bootstrap':'1'},body:JSON.stringify({nonce:new URL(app.launchUrl).hash.slice(1)})});
 const first=await login();assert.equal(first.status,200);assert.match(first.headers.get('set-cookie')!,/Max-Age=2592000/);
 let cookie=first.headers.get('set-cookie')!.split(';')[0]!;const csrf=(await first.json() as {csrf:string}).csrf;
 now+=8*60*60*1000+1;
 assert.equal((await fetch(app.origin+'/api/status',{headers:{Cookie:cookie}})).status,200);
 now+=2*24*60*60*1000;
 const renewed=await fetch(app.origin+'/api/status',{headers:{Cookie:cookie}});assert.equal(renewed.status,200);
 const next=renewed.headers.get('set-cookie')!.split(';')[0]!;assert.notEqual(next,cookie);cookie=next;
 await app.close();app=await start();
 assert.equal((await fetch(app.origin+'/api/status',{headers:{Cookie:cookie}})).status,200);
 assert.equal((await (await fetch(app.origin+'/api/csrf',{headers:{Cookie:cookie}})).json() as {csrf:string}).csrf,csrf);
 assert.equal((await fetch(app.origin+'/api/status',{headers:{Cookie:'lam_session='+'a'.repeat(64)}})).status,401);
 const tampered=cookie.slice(0,-1)+(cookie.endsWith('a')?'b':'a');
 assert.equal((await fetch(app.origin+'/api/status',{headers:{Cookie:tampered}})).status,401);
 now+=dashboardSessionLifetime;
 assert.equal((await fetch(app.origin+'/api/status',{headers:{Cookie:cookie}})).status,401);
});

test('separate browser tokens do not extend each other and signatures protect timestamps',async()=>{
 const auth=await dashboardAuth();const first=auth.issue(1000);const second=auth.issue(2000);
 assert.notEqual(first,second);assert.equal(auth.verify(first,1000+dashboardSessionLifetime),null);
 assert.ok(auth.verify(second,1000+dashboardSessionLifetime));
 assert.equal(auth.verify(first.replace('.1000.','.2000.'),2000),null);
 assert.equal(auth.verify(second,1999),null);
 assert.equal(auth.verify('v1.1000.invalid.invalid',2000),null);
});

test('durable signing key rejects public files, directories and symlinks without replacing them',async t=>{
 const root=await fixture(t);const path=join(root,'dashboard-auth.key');await dashboardAuth(root);
 const key=await readFile(path);assert.equal((await stat(path)).mode&0o777,0o600);
 await chmod(path,0o644);await assert.rejects(dashboardAuth(root));assert.deepEqual(await readFile(path),key);
 const linked=join(root,'linked');await mkdir(linked,{mode:0o700});await symlink(path,join(linked,'dashboard-auth.key'));await assert.rejects(dashboardAuth(linked));
 const malformed=join(root,'malformed');await mkdir(malformed,{mode:0o700});await writeFile(join(malformed,'dashboard-auth.key'),'short',{mode:0o600});await assert.rejects(dashboardAuth(malformed));
 await chmod(root,0o755);await assert.rejects(dashboardAuth(root));
});
