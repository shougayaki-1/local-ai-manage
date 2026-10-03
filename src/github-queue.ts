import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { record } from './registry.ts';
import type { Repository, QueueItem, RepositoryQueue, Registry, QueueSnapshot } from './types.ts';

export type GitHubRead = (repo: string, resource: string, signal?: AbortSignal) => Promise<unknown>;
const number = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number)>0;
const priorities = ['p0','p1','p2','p3'] as const;
export function githubEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Only trusted gh receives the existing GitHub/keyring capability. Never export tokens.
  const names=['PATH','LANG','LC_ALL','GH_TOKEN','GITHUB_TOKEN','DBUS_SESSION_BUS_ADDRESS','XDG_RUNTIME_DIR'];
  return {...Object.fromEntries(names.filter(key=>env[key]).map(key=>[key,env[key]])),HOME:env.HOME||homedir(),GH_CONFIG_DIR:env.GH_CONFIG_DIR||join(env.XDG_CONFIG_HOME||join(env.HOME||homedir(),'.config'),'gh'),GH_PROMPT_DISABLED:'1',GIT_TERMINAL_PROMPT:'0',GH_PAGER:'cat',GH_NO_UPDATE_NOTIFIER:'1',GH_NO_EXTENSION_UPDATE_NOTIFIER:'1'};
}
export function githubReadArgs(repo: string, resource: string): string[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo) || repo.split('/').some(v=>v==='.'||v==='..') || !/^(?:issues\?state=open&labels=codex%3Aready&per_page=100|pulls\?state=open&per_page=100|issues\/[1-9]\d*(?:\/timeline\?per_page=100)?)$/.test(resource)) throw new Error('invalid_github_read');
  return ['api','--hostname','github.com','--method','GET',`repos/${repo}/${resource}`];
}
export const ghRead: GitHubRead = (repo, resource, signal) => {
  const args=githubReadArgs(repo,resource);
  return new Promise((resolve,reject)=>{
    execFile('gh',args,{env:githubEnvironment(process.env),cwd:homedir(),timeout:10_000,killSignal:'SIGKILL',maxBuffer:8*1024*1024,signal,encoding:'utf8',shell:false},(error,stdout)=>{
      // execFile errors contain stdout/stderr. Never forward the original error.
      if (error) { reject(new Error('github_unavailable')); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('github_unavailable')); }
    });
  });
};

export function queueMetadata(body: unknown): {dependencies:number[];priority:QueueItem['priority'];source:QueueItem['prioritySource']} {
  if (body===null || body===undefined) body='';
  if (typeof body!=='string' || body.length>65536) throw new Error('invalid_metadata');
  const blocks=[...body.matchAll(/<!--\s*codex-queue\s*\n([\s\S]*?)-->/g)];
  if (!blocks.length) return {dependencies:[],priority:'unspecified',source:'default'};
  if (blocks.length!==1) throw new Error('invalid_metadata');
  const value=blocks[0]![1]!;
  const dep=value.match(/^depends_on:\s*(\[[^\n]*\])\s*$/m);
  if (/^depends_on:/m.test(value) && !dep) throw new Error('invalid_metadata');
  const parsed:unknown=dep?JSON.parse(dep[1]!):[];
  if (!Array.isArray(parsed)||parsed.length>32||parsed.some(v=>!number(v))) throw new Error('invalid_metadata');
  const priority=value.match(/^priority:\s*(p[0-3])\s*$/m)?.[1];
  if (/^priority:/m.test(value) && !priority) throw new Error('invalid_metadata');
  return {dependencies:[...new Set(parsed as number[])],priority:priority as QueueItem['priority']??'unspecified',source:priority?'metadata':'default'};
}
export function projectQueueIssue(value: unknown, repo: Repository): QueueItem|null {
  if(record(value)&&typeof value.body==='string'&&/<!--\s*codex-worker-status\s*-->/.test(value.body))return null;
  if (!record(value)||!number(value.number)||value.state!=='open'||value.pull_request) return null;
  const labels=Array.isArray(value.labels)?value.labels.map(v=>typeof v==='string'?v:record(v)?v.name:null):[];
  if (!labels.includes('codex:ready')) return null;
  const item:QueueItem={repositoryId:repo.id,repo:repo.repo,issue:value.number,priority:'unspecified',prioritySource:'default',dependencies:[],status:'waiting',reason:'association_unknown'};
  try {
    const info=queueMetadata(value.body);item.dependencies=info.dependencies;item.priority=info.priority;item.prioritySource=info.source;
    if(info.source==='default') {
      const ranks=labels.filter((v):v is string=>typeof v==='string'&&/^priority:p[0-3]$/.test(v)).map(v=>Number(v.at(-1)));
      if(ranks.length) {item.priority=priorities[Math.min(...ranks)]!;item.prioritySource='label';}
    }
  } catch {item.reason='invalid_metadata';return item;}
  const gates=[['codex:needs-human','needs-human','needs_human_label'],['codex:running','running','running_label'],['codex:blocked','blocked','blocked_label'],['codex:failed','excluded','failed_label']] as const;
  for (const [label,status,reason] of gates) if(labels.includes(label)) {item.status=status;item.reason=reason;break;}
  return item;
}
const rank=(item:QueueItem)=>item.priority==='unspecified'?4:Number(item.priority.at(-1));
export async function readRepositoryQueue(repo: Repository, read:GitHubRead=ghRead, now=Date.now(), signal?:AbortSignal):Promise<RepositoryQueue> {
  let budget=24;
  const get=async(resource:string)=>{if(--budget<0 || signal?.aborted)throw new Error('observation_limit');return read(repo.repo,resource,signal);};
  const raw=await get('issues?state=open&labels=codex%3Aready&per_page=100');
  if (!Array.isArray(raw)||raw.length>100||raw.some(value=>!record(value)||!number(value.number)||!['open','closed'].includes(String(value.state))||!Array.isArray(value.labels)||value.labels.some(label=>typeof label!=='string'&&(!record(label)||typeof label.name!=='string')))) throw new Error('github_unavailable');
  const items=raw.map(v=>projectQueueIssue(v,repo)).filter((v):v is QueueItem=>v!==null).sort((a,b)=>rank(a)-rank(b)||a.issue-b.issue);
  // Nothing private from the Issue API is retained in the returned snapshot.
  let partial=raw.length===100;
  if(!items.length) return {repositoryId:repo.id,repo:repo.repo,status:partial?'partial':'observed',reason:partial?'limited_observation':'observed',updatedAt:new Date(now).toISOString(),items};
  const linked=new Set<number>();let pullsComplete=false;
  try {
    const pulls=await get('pulls?state=open&per_page=100');
    if(!Array.isArray(pulls)||pulls.length>100)throw new Error('invalid_pulls');
    pullsComplete=pulls.length<100;
    for(const pull of pulls) {
      if(!record(pull)||!record(pull.head)||typeof pull.head.ref!=='string') {pullsComplete=false;continue;}
      const match=pull.head.ref.match(/^codex\/issue-(\d+)-/);if(match&&number(Number(match[1])))linked.add(Number(match[1]));
    }
  } catch {partial=true;}
  partial ||= !pullsComplete;
  const dependencies=new Map<number,'open'|'closed'|'unknown'>();
  for(const item of items) {
    if(item.reason!=='association_unknown')continue;
    if(linked.has(item.issue)) {item.status='excluded';item.reason='linked_pr';continue;}
    for(const n of item.dependencies) if(!dependencies.has(n)) {
      let state:'open'|'closed'|'unknown'='unknown';
      try {const value=await get(`issues/${n}`);if(record(value)&&value.number===n&&(value.state==='open'||value.state==='closed'))state=value.state;}catch {partial=true;}
      dependencies.set(n,state);
    }
    if(item.dependencies.some(n=>dependencies.get(n)==='open')) {item.reason='dependency_open';continue;}
    if(item.dependencies.some(n=>dependencies.get(n)!=='closed')) {item.reason='dependency_unknown';partial=true;continue;}
    try {
      const timeline=await get(`issues/${item.issue}/timeline?per_page=100`);
      if(!Array.isArray(timeline)||timeline.length>100)throw new Error('invalid_timeline');
      if(timeline.some(event=>record(event)&&record(event.source)&&record(event.source.issue)&&event.source.issue.pull_request&&event.source.issue.state==='open')) {item.status='excluded';item.reason='linked_pr';continue;}
      // An incomplete first page cannot prove absence of an associated PR.
      if(!pullsComplete||timeline.length===100||timeline.some(event=>!record(event))) {partial=true;continue;}
      item.status='ready';item.reason='eligible';
    } catch {partial=true;}
  }
  return {repositoryId:repo.id,repo:repo.repo,status:partial?'partial':'observed',reason:partial?'limited_observation':'observed',updatedAt:new Date(now).toISOString(),items};
}

// Single read lane across repositories. HTTP polling cannot multiply gh requests.
export class QueueObserver {
  private cache=new Map<string,RepositoryQueue>();
  private cursor=0;private nextRefresh=0;private pending:Promise<void>|null=null;
  private stop=new AbortController();
  private registry: Registry; private read: GitHubRead; private now: ()=>number;
  constructor(registry:Registry,read:GitHubRead=ghRead,now=Date.now) {this.registry=registry;this.read=read;this.now=now;}
  async refresh():Promise<void> {
    if(this.pending)return this.pending;
    if(this.stop.signal.aborted||this.now()<this.nextRefresh||!this.registry.repositories.length)return;
    this.nextRefresh=this.now()+30_000;
    const repo=this.registry.repositories[this.cursor++%this.registry.repositories.length]!;
    this.pending=(async()=>{
      const start=this.now();
      const signal=AbortSignal.any([this.stop.signal,AbortSignal.timeout(25_000)]);
      try {const value=await readRepositoryQueue(repo,this.read,start,signal);if(!this.stop.signal.aborted)this.cache.set(repo.id,value);}
      catch {if(!this.stop.signal.aborted) {const old=this.cache.get(repo.id);this.cache.set(repo.id,old?.updatedAt?{...old,status:'stale',reason:'github_unavailable'}:{repositoryId:repo.id,repo:repo.repo,status:'unavailable',reason:'github_unavailable',updatedAt:null,items:[]});}}
    })().finally(()=>{this.pending=null;});
    return this.pending;
  }
  snapshot():QueueSnapshot {
    const repositories=this.registry.repositories.map(repo=>{
      const value=this.cache.get(repo.id)??{repositoryId:repo.id,repo:repo.repo,status:'unavailable' as const,reason:'not_yet_observed' as const,updatedAt:null,items:[]};
      return value.updatedAt&&this.now()-Date.parse(value.updatedAt)>300_000?{...value,status:'stale' as const}:value;
    });
    const status=repositories.some(r=>r.status==='stale')?'stale':repositories.some(r=>r.status==='unavailable')?'unavailable':repositories.some(r=>r.status==='partial')?'partial':'observed';
    const reason=status==='observed'?'observed':status==='partial'?'limited_observation':repositories.some(r=>r.reason==='github_unavailable')?'github_unavailable':'not_yet_observed';
    return {status,reason,repositories,items:repositories.flatMap(r=>r.items)};
  }
  close() {this.stop.abort();}
}
