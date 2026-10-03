import test from 'node:test';
import assert from 'node:assert/strict';
import { githubReadArgs, githubEnvironment, queueMetadata, projectQueueIssue, readRepositoryQueue, QueueObserver, type GitHubRead } from '../src/github-queue.ts';
import type { Repository, Registry } from '../src/types.ts';
const repo:Repository={id:'example--repo',repo:'example/repo',clonePath:'/unused',stateDirectory:'/unused-state',enabled:false,ownership:'observe-only',defaultModel:'gpt-6.1-sol',defaultEffort:'medium',maximumConcurrency:1};
const issue=(n:number,body='',labels=['codex:ready'])=>({number:n,state:'open',body,labels,title:'PHI_TITLE',secret:'TOKEN_CANARY'});
const baseRead=(issues:unknown[]):GitHubRead=>async(_repo,path)=>path.startsWith('issues?')?issues:[];
test('GitHub adapter restricts all operations to explicit GET and credential allowlist',()=>{
 assert.deepEqual(githubReadArgs(repo.repo,'issues/55'),['api','--hostname','github.com','--method','GET','repos/example/repo/issues/55']);
 for(const path of ['issues/55/comments','issues/55?token=secret','../user','graphql','issues/55/timeline?per_page=100&anything=true'])assert.throws(()=>githubReadArgs(repo.repo,path));
 for(const r of ['../repo','example/repo?x','https://github.com/example/repo','example/..'])assert.throws(()=>githubReadArgs(r,'issues/55'));
 const env=githubEnvironment({PATH:'/bin',HOME:'/login',GH_TOKEN:'github-only',CODEX_HOME:'/codex',OPENAI_API_KEY:'secret',SUPABASE_SERVICE_ROLE_KEY:'secret',GH_DEBUG:'api',NODE_OPTIONS:'--require dangerous'});
 assert.equal(env.HOME,'/login');assert.equal(env.GH_TOKEN,'github-only');
 for(const key of ['CODEX_HOME','OPENAI_API_KEY','SUPABASE_SERVICE_ROLE_KEY','GH_DEBUG','NODE_OPTIONS'])assert.equal(env[key],undefined);
});
test('metadata mirrors priority/dependency semantics and fails closed on invalid or excessive input',()=>{
 assert.deepEqual(queueMetadata('text'),{dependencies:[],priority:'unspecified',source:'default'});
 assert.deepEqual(queueMetadata('<!-- codex-queue\npriority: p1\ndepends_on: [55,55,60]\nmodel: ignored\neffort: high\n-->'),{dependencies:[55,60],priority:'p1',source:'metadata'});
 for(const body of ['<!-- codex-queue\ndepends_on: ["other/55"]\n-->','<!-- codex-queue\npriority: p9\n-->','<!-- codex-queue\ndepends_on: [-1]\n-->','<!-- codex-queue\n-->\n<!-- codex-queue\n-->','x'.repeat(65537)])assert.throws(()=>queueMetadata(body));
 assert.equal(projectQueueIssue(issue(55,'',['codex:ready','priority:p2','priority:p0']),repo)?.priority,'p0');
 assert.equal(projectQueueIssue(issue(55,'<!-- codex-queue\npriority: p3\n-->',['codex:ready','priority:p0']),repo)?.priority,'p3');
 assert.equal(projectQueueIssue({...issue(55),pull_request:{}},repo),null);
 assert.equal(projectQueueIssue({...issue(55),state:'closed'},repo),null);
});
test('queue projects no Issue text, orders repo priority/number, and never mutates GitHub',async()=>{
 const requests:string[]=[];
 const read:GitHubRead=async(_repo,path)=>{requests.push(path);return path.startsWith('issues?')?[issue(60,'PHI_BODY'),issue(55,'<!-- codex-queue\npriority: p1\n-->'),issue(57,'',['codex:ready','priority:p1'])]:[];};
 const result=await readRepositoryQueue(repo,read,1000);
 assert.equal(result.status,'observed');assert.deepEqual(result.items.map(i=>i.issue),[55,57,60]);assert.ok(result.items.every(i=>i.status==='ready'));
 for(const canary of ['PHI_TITLE','PHI_BODY','TOKEN_CANARY'])assert.ok(!JSON.stringify(result).includes(canary));
 assert.ok(requests.every(p=>githubReadArgs(repo.repo,p).includes('GET')));
});
test('dependency open/unknown and PR branch/timeline associations block Ready',async()=>{
 const issues=[issue(55,'<!-- codex-queue\ndepends_on: [1]\n-->'),issue(56,'<!-- codex-queue\ndepends_on: [2]\n-->'),issue(57),issue(58),issue(59,'',['codex:ready','codex:needs-human']),issue(60,'<!-- codex-queue\ndepends_on: [3]\n-->')];
 const read:GitHubRead=async(_repo,path)=>{
  if(path.startsWith('issues?'))return issues;
  if(path.startsWith('pulls?'))return [{head:{ref:'codex/issue-57-private-name'}}];
  if(path==='issues/1')return {number:1,state:'open'};
  if(path==='issues/2')throw new Error('RAW_SECRET_STDERR');
  if(path==='issues/3')return {number:3,state:'closed'};
  if(path.startsWith('issues/58/timeline'))return [{source:{issue:{state:'open',pull_request:{}}}}];
  return [];
 };
 const result=await readRepositoryQueue(repo,read,1000);
 assert.deepEqual(result.items.map(i=>i.reason),['dependency_open','dependency_unknown','linked_pr','linked_pr','needs_human_label','eligible']);
 assert.equal(result.items.at(-1)?.status,'ready');assert.ok(!JSON.stringify(result).includes('RAW_SECRET_STDERR'));
});
test('truncated pages, timeline failure, malformed metadata and budget exhaustion remain unverified',async()=>{
 const result=await readRepositoryQueue(repo,async(_repo,path)=>path.startsWith('issues?')?[issue(55),issue(56,'<!-- codex-queue\npriority: invalid\n-->')]:path.startsWith('pulls?')?Array.from({length:100},()=>({head:{ref:'other'}})):[],1000);
 assert.equal(result.status,'partial');assert.equal(result.items[0]?.reason,'association_unknown');assert.equal(result.items[1]?.reason,'invalid_metadata');
 const fail=await readRepositoryQueue(repo,async(_repo,path)=>{if(path.startsWith('issues?'))return [issue(55)];if(path.startsWith('pulls?'))return [];throw new Error('SECRET');});assert.equal(fail.items[0]?.status,'waiting');
 let calls=0;const many=await readRepositoryQueue(repo,async(_repo,path)=>{calls++;return baseRead(Array.from({length:60},(_,i)=>issue(i+1)))(_repo,path);});
 assert.equal(calls,24);assert.equal(many.status,'partial');assert.ok(many.items.some(i=>i.reason==='association_unknown'));
});
test('observer uses one bounded read lane, cached polling, round-robin and stale last-good data',async()=>{
 let now=1000;let calls=0;let failure=false;
 const second={...repo,id:'example--second',repo:'example/second'};const registry:Registry={version:1,globalConcurrency:1,repositories:[repo,second]};
 const read:GitHubRead=async()=>{calls++;await Promise.resolve();if(failure)throw new Error('PHI_ERROR');return [];};
 const observer=new QueueObserver(registry,read,()=>now);
 await Promise.all([observer.refresh(),observer.refresh(),observer.refresh()]);assert.equal(calls,1);
 await observer.refresh();assert.equal(calls,1);assert.equal(observer.snapshot().repositories[1]?.reason,'not_yet_observed');
 now+=30_000;await observer.refresh();assert.equal(calls,2);assert.equal(observer.snapshot().status,'observed');
 failure=true;now+=30_000;await observer.refresh();assert.equal(observer.snapshot().repositories[0]?.status,'stale');assert.ok(!JSON.stringify(observer.snapshot()).includes('PHI_ERROR'));
 now+=400_000;assert.equal(observer.snapshot().repositories[1]?.status,'stale');observer.close();await observer.refresh();assert.equal(calls,3);
});

test('invalid issue responses fail closed instead of claiming an empty queue',async()=>{
 for(const value of [[null],[{number:1,state:'open',labels:[{}]}],{error:'PRIVATE_ERROR'}]) await assert.rejects(readRepositoryQueue(repo,async()=>value));
});
test('close aborts in-flight observation and does not retain a late result',async()=>{
 let started=false;
 const read:GitHubRead=async(_repo,_path,signal)=>{started=true;return new Promise((_,reject)=>{signal?.addEventListener('abort',()=>reject(new Error('PRIVATE_ERROR')),{once:true});});};
 const observer=new QueueObserver({version:1,globalConcurrency:1,repositories:[repo]},read);
 const refresh=observer.refresh();assert.equal(started,true);observer.close();await refresh;
 assert.equal(observer.snapshot().repositories[0]?.reason,'not_yet_observed');
});
