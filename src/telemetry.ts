import { record } from './registry.ts';
import type { RepoSnapshot } from './types.ts';
const keys=(value:Record<string,unknown>, expected:string[])=>Object.keys(value).length===expected.length&&expected.every(key=>Object.hasOwn(value,key));
const issue=(v:unknown)=>v===null||(Number.isSafeInteger(v)&&(v as number)>0);
const stage=(v:unknown)=>v===null||['prepare','implement','publish'].includes(v as string);
const status=(v:unknown)=>typeof v==='string'&&['idle','running','quota-wait','needs-human','failed'].includes(v);
const date=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0&&(v as number)<=8.64e15;
export function projectTelemetry(value:unknown,snapshot:RepoSnapshot,now:number):void {
  if(!record(value)||!keys(value,['version','repo','runId','sequence','updatedAt','lifecycle','issue','stage','status','invocation','events'])||value.version!==1||value.repo!==snapshot.repo||typeof value.runId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.runId)||!Number.isSafeInteger(value.sequence)||(value.sequence as number)<1||!date(value.updatedAt)||value.updatedAt>now||!['active','stopped'].includes(value.lifecycle as string)||!issue(value.issue)||!stage(value.stage)||!status(value.status)||!Array.isArray(value.events)||value.events.length>100)return;
  if(value.issue!==(snapshot.current?.issue??null)||value.stage!==(snapshot.current?.stage??null)||value.status!==snapshot.status)return;
  const events:RepoSnapshot['logs']['events']=[];
  let previous=0;
  for(const event of value.events){
    if(!record(event)||!keys(event,['at','type','issue','stage','status'])||!date(event.at)||event.at<previous||event.at>value.updatedAt||!['state','worker.started','worker.stopped','codex.started'].includes(event.type as string)||!issue(event.issue)||!stage(event.stage)||!status(event.status))return;
    previous=event.at;events.push({at:new Date(event.at).toISOString(),type:event.type as 'state'|'worker.started'|'worker.stopped'|'codex.started',issue:event.issue as number|null,stage:event.stage as string|null,status:event.status as string});
  }
  if(value.invocation!==null){const v=value.invocation;if(!record(v)||!keys(v,['issue','model','effort','source'])||v.issue!==value.issue||!issue(v.issue)||v.issue===null||v.model!=='gpt-6.1-sol'||v.effort!=='medium'||v.source!=='cli-spawn')return;}
  const freshness=now-value.updatedAt>60_000?'stale':'observed';
  snapshot.heartbeat={at:new Date(value.updatedAt).toISOString(),status:value.lifecycle==='stopped'?'stopped':freshness==='stale'?'stale':'updating'};
  snapshot.logs={status:freshness,events};
  if(record(value.invocation)&&snapshot.current){snapshot.current.model='gpt-6.1-sol';snapshot.current.effort='medium';}
}
