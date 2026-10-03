import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTelemetry } from './telemetry.mjs';
import { codexArgs, runCodex } from './lib/codex-runner.mjs';
async function fixture(t){const root=await mkdtemp('/private/tmp/worker-telemetry-');t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('telemetry starts only when updated, heartbeats, stops, bounds events and excludes private state',async t=>{
 const root=await fixture(t);let now=1000;const producer=createTelemetry(root,'test/repo',{now:()=>now,intervalMs:5});
 await producer.close();await assert.rejects(readFile(join(root,'telemetry.json')));
 const telemetry=createTelemetry(root,'test/repo',{now:()=>now,intervalMs:5});
 const raw={status:'running',current:{number:1,stage:'implement',session:'PRIVATE_SESSION',result:'PHI_TEXT'},secret:'SECRET'};
 await telemetry.update(raw);assert.equal(JSON.parse(await readFile(join(root,'telemetry.json'))).invocation,null);
 await telemetry.launched();for(let n=0;n<110;n++){now++;await telemetry.update({...raw,status:n%2?'idle':'running'});}
 now=5000;await new Promise(resolve=>setTimeout(resolve,30));
 const heartbeat=JSON.parse(await readFile(join(root,'telemetry.json')));assert.equal(heartbeat.updatedAt,now);assert.equal(heartbeat.lifecycle,'active');assert.equal(heartbeat.events.length,100);
 assert.equal(heartbeat.invocation.model,'gpt-6.1-sol');assert.ok(codexArgs({},'/schema').includes(`model="${heartbeat.invocation.model}"`));assert.ok(codexArgs({},'/schema').includes(`model_reasoning_effort="${heartbeat.invocation.effort}"`));
 await telemetry.update({...raw,current:{number:2,stage:'prepare'}});await telemetry.close();
 const bytes=await readFile(join(root,'telemetry.json'),'utf8');const stopped=JSON.parse(bytes);assert.equal(stopped.lifecycle,'stopped');assert.equal(stopped.invocation,null);assert.equal(stopped.events.at(-1).type,'worker.stopped');
 for(const canary of ['PRIVATE_SESSION','PHI_TEXT','SECRET'])assert.ok(!bytes.includes(canary));assert.equal((await stat(join(root,'telemetry.json'))).mode&0o777,0o600);
});
test('diagnostic storage failure does not change job semantics',async t=>{
 const root=await fixture(t);const telemetry=createTelemetry(join(root,'absent'),'test/repo');await telemetry.update({status:'idle',current:null});await telemetry.launched();await telemetry.close();
});
test('CLI launch notification requires OS spawn success',async t=>{
 const root=await fixture(t);const binary=join(root,'fake-codex');await writeFile(binary,'#!/bin/sh\ncat >/dev/null\nexit 0\n',{mode:0o700});
 let launches=0;const options={current:{number:1,worktree:root},issue:{number:1,title:'Synthetic',body:''},schemaPath:'/schema',tracePath:join(root,'trace'),stderrPath:join(root,'stderr'),onSession:async()=>{},onLaunch:async()=>{launches++;}};
 await runCodex({...options,binary});assert.equal(launches,1);
 await runCodex({...options,binary:join(root,'missing')});assert.equal(launches,1);
});
