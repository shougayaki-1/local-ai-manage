import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSupervisorHeartbeat, startSupervisorHeartbeat } from '../src/supervisor-heartbeat.ts';
import { registryFingerprint } from '../src/handoff.ts';
import { demoSnapshot } from '../src/snapshot.ts';
import { formatRemoteStatus } from '../src/remote-status.ts';
import type { Registry, RepoSnapshot } from '../src/types.ts';
const {parseEnvelope}=await import(new URL('../engine/status-writer.mjs',import.meta.url).href);
const registry:Registry={version:1,globalConcurrency:1,repositories:[{id:'example--care-record',repo:'example/care-record',clonePath:'/unused',stateDirectory:'/unused-state',enabled:true,ownership:'observe-only',maximumConcurrency:1,defaultModel:'gpt-6.1-sol',defaultEffort:'medium'}]};
test('controller heartbeat is private, independent, explicitly sourced and becomes stopped or stale',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'lam-supervisor-'));t.after(()=>rm(directory,{recursive:true,force:true}));let now=1000000;
 const producer=await startSupervisorHeartbeat(directory,registry,()=>now);t.after(()=>producer.close());
 const file=join(directory,'supervisor-heartbeat.json');const raw=JSON.parse(await readFile(file,'utf8'));assert.equal((await stat(file)).mode&0o077,0);
 const repo:RepoSnapshot={...demoSnapshot(now).repositories[0]!,current:null,status:'idle',heartbeat:null};
 projectSupervisorHeartbeat(raw,registry,[repo],now);assert.equal(repo.heartbeat!.source,'managed-controller');
 const body=formatRemoteStatus(repo,undefined,now);assert.match(body,/- Worker: heartbeat observed/);assert.match(body,/- Heartbeat source: managed-controller/);
 assert.doesNotThrow(()=>parseEnvelope({version:1,repositoryId:repo.id,issue:1,comment:2,observedAt:new Date(now).toISOString(),body},{repo:repo.repo,issue:1,comment:2},now));
 now+=61000;projectSupervisorHeartbeat(raw,registry,[repo],now);assert.equal(repo.heartbeat!.status,'stale');
 now+=900000;assert.match(formatRemoteStatus(repo,undefined,now),/- Worker: heartbeat stale/);
 await producer.close();projectSupervisorHeartbeat(JSON.parse(await readFile(file,'utf8')),registry,[repo],now);assert.equal(repo.heartbeat!.status,'stopped');
});
test('controller heartbeat never replaces active job observation or trusts another topology',()=>{
 const now=1000000;const raw={version:1,fingerprint:registryFingerprint(registry),runId:'a'.repeat(8)+'-aaaa-4aaa-aaaa-'+ 'a'.repeat(12),at:now,lifecycle:'active'};
 const repo=demoSnapshot(now).repositories[0]!;const before=structuredClone(repo);projectSupervisorHeartbeat(raw,registry,[repo],now);assert.deepEqual(repo,before);
 repo.current=null;for(const invalid of [{...raw,fingerprint:'b'.repeat(64)},{...raw,at:now+1},{...raw,secret:'not-public'},{...raw,lifecycle:'unknown'}]){projectSupervisorHeartbeat(invalid,registry,[repo],now);assert.equal(repo.heartbeat,null);}
});
