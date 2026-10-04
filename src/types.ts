export interface Repository {
  id: string;
  repo: string;
  clonePath: string;
  stateDirectory: string;
  enabled: boolean;
  ownership: 'observe-only';
  defaultModel: 'gpt-6.1-sol';
  defaultEffort: 'low' | 'medium' | 'high' | 'xhigh';
  maximumConcurrency: 1;
}
export interface Registry { version: 1; globalConcurrency: 1; repositories: Repository[] }
export interface Job {
  issue: number; stage: 'prepare'|'implement'|'publish'|'unknown';
  failures: number | null; quotaWaits: number | null;
  model: string | null; effort: string | null;
  reasonCategories: string[]; check: string | null; prUrl: string | null;
}
export interface RepoSnapshot {
  id: string; repo: string; enabled: boolean; ownership: 'observe-only'|'managed';
  status: string; paused: boolean | null; current: Job | null;
  defaultModel: string; defaultEffort: string;
  quota: { status: 'waiting'|'unknown'; nextRetryAt: string | null; startedAt: string | null };
  stateUpdatedAt: string | null; heartbeat: {at:string;status:'updating'|'stale'|'stopped';source?:'managed-controller'} | null;
  logs: {status:'observed'|'stale'|'unavailable';events:{at:string;type:'state'|'worker.started'|'worker.stopped'|'codex.started';issue:number|null;stage:string|null;status:string}[]};
  freshness: 'observed'|'stale'|'unavailable'; reason: string;
  runs: { issue: number; outcome: string; stage: string; prUrl: string | null }[];
}
export interface Snapshot {
  schemaVersion: 1; generatedAt: string; mode: 'observe-only'|'demo'|'managed';
  controller: ControllerView;
  repositories: RepoSnapshot[];
  queue: QueueSnapshot;
}

export interface QueueItem {
  repositoryId: string; repo: string; issue: number;
  priority: 'p0'|'p1'|'p2'|'p3'|'unspecified';
  prioritySource: 'metadata'|'label'|'default';
  dependencies: number[];
  status: 'ready'|'waiting'|'running'|'needs-human'|'blocked'|'excluded';
  reason: 'eligible'|'dependency_open'|'dependency_unknown'|'association_unknown'|'linked_pr'|'invalid_metadata'|'running_label'|'needs_human_label'|'blocked_label'|'failed_label';
}
export interface RepositoryQueue {
  repositoryId: string; repo: string;
  status: 'observed'|'partial'|'stale'|'unavailable';
  reason: 'observed'|'limited_observation'|'github_unavailable'|'not_yet_observed';
  updatedAt: string|null; items: QueueItem[];
}
export interface QueueSnapshot {
  status: 'observed'|'partial'|'stale'|'unavailable';
  reason: 'github_adapter_not_connected'|'observed'|'limited_observation'|'github_unavailable'|'not_yet_observed';
  repositories: RepositoryQueue[]; items: QueueItem[];
}

export interface ControlRequest {
  requestId:string; expectedRevision:number; target:string;
  action:'pause'|'resume'|'enable'|'disable';
}
export interface ControlAck {
  requestId:string; revision:number; status:'applied'; scope:'dispatch-intent';
  application?:{status:'applied'|'draining'|'blocked'|'not-managed'|'superseded';reason:SchedulerReason};
}
export interface ControllerView {
  status:'observing'|'paused'|'running'|'draining'|'idle'|'blocked'; globalConcurrency:1; execution:'not-managed'|'managed';
  scheduler?:SchedulerView;
  revision?:number; paused?:boolean; controls?:'dispatch-intent';
  repositories?:{id:string;enabled:boolean;paused:boolean}[];
}

export type SchedulerReason = 'observe_only'|'paused'|'disabled'|'running'|'draining'|'idle'|'shared_quota_wait'|'worker_state_unavailable'|'queue_unverified'|'needs_human'|'dispatch_unavailable'|'reconciliation_required'|'storage_uncertain'|'stopping'|'superseded';
export interface SchedulerView {
  status:'idle'|'running'|'draining'|'paused'|'blocked';reason:SchedulerReason;
  active:{repositoryId:string;issue:number}|null;managedRepositoryIds:string[];
  nextRetryAt:string|null;
}
