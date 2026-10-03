import { isWorkerProfile, type WorkerProfile } from './profiles.ts';
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { readPrivateJson } from './snapshot.ts';
import { record } from './registry.ts';
import type { Registry } from './types.ts';
import type { Handoff } from './worker-adapter.ts';
export interface HandoffDocument {version:1;registryFingerprint:string;standaloneStopped:true;scope:'all-registered-workers';repositories:{repositoryId:string;profile:WorkerProfile}[]}
export function registryFingerprint(registry:Registry):string {
 return createHash('sha256').update(JSON.stringify(registry.repositories.map(repo=>[repo.id,repo.repo,repo.clonePath,repo.stateDirectory,repo.enabled,repo.defaultModel,repo.defaultEffort]).sort())).digest('hex');
}
export function parseHandoff(value:unknown,registry:Registry):Handoff[] {
 const keys=['version','registryFingerprint','standaloneStopped','scope','repositories'];
 if(!record(value) || Object.keys(value).length!==keys.length || !keys.every(key=>Object.hasOwn(value,key)) || value.version!==1 || value.registryFingerprint!==registryFingerprint(registry) || value.standaloneStopped!==true || value.scope!=='all-registered-workers' || !Array.isArray(value.repositories) || !value.repositories.length || value.repositories.length>registry.repositories.length)throw new Error('invalid_handoff');
 const seen=new Set<string>();
 return value.repositories.map(item=>{
  if(!record(item) || Object.keys(item).length!==2 || typeof item.repositoryId!=='string' || !isWorkerProfile(item.profile) || seen.has(item.repositoryId))throw new Error('invalid_handoff');
  const repo=registry.repositories.find(repo=>repo.id===item.repositoryId);
  if(!repo || !repo.enabled || repo.defaultModel!=='gpt-6.1-sol' || repo.defaultEffort!=='medium')throw new Error('unsupported_handoff');
  seen.add(item.repositoryId);return {repositoryId:item.repositoryId,profile:item.profile,standaloneStopped:true,scope:'all-registered-workers'};
 });
}
export async function loadHandoff(path:string,registry:Registry):Promise<Handoff[]> {
 const info=await lstat(path);if(!info.isFile() || info.isSymbolicLink() || info.uid!==process.getuid?.() || (info.mode&0o077)!==0)throw new Error('unsafe_handoff');
 return parseHandoff((await readPrivateJson(path)).value,registry);
}
