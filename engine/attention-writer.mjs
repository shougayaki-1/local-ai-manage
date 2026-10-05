// Fixed Actions bot writer: post one mention per sanitized human-review event.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const categories=['sandbox_capability','local_verification','verification_retry_limit','db','auth','permission','tenant','production','deploy','credential','external_service','destructive','security','retention','specification','manual_e2e','worktree_safety'];
const reasons=['needs_human','manual_e2e_required','verification_retry_exhausted','unsafe_or_unavailable_verification','parent_verification_safety_failed','publication_failed','operational_error','stale_existing_worktree','worktree_base_mismatch','branch_deployment_not_disabled','worktree_branch_mismatch','missing_saved_worktree','repair_session_resume_unavailable','repair_session_mismatch','unknown'];
const checks=['typecheck','lint','test','test:unit','test:ui','build','test:codex-worker','test:ci-scope','diff-check'];
const labels={sandbox_capability:'実行環境の制約',local_verification:'ローカル検証',verification_retry_limit:'検証の再試行上限',db:'DB',auth:'認証',permission:'権限',tenant:'組織の境界',production:'本番環境',deploy:'デプロイ',credential:'認証情報',external_service:'外部サービス',destructive:'破壊的操作',security:'セキュリティ',retention:'データ保持',specification:'仕様確認',manual_e2e:'E2Eの手動確認',worktree_safety:'作業領域の安全性',needs_human:'人による確認が必要',manual_e2e_required:'E2Eの手動確認が必要',verification_retry_exhausted:'検証の再試行上限',unsafe_or_unavailable_verification:'検証の実行環境または安全性',parent_verification_safety_failed:'親プロセスの検証',publication_failed:'PR作成',operational_error:'実行環境のエラー',stale_existing_worktree:'既存の作業領域',worktree_base_mismatch:'作業領域の基点',branch_deployment_not_disabled:'作業ブランチのデプロイ抑止',worktree_branch_mismatch:'作業ブランチの一致',missing_saved_worktree:'保存作業領域が見つかりません',repair_session_resume_unavailable:'保存セッションの再開',repair_session_mismatch:'保存セッションの一致',unknown:'詳細は管理コンソールで確認してください'};
export function parseAttention(value,repo,login) {
 if(!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo)||!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)
   ||!value||Object.keys(value).length!==5||value.version!==1||!Number.isSafeInteger(value.issue)||value.issue<1||!reasons.includes(value.reason)
   ||!Array.isArray(value.categories)||value.categories.length>categories.length||value.categories.some(c=>!categories.includes(c))
   ||(value.check!==null&&!checks.includes(value.check)))throw new Error('invalid_attention');
 return {...value,categories:[...new Set(value.categories)].sort()};
}
export function attentionComment(value,repo,login) {
 const event=parseAttention(value,repo,login);
 const key=createHash('sha256').update(JSON.stringify({repo,login,...event})).digest('hex');
 const marker=`<!-- codex-worker-attention: ${key} -->`;
 const body=[marker,`@${login} このIssueで確認が必要になりました。`,'',`- 対象: #${event.issue}`,`- 確認事項: ${labels[event.reason]}`,...(event.categories.length?[`- 理由: ${event.categories.map(c=>labels[c]).join(' / ')}`]:[]),...(event.check?[`- 検証項目: ${event.check}`]:[]),'','作業ブランチ・保存セッションは保持しています。このIssueの自動再開は行わず、依存関係のない実行可能なIssueを先に進めます。','確認後はこのIssueに判断・対応内容を返信してください。'].join('\n');
 return {marker,body};
}
export async function runAttentionWriter(value,repo,login,request) {
 const event=parseAttention(value,repo,login);const {marker,body}=attentionComment(event,repo,login);
 const target=await request(`repos/${repo}/issues/${event.issue}`);
 if(target?.number!==event.issue||target.state!=='open'||target.pull_request)throw new Error('invalid_attention_issue');
 // Duplicate detection survives Mac/Actions restarts and ambiguous POST responses.
 for(let page=1;page<=10;page++){
  const comments=await request(`repos/${repo}/issues/${event.issue}/comments?per_page=100&page=${page}`);
  if(!Array.isArray(comments)||comments.length>100)throw new Error('invalid_comments');
  if(comments.some(c=>c.user?.login==='github-actions[bot]'&&typeof c.body==='string'&&c.body.startsWith(marker+'\n')))return {status:'already-notified'};
  if(comments.length<100){const posted=await request(`repos/${repo}/issues/${event.issue}/comments`,body);if(!posted?.id||posted.body!==body)throw new Error('notification_unconfirmed');return {status:'notified'};}
 }
 throw new Error('comment_scan_limit');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const raw=process.env.ATTENTION_PAYLOAD??'';if(raw.length>4096)throw new Error('payload_limit');
  const request=(resource,body)=>new Promise((resolve,reject)=>{const child=execFile('gh',['api','--hostname','github.com','--method',body===undefined?'GET':'POST',resource,...(body===undefined?[]:['--input','-'])],{timeout:10000,maxBuffer:1048576,shell:false,env:Object.fromEntries(['PATH','HOME','GH_TOKEN','GITHUB_TOKEN','GH_CONFIG_DIR'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))},(err,stdout)=>{if(err){reject(new Error('attention_unavailable'));return;}try{resolve(JSON.parse(stdout));}catch{reject(new Error('attention_unavailable'));}});child.stdin?.on('error',()=>{});child.stdin?.end(body===undefined?'':JSON.stringify({body}));});
  console.log(JSON.stringify(await runAttentionWriter(JSON.parse(raw),process.env.GITHUB_REPOSITORY??'',process.env.ATTENTION_USER??'',request)));
 }catch{console.log(JSON.stringify({status:'unavailable'}));process.exitCode=2;}
}
