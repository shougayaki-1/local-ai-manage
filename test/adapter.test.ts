import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchOnce, bridgeEnvironment, parseOutcome, runTrustedWorker, type DispatchOutcome } from '../src/worker-adapter.ts';
import type { Registry } from '../src/types.ts';
async function fixture(t:test.TestContext) {
 const root=await realpath(await mkdtemp(join(tmpdir(),'worker-adapter-')));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const name of ['clone','worker','ledger'])await mkdir(join(root,name),{mode:0o700});
 const registry:Registry={version:1,globalConcurrency:1,repositories:[{id:'test--repo',repo:'test/repo',clonePath:join(root,'clone'),stateDirectory:join(root,'worker'),enabled:true,ownership:'observe-only',defaultModel:'gpt-6.1-sol',defaultEffort:'medium',maximumConcurrency:1}]};
 return {root,registry,directory:join(root,'ledger'),repositoryId:'test--repo',expectedIssue:40,handoff:{repositoryId:'test--repo',profile:'care-record-v1' as const,standaloneStopped:true as const,scope:'all-registered-workers' as const}};
}
const result:DispatchOutcome={version:1,issue:40,status:'idle',paused:false,currentIssue:null,nextRetryAt:null};
test('trusted bridge capability allowlist and fixed sanitized terminal protocol',()=>{
 const env=bridgeEnvironment({PATH:'/bin',HOME:'/home',GH_TOKEN:'GH',CODEX_HOME:'/codex',OPENAI_API_KEY:'secret',SUPABASE_SERVICE_ROLE_KEY:'secret',NODE_OPTIONS:'injection',GH_DEBUG:'api'});
 assert.equal(env.GH_TOKEN,'GH');assert.equal(env.CODEX_HOME,'/codex');for(const key of ['OPENAI_API_KEY','SUPABASE_SERVICE_ROLE_KEY','NODE_OPTIONS','GH_DEBUG'])assert.equal(env[key],undefined);
 assert.deepEqual(parseOutcome(result,40),result);
 for(const value of [{...result,session:'secret'},{...result,issue:41},{...result,nextRetryAt:-1},{...result,currentIssue:0}])assert.throws(()=>parseOutcome(value,40));
});
test('reservation is durable before execution; terminal success settles and unlocks',async t=>{
 const f=await fixture(t);const outcome=await dispatchOnce({...f,run:async(repo,issue)=>{
  assert.equal(repo.id,f.repositoryId);assert.equal(issue,40);
  assert.equal(JSON.parse(await readFile(join(f.directory,'dispatch.json'),'utf8')).status,'reserved');
  await assert.rejects(dispatchOnce({...f,run:async()=>assert.fail('parallel execution')}));return result;
 }});assert.deepEqual(outcome,result);
 assert.equal(JSON.parse(await readFile(join(f.directory,'dispatch.json'),'utf8')).status,'settled');
 await assert.rejects(readFile(join(f.directory,'dispatch.lock')),{code:'ENOENT'});
});
test('unknown completion keeps reservation and lock; restart never steals them',async t=>{
 const f=await fixture(t);await assert.rejects(dispatchOnce({...f,run:async()=>{throw new Error('PRIVATE_ERROR');}}));
 const reservation=await readFile(join(f.directory,'dispatch.json'),'utf8');assert.equal(JSON.parse(reservation).status,'reserved');assert.ok(!reservation.includes('PRIVATE_ERROR'));
 await assert.rejects(dispatchOnce({...f,run:async()=>assert.fail('restarted')}));
});
test('handoff, default effort, existing worker locks and shared quota fail closed',async t=>{
 const f=await fixture(t);const run=async()=>assert.fail('executed');
 await assert.rejects(dispatchOnce({...f,registry:{...f.registry,repositories:f.registry.repositories.map(repo=>({...repo,enabled:false}))},run}),/not_authorized/);
 await assert.rejects(dispatchOnce({...f,handoff:{...f.handoff,standaloneStopped:false} as never,run}),/not_authorized/);
 await assert.rejects(dispatchOnce({...f,registry:{...f.registry,repositories:f.registry.repositories.map(repo=>({...repo,defaultEffort:'high'}))},run}),/not_authorized/);
 await writeFile(join(f.root,'worker/worker.lock'),'legacy');await assert.rejects(dispatchOnce({...f,run}),/standalone_worker_lock/);
 await rm(join(f.root,'worker/worker.lock'));
 await writeFile(join(f.root,'worker/state.json'),JSON.stringify({version:1,repo:'test/repo',status:'quota-wait',paused:false,nextRetryAt:1000}));
 await assert.rejects(dispatchOnce({...f,now:()=>0,run}),/shared_quota_wait/);
 await rm(join(f.root,'worker/state.json'));
 await dispatchOnce({...f,run:async()=>({...result,status:'quota-wait',currentIssue:40,nextRetryAt:1000})});
 await assert.rejects(dispatchOnce({...f,now:()=>0,run}),/shared_quota_wait/);
});
test('missing lock is insufficient when a durable orphan reservation exists',async t=>{
 const f=await fixture(t);await writeFile(join(f.directory,'dispatch.json'),JSON.stringify({version:1,status:'reserved',repositoryId:'test--repo',issue:40,reservationId:'unknown',outcome:null}));
 await assert.rejects(dispatchOnce({...f,run:async()=>assert.fail('executed')}),/reconciliation_required/);
});

test('real fixed bridge returns paused state through IPC without touching worker bytes',async t=>{
 const f=await fixture(t);const bin=join(f.root,'bin');await mkdir(bin);const fakeGit=join(bin,'git');
 await writeFile(fakeGit,`#!${process.execPath}\nimport {writeFileSync} from 'node:fs';import {execFileSync} from 'node:child_process';writeFileSync(${JSON.stringify(join(f.root,'bridge-group.json'))},JSON.stringify({parent:process.ppid,group:Number(execFileSync('ps',['-o','pgid=','-p',String(process.ppid)]).toString().trim())}));console.log('https://github.com/test/repo.git');\n`,{mode:0o700});
 const scripts={typecheck:'tsc --noEmit',lint:'eslint',test:'npm run test:unit && npm run test:ui','test:unit':'vitest run --project unit','test:ui':'vitest run --project storybook',build:'next build --webpack'};
 await writeFile(join(f.root,'clone/package.json'),JSON.stringify({name:'care-record-app',scripts}));
 const state=JSON.stringify({version:1,repo:'test/repo',status:'needs-human',paused:true,current:null,nextRetryAt:null,quotaWaitStarted:null,lastReason:'PRIVATE_REASON'});
 await writeFile(join(f.root,'worker/state.json'),state);const previousPath=process.env.PATH;process.env.PATH=bin+':'+previousPath;
 try {
  const outcome=await runTrustedWorker(f.registry.repositories[0]!,40);assert.equal(outcome.status,'needs-human');assert.equal(outcome.paused,true);
  const group=JSON.parse(await readFile(join(f.root,'bridge-group.json'),'utf8'));assert.equal(group.parent,group.group);assert.notEqual(group.group,process.pid);
  assert.ok(!JSON.stringify(outcome).includes('PRIVATE_REASON'));assert.equal(await readFile(join(f.root,'worker/state.json'),'utf8'),state);
  await assert.rejects(readFile(join(f.root,'worker/worker.lock')),{code:'ENOENT'});
 } finally {process.env.PATH=previousPath;}
});

test('parallel adapter reserves independent lanes, rejects duplicate/orphan work and preserves quota',async t=>{
 const f=await fixture(t);for(const name of ['clone-b','worker-b'])await mkdir(join(f.root,name),{mode:0o700});
 const second={...f.registry.repositories[0]!,id:'test--second',repo:'test/second',clonePath:join(f.root,'clone-b'),stateDirectory:join(f.root,'worker-b')};
 const registry={...f.registry,globalConcurrency:2,repositories:[...f.registry.repositories,second]};let finish!:(value:DispatchOutcome)=>void;let began!:()=>void;const started=new Promise<void>(resolve=>{began=resolve;});
 const a=dispatchOnce({...f,registry,run:async()=>{await writeFile(join(f.root,'worker/worker.lock'),'managed');began();return new Promise(resolve=>{finish=resolve;});}});
 await started;
 const bOptions={...f,registry,repositoryId:second.id,handoff:{...f.handoff,repositoryId:second.id},managedActiveRepositoryIds:[f.repositoryId]};
 await assert.rejects(dispatchOnce({...bOptions,managedActiveRepositoryIds:[],run:async()=>assert.fail('orphan admitted')}),/reconciliation_required/);
 await assert.rejects(dispatchOnce({...f,registry,managedActiveRepositoryIds:[f.repositoryId],run:async()=>assert.fail('duplicate admitted')}),/reconciliation_required/);
 await dispatchOnce({...bOptions,run:async()=>{assert.equal(JSON.parse(await readFile(join(f.directory,`dispatch.${f.repositoryId}.json`),'utf8')).status,'reserved');return {...result,status:'quota-wait',nextRetryAt:Date.now()+60000};}});
 await rm(join(f.root,'worker/worker.lock'));finish(result);await a;
 assert.equal(JSON.parse(await readFile(join(f.directory,`dispatch.${second.id}.json`),'utf8')).outcome.status,'quota-wait');
 await assert.rejects(dispatchOnce({...f,registry,run:async()=>assert.fail('quota ignored')}),/shared_quota_wait/);
 await assert.rejects(dispatchOnce({...f,registry:{...registry,globalConcurrency:1},run:async()=>assert.fail('quota ignored after reducing limit')}),/shared_quota_wait/);
});
