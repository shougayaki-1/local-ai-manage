import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Registry, Repository } from './types.ts';
const execute = promisify(execFile);
const repoPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const keys = ['id','repo','clonePath','stateDirectory','enabled','ownership','defaultModel','defaultEffort','maximumConcurrency'];
export const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const inside = (root: string, child: string) => { const p=relative(root,child); return p === '' || (!p.startsWith(`..${sep}`) && p !== '..' && !isAbsolute(p)); };
export function parseRegistry(value: unknown): Registry {
  if (!record(value) || Object.keys(value).some(k=>!['version','globalConcurrency','repositories'].includes(k)) || value.version!==1 || value.globalConcurrency!==1 || !Array.isArray(value.repositories) || value.repositories.length>32) throw new Error('invalid_registry');
  const ids=new Set<string>(); const repos=new Set<string>();
  const repositories = value.repositories.map((item): Repository => {
    if (!record(item) || Object.keys(item).some(k=>!keys.includes(k)) || typeof item.repo!=='string' || !repoPattern.test(item.repo) || item.repo.split('/').some(s=>s==='.'||s==='..') || item.id!==item.repo.toLowerCase().replace('/','--') || ids.has(String(item.id)) || repos.has(item.repo.toLowerCase()) || typeof item.enabled!=='boolean' || item.ownership!=='observe-only' || item.maximumConcurrency!==1 || item.defaultModel!=='gpt-6.1-sol' || !['low','medium','high','xhigh'].includes(String(item.defaultEffort)) || typeof item.clonePath!=='string' || !isAbsolute(item.clonePath) || typeof item.stateDirectory!=='string' || !isAbsolute(item.stateDirectory)) throw new Error('invalid_repository');
    ids.add(String(item.id)); repos.add(item.repo.toLowerCase());
    return item as unknown as Repository;
  });
  return { version:1, globalConcurrency:1, repositories };
}
export async function loadRegistry(path: string): Promise<Registry> {
  const info = await stat(path); if (!info.isFile() || info.size>65536) throw new Error('invalid_registry');
  const registry = parseRegistry(JSON.parse(await readFile(path,'utf8')));
  const paths: {clone: string; state: string; common: string}[] = [];
  for (const repo of registry.repositories) {
    const clone=await realpath(repo.clonePath); const state=await realpath(repo.stateDirectory);
    if (!(await stat(clone)).isDirectory() || !(await stat(state)).isDirectory() || inside(clone,state) || inside(state,clone)) throw new Error('invalid_paths');
    // Fixed read-only git commands; no shell, hooks, gh, credentials or repository scripts.
    const git = async (args: string[]) => (await execute('git',['-c','core.fsmonitor=false',...args],{cwd:clone,timeout:5000,maxBuffer:16384,env:{PATH:process.env.PATH,HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}})).stdout.trim();
    const origin=await git(['remote','get-url','origin']);
    const identity=origin.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/)?.[1];
    if (identity?.toLowerCase()!==repo.repo.toLowerCase()) throw new Error('origin_mismatch');
    const common=await realpath(resolve(clone,await git(['rev-parse','--git-common-dir'])));
    for (const prev of paths) if (prev.common===common || [prev.clone,prev.state].some(p=>inside(p,clone)||inside(clone,p)||inside(p,state)||inside(state,p))) throw new Error('overlapping_repository');
    paths.push({clone,state,common}); repo.clonePath=clone; repo.stateDirectory=state;
  }
  return registry;
}
