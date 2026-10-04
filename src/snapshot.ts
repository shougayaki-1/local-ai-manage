import { open, realpath, opendir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { projectSupervisorHeartbeat } from './supervisor-heartbeat.ts';
import { projectTelemetry } from './telemetry.ts';
import { record } from './registry.ts';
import type { Job, Repository, RepoSnapshot, Registry, Snapshot } from './types.ts';
const statuses=['idle','running','quota-wait','needs-human','failed'];
const stages=['prepare','implement','publish'];
const categories=['sandbox_capability','local_verification','db','auth','permission','tenant','production','deploy','credential','external_service','destructive','security','retention','specification','manual_e2e','worktree_safety'];
const reasons=['running','completed','stopped','paused','needs_human','quota_wait','manual_e2e_required','parent_verification_retry','verification_retry_exhausted','unsafe_or_unavailable_verification','parent_verification_safety_failed','publication_failed','operational_error','stale_existing_worktree','worktree_base_mismatch','branch_deployment_not_disabled','worktree_branch_mismatch','missing_saved_worktree','repair_session_resume_unavailable','repair_session_mismatch'];
const checks=['typecheck','lint','test','test:unit','test:ui','build','test:codex-worker','test:ci-scope','diff-check'];
const count=(v: unknown): number|null => Number.isSafeInteger(v) && (v as number)>=0 ? v as number : null;
const issue=(v: unknown): v is number => Number.isSafeInteger(v) && (v as number)>0;
const date=(v: unknown): string|null => typeof v==='number' && Number.isFinite(v) && v>=0 && v<=8.64e15 ? new Date(v).toISOString() : null;
export function prUrl(value: unknown, repo: string): string|null {
  if (typeof value!=='string') return null;
  const prefix=`https://github.com/${repo}/pull/`;
  return value.startsWith(prefix) && /^[1-9]\d*$/.test(value.slice(prefix.length)) ? value : null;
}
export function projectJob(value: unknown, repo: string): Job|null {
  if (!record(value) || !issue(value.number)) return null;
  const result=record(value.result) ? value.result : {};
  const repair=record(value.repair) ? value.repair : {};
  const preflight=record(value.preflight) ? value.preflight : {};
  const supplied=Array.isArray(result.reasons) ? result.reasons : [];
  const all=[...supplied,repair,preflight].filter(record).map(v=>v.category).filter((v): v is string => typeof v==='string' && categories.includes(v));
  return {issue:value.number,stage:stages.includes(String(value.stage)) ? value.stage as Job['stage'] : 'unknown',failures:count(value.failures),quotaWaits:count(value.quotaWaits),model:null,effort:null,reasonCategories:[...new Set(all)],check:checks.includes(String(repair.check)) ? String(repair.check) : null,prUrl:prUrl(value.pr,repo)};
}
export function projectState(raw: unknown, repo: Repository, updatedAt: number, now: number): RepoSnapshot {
  if (!record(raw) || raw.version!==1 || raw.repo?.toString().toLowerCase()!==repo.repo.toLowerCase() || !statuses.includes(String(raw.status)) || typeof raw.paused!=='boolean' || (raw.current!==null && (!record(raw.current) || !issue(raw.current.number) || !stages.includes(String(raw.current.stage))))) throw new Error('invalid_state');
  return {id:repo.id,repo:repo.repo,enabled:repo.enabled,ownership:'observe-only',status:String(raw.status),paused:raw.paused,current:projectJob(raw.current,repo.repo),defaultModel:repo.defaultModel,defaultEffort:repo.defaultEffort,quota:{status:raw.status==='quota-wait' ? 'waiting' : 'unknown',nextRetryAt:date(raw.nextRetryAt),startedAt:date(raw.quotaWaitStarted)},stateUpdatedAt:date(updatedAt),heartbeat:null,logs:{status:'unavailable',events:[]},freshness:now-updatedAt>300_000 ? 'stale' : 'observed',reason:reasons.includes(String(raw.lastReason)) ? String(raw.lastReason) : 'unknown',runs:[]};
}
export async function readPrivateJson(path: string): Promise<{value: unknown; modified: number}> {
  const file=await open(path,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat=await file.stat();
    if (!stat.isFile() || stat.size>1_048_576) throw new Error('invalid_file');
    // Bounded read even when another producer grows the file after stat.
    const buffer=Buffer.alloc(1_048_577); const {bytesRead}=await file.read(buffer,0,buffer.length,0);
    if (bytesRead>1_048_576) throw new Error('oversized_file');
    return {value:JSON.parse(buffer.subarray(0,bytesRead).toString('utf8')),modified:stat.mtimeMs};
  } finally { await file.close(); }
}
export async function observeRepository(repo: Repository, now: number): Promise<RepoSnapshot> {
  try {
    if (await realpath(repo.stateDirectory)!==repo.stateDirectory) throw new Error('changed_root');
    const {value,modified}=await readPrivateJson(join(repo.stateDirectory,'state.json'));
    const snapshot=projectState(value,repo,modified,now);
    try { projectTelemetry((await readPrivateJson(join(repo.stateDirectory,'telemetry.json'))).value,snapshot,now); } catch { /* Legacy workers have no sidecar. */ }
    // Historical issue archives only; never return their result/progress/session/path fields.
    const found: string[]=[]; let scanned=0;
    for await (const entry of await opendir(repo.stateDirectory)) {
      if (++scanned>4096) break;
      if (entry.isFile() && /^issue-[1-9]\d*\.json$/.test(entry.name)) found.push(entry.name);
    }
    const names=found.sort((a,b)=>Number(b.slice(6,-5))-Number(a.slice(6,-5))).slice(0,20);
    for (const name of names) {
      try {
        const {value}=await readPrivateJson(join(repo.stateDirectory,name));
        const job=projectJob(value,repo.repo);
        if (!job || name!==`issue-${job.issue}.json`) continue;
        const result=record(value)&&record(value.result)?value.result:{};
        const outcome=['completed','needs_human','failed','paused','quota_wait'].includes(String(result.status))?String(result.status):'unknown';
        snapshot.runs.push({issue:job.issue,outcome,stage:job.stage,prUrl:job.prUrl});
      } catch { /* Unsafe archive is unavailable, never expose the underlying error. */ }
    }
    return snapshot;
  } catch {
    return {id:repo.id,repo:repo.repo,enabled:repo.enabled,ownership:'observe-only',status:'unavailable',paused:null,current:null,defaultModel:repo.defaultModel,defaultEffort:repo.defaultEffort,quota:{status:'unknown',nextRetryAt:null,startedAt:null},stateUpdatedAt:null,heartbeat:null,logs:{status:'unavailable',events:[]},freshness:'unavailable',reason:'status_unavailable',runs:[]};
  }
}
export async function collectSnapshot(registry: Registry, now=Date.now(), supervisorDirectory?:string): Promise<Snapshot> {
  const repositories=await Promise.all(registry.repositories.map(repo=>observeRepository(repo,now)));
  if(supervisorDirectory)try{projectSupervisorHeartbeat((await readPrivateJson(join(supervisorDirectory,'supervisor-heartbeat.json'))).value,registry,repositories,now);}catch{/* Missing runtime observation remains unknown. */}
  return {schemaVersion:1,generatedAt:new Date(now).toISOString(),mode:'observe-only',controller:{status:'observing',globalConcurrency:1,execution:'not-managed'},repositories,queue:{status:'unavailable',reason:'github_adapter_not_connected',repositories:[],items:[]}};
}
export function demoSnapshot(now=Date.now()): Snapshot {
  const repo: Repository={id:'example--care-record',repo:'example/care-record',clonePath:'/unused',stateDirectory:'/unused',enabled:false,ownership:'observe-only',defaultModel:'gpt-6.1-sol',defaultEffort:'medium',maximumConcurrency:1};
  const first=projectState({version:1,repo:repo.repo,status:'needs-human',paused:true,current:{number:55,stage:'implement',failures:1,quotaWaits:0,repair:{category:'local_verification',check:'test:ui'}},lastReason:'verification_retry_exhausted',nextRetryAt:null,quotaWaitStarted:null},repo,now,now);
  return {...{schemaVersion:1 as const,generatedAt:new Date(now).toISOString(),mode:'demo' as const,controller:{status:'observing' as const,globalConcurrency:1 as const,execution:'not-managed' as const},repositories:[first,projectState({version:1,repo:'example/project-b',status:'quota-wait',paused:false,current:{number:12,stage:'implement',failures:0,quotaWaits:2},lastReason:'quota_wait',nextRetryAt:now+900_000,quotaWaitStarted:now}, {...repo,id:'example--project-b',repo:'example/project-b'},now,now)]},queue:{status:'observed',reason:'observed',repositories:[{repositoryId:repo.id,repo:repo.repo,status:'observed',reason:'observed',updatedAt:new Date(now).toISOString(),items:[]}],items:[{repositoryId:repo.id,repo:repo.repo,issue:73,priority:'p1',prioritySource:'metadata',dependencies:[],status:'ready',reason:'eligible'},{repositoryId:repo.id,repo:repo.repo,issue:74,priority:'p2',prioritySource:'label',dependencies:[55],status:'waiting',reason:'dependency_open'}]}};
}
