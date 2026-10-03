import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { reviewedProfiles, isWorkerProfile } from '../src/profiles.ts';
import { parseHandoff, registryFingerprint } from '../src/handoff.ts';
import { runTrustedWorker } from '../src/worker-adapter.ts';
import { Controller } from '../src/controller.ts';
import { Scheduler } from '../src/scheduler.ts';
import { collectSnapshot } from '../src/snapshot.ts';
import type { Registry } from '../src/types.ts';
async function fixture(t:test.TestContext){const root=await realpath(await mkdtemp('/private/tmp/profiles-'));t.after(()=>rm(root,{recursive:true,force:true}));for(const name of ['clone','state','bin'])await mkdir(join(root,name),{mode:0o700});const registry:Registry={version:1,globalConcurrency:1,repositories:[{id:'test--manager',repo:'test/manager',clonePath:join(root,'clone'),stateDirectory:join(root,'state'),enabled:true,ownership:'observe-only',defaultModel:'gpt-6.1-sol',defaultEffort:'medium',maximumConcurrency:1}]};return {root,registry};}
test('reviewed profile catalogue matches engine ids, is offline, and cannot inject commands',async()=>{
 const engine=await import(new URL('../engine/care-record/profiles.mjs',import.meta.url).href);assert.deepEqual(reviewedProfiles.map(v=>v.id),engine.profileIds);
 for(const value of ['arbitrary','../engine/evil.mjs',{},['care-record-v1']])assert.equal(isWorkerProfile(value),false);
 const cli=execFileSync(process.execPath,['--experimental-strip-types',new URL('../src/cli.ts',import.meta.url).pathname,'--profiles'],{encoding:'utf8'});assert.deepEqual(JSON.parse(cli),reviewedProfiles);
});
test('handoff and scheduler preserve selected profile across the single execution slot',async t=>{
 const f=await fixture(t);const document={version:1,registryFingerprint:registryFingerprint(f.registry),standaloneStopped:true,scope:'all-registered-workers',repositories:[{repositoryId:'test--manager',profile:'local-ai-manage-v1'}]};const handoffs=parseHandoff(document,f.registry);assert.equal(handoffs[0]?.profile,'local-ai-manage-v1');assert.throws(()=>parseHandoff({...document,repositories:[{repositoryId:'test--manager',profile:'arbitrary'}]},f.registry));
 await writeFile(join(f.root,'state/state.json'),JSON.stringify({version:1,repo:'test/manager',profile:'local-ai-manage-v1',status:'running',paused:false,current:{number:1,stage:'implement'},nextRetryAt:null,quotaWaitStarted:null,lastReason:'running'}),{mode:0o600});
 const controller=await Controller.create(f.registry,join(f.root,'controller'));await controller.apply({requestId:randomUUID(),expectedRevision:0,target:'global',action:'resume'});await controller.apply({requestId:randomUUID(),expectedRevision:1,target:'test--manager',action:'resume'});let calls=0;
 const scheduler=await Scheduler.create({registry:f.registry,controller,handoffs,snapshot:()=>collectSnapshot(f.registry),dispatch:async(id,issue,handoff)=>{assert.equal(id,'test--manager');assert.equal(handoff.profile,'local-ai-manage-v1');calls++;return {version:1,issue,status:'idle',paused:false,currentIssue:null,nextRetryAt:null};}});await scheduler.tick();await scheduler.settled();assert.equal(calls,1);await scheduler.close();await controller.close();
});
test('fixed bridge validates the manager profile and returns paused state without executing repository commands',async t=>{
 const f=await fixture(t);const engine=await import(new URL('../engine/care-record/profiles.mjs',import.meta.url).href);await writeFile(join(f.root,'clone/package.json'),JSON.stringify({name:'local-ai-manage',scripts:engine.managerScripts}));await writeFile(join(f.root,'bin/git'),'#!/bin/sh\necho https://github.com/test/manager.git\n',{mode:0o700});const state=JSON.stringify({version:1,repo:'test/manager',profile:'local-ai-manage-v1',status:'idle',paused:true,current:null,nextRetryAt:null,quotaWaitStarted:null});await writeFile(join(f.root,'state/state.json'),state);
 const previous=process.env.PATH;process.env.PATH=join(f.root,'bin')+':'+previous;
 try{const outcome=await runTrustedWorker(f.registry.repositories[0]!,1,'local-ai-manage-v1');assert.equal(outcome.paused,true);assert.equal(await readFile(join(f.root,'state/state.json'),'utf8'),state);await assert.rejects(runTrustedWorker(f.registry.repositories[0]!,1));}finally{process.env.PATH=previous;}
});
