import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { dispatchStatusActions, ActionsStatusPublisher, type StatusEnvelope } from '../src/status-actions.ts';
import { demoSnapshot } from '../src/snapshot.ts';
import { formatRemoteStatus } from '../src/remote-status.ts';
const {parseEnvelope,runStatusWriter}=await import(new URL('../engine/status-writer.mjs',import.meta.url).href);
const now=Date.parse('2026-10-04T01:00:00.000Z');
const target={repositoryId:'example--care-record',repo:'example/care-record',issue:73,comment:123};
function envelope(at=now,heartbeat=at):StatusEnvelope {const repo=demoSnapshot().repositories[0]!;repo.heartbeat={at:new Date(heartbeat).toISOString(),status:'updating'};return {version:1,repositoryId:target.repositoryId,issue:target.issue,comment:target.comment,observedAt:new Date(at).toISOString(),body:formatRemoteStatus(repo,undefined,at)};}
function remote(body:string){return {id:123,issue_url:'https://api.github.com/repos/example/care-record/issues/73',body};}
function transport(initial:string){let body=initial;const calls:{endpoint:string;body?:string}[]=[];return {calls,get body(){return body;},request:async(endpoint:string,next?:string)=>{calls.push({endpoint,body:next});if(endpoint.endsWith('/issues/73'))return {number:73,state:'open',body:'<!-- codex-worker-status -->',labels:[]};if(next!==undefined)body=next;return remote(body);}};}
test('Actions payload accepts only canonical sanitized status, fixed identity and bounded timestamps',()=>{
 const valid=envelope();assert.equal(parseEnvelope(valid,target,now),valid);
 for(const value of [{...valid,secret:'x'},{...valid,issue:74},{...valid,comment:124},{...valid,repositoryId:'other--repo'},{...valid,observedAt:new Date(now+1).toISOString()},{...valid,body:valid.body.replace('needs-human','raw-secret')},{...valid,body:valid.body+'secret'},{...valid,body:valid.body.replace(/^- Reason categories: .*$/m,'- Reason categories: credential value')},{...valid,body:'x'.repeat(20000)}])assert.throws(()=>parseEnvelope(value,target,now));
 const queued=valid.body.replace('- Queue: unavailable','- Queue: 1 ready').replace('Queue head:\n- unavailable','Queue head:\n- #99 (p1)');assert.doesNotThrow(()=>parseEnvelope({...valid,body:queued},target,now));
});
test('sole writer publishes observations, updates same comment to stale, and rejects delayed older jobs',async()=>{
 const mock=transport('<!-- codex-worker-status -->\n');assert.equal((await runStatusWriter(target,mock.request,envelope(),now)).status,'published');assert.match(mock.body,/codex-worker-observation/);assert.match(mock.body,/- Worker: heartbeat observed/);
 assert.equal((await runStatusWriter(target,mock.request,undefined,now+900001)).status,'stale-updated');assert.match(mock.body,/- Worker: heartbeat stale/);
 const fresh=envelope(now+1000000);assert.equal((await runStatusWriter(target,mock.request,fresh,now+1000000)).status,'published');const saved=mock.body;
 assert.equal((await runStatusWriter(target,mock.request,envelope(),now+1000000)).status,'superseded');assert.equal(mock.body,saved);assert.equal((await runStatusWriter(target,mock.request,undefined,now+1000000)).status,'unchanged');assert.ok(mock.calls.every(c=>c.endpoint.endsWith('/issues/73')||c.endpoint.endsWith('/issues/comments/123')));
});
test('delayed observation is immediately stale; stopped and unknown do not become observed; manual edits prevent PATCH',async()=>{
 const mock=transport('<!-- codex-worker-status -->\n');await runStatusWriter(target,mock.request,envelope(),now+900001);assert.match(mock.body,/- Worker: heartbeat stale/);
 const stopped={...envelope(now+1000000),body:envelope(now+1000000).body.replace('heartbeat observed','stopped')};await runStatusWriter(target,mock.request,stopped,now+1000000);const before=mock.body;await runStatusWriter(target,mock.request,undefined,now+2000000);assert.equal(mock.body,before);
 let reads=0,writes=0;await assert.rejects(()=>runStatusWriter(target,async(endpoint:string,body?:string)=>{if(body!==undefined){writes++;return remote(body);}if(endpoint.endsWith('/issues/73'))return {number:73,state:'open',body:'<!-- codex-worker-status -->',labels:[]};return remote('<!-- codex-worker-status -->\n'+(++reads===2?'admin edit':''));},envelope(),now));assert.equal(writes,0);
});
test('Actions publisher queues at bounded cadence without claiming comment publication or mutating snapshot',async()=>{
 const snapshot=demoSnapshot();snapshot.repositories[0]!.heartbeat={at:new Date(now).toISOString(),status:'updating'};const original=JSON.stringify(snapshot);const dispatched:StatusEnvelope[]=[];const publisher=new ActionsStatusPublisher({version:1,registryFingerprint:'a'.repeat(64),targets:[target]},async(_target,payload)=>{dispatched.push(payload);});
 assert.deepEqual(await publisher.tick(snapshot,now),[{repositoryId:target.repositoryId,status:'queued'}]);assert.deepEqual(await publisher.tick(snapshot,now+1000),[]);assert.equal(dispatched.length,1);assert.deepEqual(await publisher.tick(snapshot,now+300000),[{repositoryId:target.repositoryId,status:'queued'}]);assert.equal(JSON.stringify(snapshot),original);assert.deepEqual(await publisher.tick(snapshot,now+600000,()=>true),[]);
});
test('inactive workflow serializes dispatch and schedule, restricts branch and passes input through env',async()=>{
 const workflow=await readFile(new URL('../docs/templates/codex-worker-status.yml.example',import.meta.url),'utf8');assert.match(workflow,/workflow_dispatch:/);assert.match(workflow,/schedule:/);assert.match(workflow,/cancel-in-progress: false/);assert.match(workflow,/github.ref == format/);assert.match(workflow,/STATUS_PAYLOAD: \$\{\{ inputs.payload \}\}/);assert.doesNotMatch(workflow,/run:.*inputs.payload/);assert.match(workflow,/issues: write/);assert.match(workflow,/STATUS_SOURCE_REF: \$\{\{ github.sha \}\}/);assert.match(workflow,/contents\/engine\/status-monitor\.mjs\?ref=/);assert.match(workflow,/contents\/engine\/status-writer\.mjs\?ref=/);assert.doesNotMatch(workflow,/actions\/checkout/);
});

test('real fixed dispatch uses default branch, JSON stdin and GitHub-only environment',async t=>{
 const directory=await mkdtemp('/private/tmp/actions-transport-');t.after(()=>rm(directory,{recursive:true,force:true}));await mkdir(directory+'/bin');
 const fake=`#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);let input='';process.stdin.on('data',v=>input+=v);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(directory+'/calls')},JSON.stringify({args,input,leaked:!!process.env.OPENAI_API_KEY})+'\\n');if(args.includes('GET'))process.stdout.write(JSON.stringify({full_name:'example/care-record',default_branch:'main'}));});`;
 await writeFile(directory+'/bin/gh',fake,{mode:0o700});const oldPath=process.env.PATH,oldApi=process.env.OPENAI_API_KEY;process.env.PATH=directory+'/bin:'+oldPath;process.env.OPENAI_API_KEY='SECRET_CANARY';try{await dispatchStatusActions(target,envelope(Date.now()));}finally{process.env.PATH=oldPath;if(oldApi===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldApi;}
 const calls=(await readFile(directory+'/calls','utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(calls.length,2);assert.deepEqual(calls[0].args,['api','--hostname','github.com','--method','GET','repos/example/care-record']);assert.deepEqual(calls[1].args,['api','--hostname','github.com','--method','POST','repos/example/care-record/actions/workflows/codex-worker-status.yml/dispatches','--input','-']);const payload=JSON.parse(calls[1].input);assert.equal(payload.ref,'main');assert.equal(JSON.parse(payload.inputs.payload).repositoryId,target.repositoryId);assert.ok(calls.every(v=>v.leaked===false));
});
