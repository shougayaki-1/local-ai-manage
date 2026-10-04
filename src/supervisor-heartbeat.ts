import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { registryFingerprint } from './handoff.ts';
import { record } from './registry.ts';
import type { Registry, RepoSnapshot } from './types.ts';
export function projectSupervisorHeartbeat(raw:unknown,registry:Registry,repositories:RepoSnapshot[],now:number){
 if(!record(raw)||Object.keys(raw).length!==5||raw.version!==1||raw.fingerprint!==registryFingerprint(registry)||typeof raw.runId!=='string'||!/^[a-f0-9-]{36}$/.test(raw.runId)||!Number.isSafeInteger(raw.at)||(raw.at as number)<0||(raw.at as number)>8.64e15||(raw.at as number)>now||!['active','stopped'].includes(String(raw.lifecycle)))return;
 for(const repo of repositories)if(!repo.current&&repo.freshness!=='unavailable')repo.heartbeat={at:new Date(raw.at as number).toISOString(),status:raw.lifecycle==='stopped'?'stopped':now-(raw.at as number)>60000?'stale':'updating',source:'managed-controller'};
}
/** A controller timer, independent of the publisher and bounded job child. No dispatch authority. */
export async function startSupervisorHeartbeat(directory:string,registry:Registry,now=Date.now){
 const runId=randomUUID();let lane=Promise.resolve();let closed=false;
 const write=(lifecycle:'active'|'stopped')=>{lane=lane.then(async()=>{const temp=join(directory,randomUUID()+'.tmp');const file=await open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{await file.writeFile(JSON.stringify({version:1,fingerprint:registryFingerprint(registry),runId,at:now(),lifecycle}));await file.sync();}finally{await file.close();}try{await rename(temp,join(directory,'supervisor-heartbeat.json'));}finally{await unlink(temp).catch(()=>{});}}).catch(()=>{});return lane;};
 await write('active');const timer=setInterval(()=>{if(!closed)void write('active');},15000);timer.unref();
 return {close:async()=>{if(closed)return;closed=true;clearInterval(timer);await write('stopped');}};
}
