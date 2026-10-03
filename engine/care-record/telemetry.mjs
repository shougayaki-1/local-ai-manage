import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
// No free text enters this channel. It is diagnostic only, never an execution gate.
export function createTelemetry(directory, repo, { now=Date.now, intervalMs=15_000 }={}) {
  let state=null, invocation=null, timer=null, stopped=false, sequence=0, events=[], signature=null;
  let lane=Promise.resolve(), queued=false;
  const runId=randomUUID();
  const number=value=>Number.isSafeInteger(value)&&value>0?value:null;
  const queue=()=>{
    if (queued) return lane;
    queued=true;
    lane=lane.then(async()=>{
      queued=false;
      const value={version:1,repo,runId,sequence:++sequence,updatedAt:now(),lifecycle:stopped?'stopped':'active',issue:state.issue,stage:state.stage,status:state.status,invocation,events:[...events]};
      const path=join(directory,'telemetry.json'), temporary=`${path}.${randomUUID()}.tmp`;
      let file;
      try {
        file=await open(temporary,'wx',0o600);
        await file.writeFile(JSON.stringify(value)+'\n');await file.sync();await file.close();file=null;
        await rename(temporary,path);
      } finally {await file?.close();await unlink(temporary).catch(()=>{});}
    }).catch(()=>{/* Missing/stale telemetry is displayed as unavailable; job semantics stay intact. */});
    return lane;
  };
  const event=type=>{events.push({at:now(),type,issue:state.issue,stage:state.stage,status:state.status});events=events.slice(-100);};
  return {
    async update(raw) {
      if(stopped)return;
      state={issue:number(raw.current?.number),stage:['prepare','implement','publish'].includes(raw.current?.stage)?raw.current.stage:null,status:['idle','running','quota-wait','needs-human','failed'].includes(raw.status)?raw.status:'idle'};
      if(invocation?.issue!==state.issue)invocation=null;
      const next=JSON.stringify(state);if(signature!==next){signature=next;event('state');}
      if(!timer){event('worker.started');timer=setInterval(()=>{void queue();},intervalMs);timer.unref();}
      await queue();
    },
    async launched() {
      if(!state||stopped||!state.issue)return;
      invocation={issue:state.issue,model:'gpt-6.1-sol',effort:'medium',source:'cli-spawn'};
      event('codex.started');await queue();
    },
    async close() {
      clearInterval(timer);if(!state)return;
      stopped=true;event('worker.stopped');await queue();await lane;
    },
  };
}
