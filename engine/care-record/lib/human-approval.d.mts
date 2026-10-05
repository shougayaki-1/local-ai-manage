import type {CanonicalBinding} from './canonical-spec.mjs';
export type DiffBinding = {kind:'diff';base:string;head:string;diffDigest:string};
export type IssueBinding = {kind:'issue';issueDigest:string};
export type Binding = DiffBinding | IssueBinding;
export type E2eScope = {specs:string[];projects:string[]};
export type Grant = {repositoryId:string;repo:string;issue:number;reason:string;binding:Binding;approvedAt:number;e2e:E2eScope|null};
export const approvableReasons: readonly string[];
export const e2eSpecs: readonly string[];
export const e2eProjects: readonly string[];
export function digest(value:string|Buffer):string;
export function parseE2e(value:unknown):E2eScope;
export function parseBinding(value:unknown):Binding;
export function parseGrant(value:unknown):Grant;
export function pendingReasons(current:unknown):string[];
export function guardReasons(changed:string[],profile?:string,patch?:string):string[];
export function approvalStatus(grants:Grant[],repositoryId:string,repo:string,issue:number,reason:string,binding:Binding|undefined):'missing'|'approved'|'stale';
export function issueBinding(issue:{body?:string}):IssueBinding;
export function diffBinding(current:{base?:unknown;worktree:string;branch:string},execute:(binary:string,args:string[],options?:{cwd?:string})=>Promise<string>):Promise<DiffBinding>;
export function changedFiles(current:{base?:unknown;worktree:string},execute:(binary:string,args:string[],options?:{cwd?:string})=>Promise<string>):Promise<string[]>;
export function protectedReasons(current:{base?:unknown;worktree:string},execute:(binary:string,args:string[],options?:{cwd?:string})=>Promise<string>,profile:string):Promise<string[]>;

export const operationalReasons: readonly string[];
export function recoveryState(current:unknown):'automatic_retry_pending'|'human_investigation_required'|null;
export function parseRecovery(value:unknown):{issue:IssueBinding;diff:DiffBinding};

export type Reevaluation = {requestId:string;issue:IssueBinding;previousIssueDigest:string;diff:DiffBinding|null;canonical?:CanonicalBinding;previousCanonicalDigest?:string};
export function parseReevaluation(value:unknown):Reevaluation;

export function parseReviewBinding(value:unknown):{issue:IssueBinding;diff:DiffBinding|null;canonical?:CanonicalBinding};
export const automaticReviewReasons:readonly string[];
export function automaticReviewEligible(reasons:unknown):boolean;
export function automaticReason(policy:unknown,profile:unknown,reason:string):boolean;
