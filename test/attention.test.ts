import test from 'node:test';
import assert from 'node:assert/strict';
import { HumanNotifier } from '../src/human-notifier.ts';
import { demoSnapshot, projectState } from '../src/snapshot.ts';
import type { Registry } from '../src/types.ts';
const {runAttentionWriter,attentionComment,parseAttention}=await import(new URL('../engine/attention-writer.mjs',import.meta.url).href);
const event={version:1,issue:39,reason:'needs_human',categories:['external_service','sandbox_capability'],check:'test:ui'};
const repo='example/care-record',login='reviewer';
test('attention uses fixed vocabulary, rejects arbitrary messages and binds duplicate identity',()=>{
 const {body,marker}=attentionComment(event,repo,login);assert.ok(body.includes('@reviewer'));assert.ok(body.includes('test:ui'));
 assert.equal(attentionComment({...event,categories:event.categories.slice().reverse()},repo,login).marker,marker);
 for(const bad of [{...event,body:'@someone secret'},{...event,check:'secret'},{...event,categories:['arbitrary']},{...event,issue:0}])assert.throws(()=>parseAttention(bad,repo,login));
 assert.throws(()=>parseAttention(event,repo,'reviewer\n@someone'));
});
test('bot mention is posted once; retries and restart detect the remote marker',async()=>{
 const comments:unknown[]=[];let posts=0;
 const request=async(path:string,body?:string)=>{if(body){posts++;const comment={id:1,body,user:{login:'github-actions[bot]'}};comments.push(comment);return comment;}if(path.includes('/comments?'))return comments;return {number:39,state:'open'};};
 assert.equal((await runAttentionWriter(event,repo,login,request)).status,'notified');
 assert.equal((await runAttentionWriter(event,repo,login,request)).status,'already-notified');assert.equal(posts,1);
});
test('notification errors retry safely and closed issues never receive a mention',async()=>{
 let posts=0;const {body}=attentionComment(event,repo,login);
 const request=async(path:string,payload?:string)=>{if(payload){posts++;throw new Error('response lost');}if(path.includes('/comments?'))return posts?[{body,user:{login:'github-actions[bot]'}}]:[];return {number:39,state:'open'};};
 await assert.rejects(runAttentionWriter(event,repo,login,request));assert.equal((await runAttentionWriter(event,repo,login,request)).status,'already-notified');assert.equal(posts,1);
 await assert.rejects(runAttentionWriter(event,repo,login,async()=>({number:39,state:'closed'})),/invalid_attention_issue/);
});
test('notifier includes current and parked jobs, throttles failure, and sanitizes private state',async()=>{
 const snapshot=demoSnapshot();const source=snapshot.repositories[0]!;
 source.humanWaiting=[{job:{...source.current!,issue:39},reason:'needs_human',since:new Date(0).toISOString()}];
 const configured={id:source.id,repo:source.repo,clonePath:'/unused',stateDirectory:'/unused',enabled:true,ownership:'observe-only' as const,defaultModel:'gpt-6.1-sol' as const,defaultEffort:'medium' as const,maximumConcurrency:1 as const};
 const registry:Registry={version:1,globalConcurrency:1,repositories:[configured]};const calls:unknown[]=[];
 const notifier=new HumanNotifier(registry,login,async(repo,event)=>{calls.push({repo,event});throw new Error('unavailable');});
 await notifier.tick(snapshot,0);assert.equal(calls.length,2);await notifier.tick(snapshot,100);assert.equal(calls.length,2);await notifier.tick(snapshot,300000);assert.equal(calls.length,4);
 const raw={version:1,repo:source.repo,status:'idle',paused:false,current:null,humanWaiting:[{current:{number:39,stage:'implement',session:'SECRET',worktree:'/private',base:'PRIVATE',result:{summary:'PRIVATE',reasons:[{category:'external_service',check:'build'}]}},reason:'needs_human',since:1000}]};
 const projected=projectState(raw,configured,1000,1000);for(const secret of ['SECRET','PRIVATE','/private'])assert.ok(!JSON.stringify(projected).includes(secret));assert.equal(projected.humanWaiting?.[0]?.job.issue,39);
});

test('retry exhaustion has a fixed investigation notification while operational retry requires no human approval',()=>{
 const exhausted={...event,reason:'verification_retry_exhausted',categories:['local_verification','verification_retry_limit']};
 assert.match(attentionComment(exhausted,repo,login).body,/検証の再試行上限/);
 const configured={id:'example--care-record',repo,clonePath:'/unused',stateDirectory:'/unused',enabled:true,ownership:'observe-only' as const,defaultModel:'gpt-6.1-sol' as const,defaultEffort:'medium' as const,maximumConcurrency:1 as const};
 const raw={version:1,repo,status:'needs-human',paused:true,current:{number:59,stage:'implement',base:'a'.repeat(40),result:{reasons:[{category:'local_verification',check:'test:ui'}]}}};
 assert.equal(projectState(raw,configured,0,0).current?.recovery,'automatic_retry_pending');
});

test('automatic code review waits do not notify humans; real local verification failure still does',async()=>{
 const snapshot=demoSnapshot();const source=snapshot.repositories[0]!;source.current={...source.current!,reasonCategories:['auth']};source.status='needs-human';source.reason='needs_human';
 const registry:Registry={version:1,globalConcurrency:1,repositories:[{id:source.id,repo:source.repo,clonePath:'/unused',stateDirectory:'/unused',enabled:true,ownership:'observe-only',defaultModel:'gpt-6.1-sol',defaultEffort:'medium',maximumConcurrency:1,reviewPolicy:'local-automatic'}]};const calls:unknown[]=[];const notifier=new HumanNotifier(registry,login,async(_repo,event)=>{calls.push(event);});
 await notifier.tick(snapshot,0);assert.equal(calls.length,0);source.reason='automatic_verification_failed';source.current.check='local_db_e2e';await notifier.tick(snapshot,1);assert.equal(calls.length,1);assert.equal((calls[0] as {reason:string}).reason,'verification_retry_exhausted');
});
