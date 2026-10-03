import type { RepoSnapshot, RepositoryQueue } from './types.ts';
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>0;
const timestamp=(v:unknown,now:number):string|null=>{if(typeof v!=='string')return null;const n=Date.parse(v);return Number.isFinite(n)&&n>=0&&n<=now?new Date(n).toISOString():null;};
/** #73-compatible body preview. No transport, comment discovery, or remote mutation. */
export function formatRemoteStatus(repo:RepoSnapshot,queue:RepositoryQueue|undefined,now=Date.now()):string {
 if(!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo.repo)||repo.repo.split('/').some(v=>v==='.'||v==='..'))throw new Error('invalid_status_repository');
 const heartbeat=timestamp(repo.heartbeat?.at,now);
 const lifecycle=repo.heartbeat?.status;
 const liveness=heartbeat&&['updating','stale','stopped'].includes(lifecycle??'')?(lifecycle==='stopped'?'stopped':now-Date.parse(heartbeat)>900_000?'heartbeat stale':'heartbeat observed'):'unknown';
 const state=['idle','running','quota-wait','needs-human','failed'].includes(repo.status)?repo.status:'unavailable';
 const categories=['sandbox_capability','local_verification','db','auth','permission','tenant','production','deploy','credential','external_service','destructive','security','retention','specification','manual_e2e','worktree_safety'];
 const reasons=[...new Set((repo.current?.reasonCategories??[]).filter(v=>categories.includes(v)))].slice(0,5);
 const current=positive(repo.current?.issue)?`#${repo.current.issue}`:'—';
 const stage=['prepare','implement','publish'].includes(repo.current?.stage??'')?repo.current!.stage:'unknown';
 const retry=timestamp(repo.quota.nextRetryAt,8.64e15);
 const queueAt=timestamp(queue?.updatedAt,now);
 const known=queue?.repositoryId===repo.id&&queue.repo===repo.repo&&queue.status==='observed'&&queueAt!==null&&now-Date.parse(queueAt)<=300_000;
 const items=known?queue.items.filter(v=>v.repositoryId===repo.id&&v.repo===repo.repo&&positive(v.issue)&&v.status==='ready'&&v.reason==='eligible'&&['p0','p1','p2','p3','unspecified'].includes(v.priority)):[];
 const unique=[...new Map(items.map(v=>[v.issue,v])).values()].sort((a,b)=>(a.priority==='unspecified'?4:Number(a.priority.at(-1)))-(b.priority==='unspecified'?4:Number(b.priority.at(-1)))||a.issue-b.issue);
 return ['<!-- codex-worker-status -->',...(heartbeat?[`<!-- codex-worker-heartbeat: ${heartbeat} -->`]:[]),'','## Codex Worker Status','',`- Worker: ${liveness}`,`- State: ${state}`,`- Paused: ${repo.paused===true?'yes':repo.paused===false?'no':'unknown'}`,`- Current Issue: ${current}`,`- Stage: ${stage}`,`- Reason categories: ${reasons.length?reasons.join(', '):'unknown'}`,`- Queue: ${known?`${unique.length} ready`:'unavailable'}`,`- Quota: ${state==='quota-wait'||retry&&Date.parse(retry)>now?'waiting':'unknown'}`,`- Next retry: ${retry??'unknown'}`,`- Last heartbeat: ${heartbeat??'unknown'}`,'','Queue head:',...(known?unique.slice(0,5).map(v=>`- #${v.issue} (${v.priority})`):['- unavailable']),'','_Local worker state remains authoritative. Heartbeat is an observation, not proof of process termination._',''].join('\n');
}
