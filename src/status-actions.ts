import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { githubEnvironment } from './github-queue.ts';
import { parseStatusTargets } from './status-publisher.ts';
import { formatRemoteStatus } from './remote-status.ts';
import { record } from './registry.ts';
import type { StatusTarget, StatusTargets } from './status-publisher.ts';
import type { Snapshot } from './types.ts';
export interface StatusEnvelope {version:1;repositoryId:string;issue:number;comment:number;observedAt:string;body:string}
export type ActionsDispatch=(target:StatusTarget,envelope:StatusEnvelope)=>Promise<void>;
const {parseEnvelope}=await import(new URL(import.meta.url.endsWith('.ts')?'../engine/status-writer.mjs':'../../engine/status-writer.mjs',import.meta.url).href);
function api(args:string[],payload?:unknown):Promise<unknown>{return new Promise((resolve,reject)=>{const child=execFile('gh',['api','--hostname','github.com',...args],{cwd:homedir(),env:githubEnvironment(process.env),timeout:10000,killSignal:'SIGKILL',maxBuffer:1048576,shell:false},(error,stdout)=>{if(error){reject(new Error('actions_status_unavailable'));return;}try{resolve(stdout.trim()?JSON.parse(stdout):null);}catch{reject(new Error('actions_status_unavailable'));}});child.stdin?.on('error',()=>{});child.stdin?.end(payload===undefined?'':JSON.stringify(payload));});}
export const dispatchStatusActions:ActionsDispatch=async(target,envelope)=>{
 parseStatusTargets({version:1,registryFingerprint:'a'.repeat(64),targets:[target]});parseEnvelope(envelope,target,Date.now());
 const repo=await api(['--method','GET',`repos/${target.repo}`]);if(!record(repo)||typeof repo.full_name!=='string'||repo.full_name.toLowerCase()!==target.repo.toLowerCase()||typeof repo.default_branch!=='string'||!/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,199}$/.test(repo.default_branch)||repo.default_branch.includes('..'))throw new Error('invalid_status_repository');
 await api(['--method','POST',`repos/${target.repo}/actions/workflows/codex-worker-status.yml/dispatches`,'--input','-'],{ref:repo.default_branch,inputs:{payload:JSON.stringify(envelope)}});
};
/** Queues sanitized observations; only the reviewed workflow writes comments. */
export class ActionsStatusPublisher {
 private targets:StatusTargets;private dispatch:ActionsDispatch;private last=new Map<string,{at:number;key:string}>();
 constructor(targets:StatusTargets,dispatch:ActionsDispatch=dispatchStatusActions){this.targets=parseStatusTargets(targets);this.dispatch=dispatch;}
 async tick(snapshot:Snapshot,now=Date.now(),stopping:()=>boolean=()=>false){const results=[];for(const target of this.targets.targets){if(stopping())break;const repo=snapshot.repositories.find(r=>r.id===target.repositoryId&&r.repo===target.repo);if(!repo){results.push({repositoryId:target.repositoryId,status:'unavailable'});continue;}const body=formatRemoteStatus(repo,snapshot.queue.repositories.find(q=>q.repositoryId===repo.id),now);const key=body.replace(/<!-- codex-worker-heartbeat: [^\n]+ -->\n/g,'').replace(/^- Last heartbeat: .*$/m,'');const previous=this.last.get(repo.id);if(previous&&previous.key===key&&now-previous.at<300000)continue;this.last.set(repo.id,{key,at:now});try{const envelope:StatusEnvelope={version:1,repositoryId:repo.id,issue:target.issue,comment:target.comment,observedAt:new Date(now).toISOString(),body};parseEnvelope(envelope,target,now);await this.dispatch(target,envelope);results.push({repositoryId:repo.id,status:'queued'});}catch{results.push({repositoryId:repo.id,status:'unavailable'});}}return results;}
}
