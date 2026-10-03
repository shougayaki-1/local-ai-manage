// Install only with the reviewed, sole-writer workflow and fixed repository variables.
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { classifyHeartbeat, monitorTarget } from './status-monitor.mjs';
const marker='<!-- codex-worker-status -->';
const stamp='\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z';
const category='sandbox_capability|local_verification|db|auth|permission|tenant|production|deploy|credential|external_service|destructive|security|retention|specification|manual_e2e|worktree_safety';
const pattern=new RegExp('^<!-- codex-worker-status -->\\n(?:<!-- codex-worker-heartbeat: ('+stamp+') -->\\n)?\\n## Codex Worker Status\\n\\n- Worker: (heartbeat observed|heartbeat stale|stopped|unknown)\\n- State: (idle|running|quota-wait|needs-human|failed|unavailable)\\n- Paused: (yes|no|unknown)\\n- Current Issue: (#([1-9]\\d*)|—)\\n- Stage: (prepare|implement|publish|unknown)\\n- Reason categories: (unknown|(?:'+category+')(?:, (?:'+category+')){0,4})\\n- Queue: (unavailable|\\d+ ready)\\n- Quota: (waiting|unknown)\\n- Next retry: ('+stamp+'|unknown)\\n- Last heartbeat: ('+stamp+'|unknown)\\n\\nQueue head:\\n((?:- #[1-9]\\d* \\((?:p[0-3]|unspecified)\\)\\n){0,5}|- unavailable\\n)\\n_Local worker state remains authoritative\\. Heartbeat is an observation, not proof of process termination\\._\\n$');
function timestamp(value,now=Infinity){const n=Date.parse(value);return Number.isFinite(n)&&n>=0&&n<=now&&new Date(n).toISOString()===value;}
export function parseEnvelope(value,target,now){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==6||value.issue!==target.issue||value.comment!==target.comment||value.version!==1||value.repositoryId!==target.repo.toLowerCase().replace('/','--')||!timestamp(value.observedAt,now)||typeof value.body!=='string'||value.body.length>16384||!pattern.test(value.body))throw new Error('invalid_status_envelope');
 for(const match of value.body.matchAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g))if(!timestamp(match[0]))throw new Error('invalid_status_timestamp');
 const heartbeat=classifyHeartbeat(value.body,now);const last=value.body.match(/^- Last heartbeat: (.+)$/m)?.[1];const worker=value.body.match(/^- Worker: (.+)$/m)?.[1];
 if(heartbeat.at&&Date.parse(heartbeat.at)>Date.parse(value.observedAt)||last!==(heartbeat.at??'unknown')||!heartbeat.at&&worker!=='unknown')throw new Error('invalid_status_heartbeat');
 for(const match of value.body.matchAll(/#([1-9]\d*)/g))if(!Number.isSafeInteger(Number(match[1])))throw new Error('invalid_status_issue');
 return value;
}
const observation=body=>{const matches=[...body.matchAll(/<!-- codex-worker-observation: ([^\n]+) -->/g)];return matches.length===1&&timestamp(matches[0][1])?matches[0][1]:null;};
function comment(value,target){if(!value||value.id!==target.comment||value.issue_url!==`https://api.github.com/repos/${target.repo}/issues/${target.issue}`||typeof value.body!=='string'||value.body.length>65536||!value.body.startsWith(marker+'\n')||value.body.split(marker).length!==2)throw new Error('invalid_status_comment');return value.body;}
function liveness(body,now){const heartbeat=classifyHeartbeat(body,now);if(heartbeat.status==='stale')return body.replace(/^- Worker: heartbeat observed$/m,'- Worker: heartbeat stale');return body;}
/** Caller must serialize ALL updates and schedule runs in the same sole-writer lane. */
export async function runStatusWriter(target,request,envelope,now=Date.now()){
 if(envelope)parseEnvelope(envelope,target,now);
 const issue=await request(`repos/${target.repo}/issues/${target.issue}`);if(!issue||issue.number!==target.issue||issue.state!=='open'||issue.pull_request||typeof issue.body!=='string'||!issue.body.includes(marker)||!Array.isArray(issue.labels)||issue.labels.some(v=>{const name=typeof v==='string'?v:v?.name;return typeof name!=='string'||name.startsWith('codex:');}))throw new Error('invalid_status_issue');
 const endpoint=`repos/${target.repo}/issues/comments/${target.comment}`;const current=comment(await request(endpoint),target);let body=current;
 if(envelope){const prior=observation(current);if(prior&&Date.parse(prior)>=Date.parse(envelope.observedAt))return {version:1,status:'superseded'};const old=classifyHeartbeat(current,now),next=classifyHeartbeat(envelope.body,now);if(old.at&&(!next.at||Date.parse(old.at)>Date.parse(next.at)))return {version:1,status:'superseded'};body=envelope.body.replace(marker+'\n',marker+`\n<!-- codex-worker-observation: ${envelope.observedAt} -->\n`);}
 body=liveness(body,now);if(body===current)return {version:1,status:'unchanged'};
 // Preserve manual edits detected before PATCH; administrators must stop the sole writer before editing.
 if(comment(await request(endpoint),target)!==current)throw new Error('status_comment_changed');
 if(comment(await request(endpoint,body),target)!==body)throw new Error('status_response_unknown');
 return {version:1,status:envelope?'published':'stale-updated'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{const target=monitorTarget(process.env);const raw=process.env.STATUS_PAYLOAD??'';if(raw.length>20000)throw new Error('payload_too_large');const envelope=raw?JSON.parse(raw):undefined;const request=(resource,body)=>new Promise((resolve,reject)=>{const child=execFile('gh',['api','--hostname','github.com','--method',body===undefined?'GET':'PATCH',resource,...(body===undefined?[]:['--input','-'])],{timeout:10000,killSignal:'SIGKILL',maxBuffer:1048576,shell:false,env:Object.fromEntries(['PATH','HOME','GH_TOKEN','GITHUB_TOKEN','GH_CONFIG_DIR'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))},(error,stdout)=>{if(error){reject(new Error('status_unavailable'));return;}try{resolve(JSON.parse(stdout));}catch{reject(new Error('status_unavailable'));}});child.stdin?.on('error',()=>{});child.stdin?.end(body===undefined?'':JSON.stringify({body}));});console.log(JSON.stringify(await runStatusWriter(target,request,envelope)));}catch{console.log(JSON.stringify({version:1,status:'unavailable'}));process.exitCode=2;}}
