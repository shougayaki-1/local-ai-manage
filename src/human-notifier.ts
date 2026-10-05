import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { githubEnvironment } from './github-queue.ts';
import type { Registry, Snapshot } from './types.ts';
const {parseAttention,attentionComment}=await import(new URL(import.meta.url.endsWith('.ts')?'../engine/attention-writer.mjs':'../../engine/attention-writer.mjs',import.meta.url).href);
export interface Attention {version:1;issue:number;reason:string;categories:string[];check:string|null}
export type AttentionDispatch=(repo:string,event:Attention)=>Promise<void>;
function api(resource:string,payload?:unknown):Promise<unknown>{return new Promise((resolve,reject)=>{const child=execFile('gh',['api','--hostname','github.com','--method',payload===undefined?'GET':'POST',resource,...(payload===undefined?[]:['--input','-'])],{cwd:homedir(),env:githubEnvironment(process.env),timeout:10000,maxBuffer:1048576,shell:false},(err,stdout)=>{if(err){reject(new Error('attention_unavailable'));return;}try{resolve(stdout.trim()?JSON.parse(stdout):null);}catch{reject(new Error('attention_unavailable'));}});child.stdin?.on('error',()=>{});child.stdin?.end(payload===undefined?'':JSON.stringify(payload));});}
const dispatchAttention:AttentionDispatch=async(repo,event)=>{
 const value=await api(`repos/${repo}`) as {full_name?:string;default_branch?:string};
 if(value?.full_name?.toLowerCase()!==repo.toLowerCase()||!value.default_branch||!/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,199}$/.test(value.default_branch)||value.default_branch.includes('..'))throw new Error('attention_unavailable');
 await api(`repos/${repo}/actions/workflows/codex-worker-attention.yml/dispatches`,{ref:value.default_branch,inputs:{payload:JSON.stringify(event)}});
};
/** Enabled only by an explicit login; the Actions bot authors mentions, not the user's account. */
export class HumanNotifier {
 private last=new Map<string,number>();private registry:Registry;private login:string;private dispatch:AttentionDispatch;
 constructor(registry:Registry,login:string,dispatch:AttentionDispatch=dispatchAttention){this.registry=registry;this.login=login;this.dispatch=dispatch;parseAttention({version:1,issue:1,reason:'unknown',categories:[],check:null},'example/repo',login);}
 async tick(snapshot:Snapshot,now=Date.now(),stopping:()=>boolean=()=>false){
  const results=[];
  for(const configured of this.registry.repositories){
   const repo=snapshot.repositories.find(r=>r.id===configured.id&&r.repo===configured.repo);
   if(!repo||repo.freshness==='unavailable')continue;
   const waiting=[...(repo.humanWaiting??[]),...(repo.status==='needs-human'&&repo.current?[{job:repo.current,reason:repo.reason}]:[])];
   for(const entry of waiting){
    if(stopping())return results;
    if((entry.job.recovery==='automatic_retry_pending'||entry.job.approvals?.some(item=>item.status==='automatic')&&entry.job.recovery!=='human_investigation_required')&&entry.job.reasonCategories.every(reason=>['sandbox_capability','local_verification','verification_retry_limit'].includes(reason)||entry.job.approvals?.some(item=>item.reason===reason&&['approved','automatic'].includes(item.status))))continue;
    try{
     const event:Attention=parseAttention({version:1,issue:entry.job.issue,reason:entry.reason,categories:entry.job.reasonCategories,check:entry.job.check},repo.repo,this.login);
     const {marker}=attentionComment(event,repo.repo,this.login);const key=repo.id+marker;
     const at=this.last.get(key);if(at!==undefined&&now-at<300_000)continue;
     // Back off failures too; each later Actions run checks GitHub for an existing bot comment.
     this.last.set(key,now);await this.dispatch(repo.repo,event);results.push({repositoryId:repo.id,issue:event.issue,status:'queued'});
    }catch{results.push({repositoryId:repo.id,issue:entry.job.issue,status:'unavailable'});}
   }
  }
  return results;
 }
}
