import { assertRecoveryClear } from './recovery-guard.ts';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, open, realpath, rename, unlink, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, sep, isAbsolute, resolve } from 'node:path';
import { readPrivateJson } from './snapshot.ts';
import { record } from './registry.ts';
import type { Registry, Snapshot, ControlRequest, ControlAck, ControllerView } from './types.ts';
const keys=(value:Record<string,unknown>,expected:string[])=>Object.keys(value).length===expected.length && expected.every(key=>Object.hasOwn(value,key));
export class ControlError extends Error {
  readonly status: number;
  constructor(code:string,status=400) { super(code);this.status=status; }
}
export function parseControl(value:unknown,ids:readonly string[]):ControlRequest {
  if (!record(value) || !keys(value,['requestId','expectedRevision','target','action']) || typeof value.requestId!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.requestId) || !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number)<0 || typeof value.target!=='string' || (value.target!=='global' && !ids.includes(value.target)) || typeof value.action!=='string' || !['pause','resume','enable','disable'].includes(value.action) || (value.target==='global' && !['pause','resume'].includes(String(value.action)))) throw new ControlError('invalid_control');
  return {requestId:value.requestId,expectedRevision:value.expectedRevision as number,target:value.target,action:value.action as ControlRequest['action']};
}
export interface ControllerState {
  version:1; topology:string; revision:number; paused:boolean;
  repositories:Record<string,{enabled:boolean;paused:boolean}>;
  requests:{command:ControlRequest;ack:ControlAck}[];
}
/** Owns dispatch preferences only. Legacy worker state and GitHub labels are never written. */
export class Controller {
  private state:ControllerState;
  private directory:string;
  private ids:string[];
  private lane:Promise<void>=Promise.resolve();
  private closed=false;
  private writable=true;
  private runtime:{view:()=>NonNullable<ControllerView['scheduler']>;application:(command:ControlRequest)=>NonNullable<ControlAck['application']>}|null=null;
  private lock:Awaited<ReturnType<typeof open>>;
  private constructor(state:ControllerState,directory:string,ids:string[],lock:Awaited<ReturnType<typeof open>>) {this.state=state;this.directory=directory;this.ids=ids;this.lock=lock;}
  static async create(registry:Registry,directory:string):Promise<Controller> {
    if (!isAbsolute(directory) || resolve(directory)!==directory) throw new ControlError('controller_directory_invalid');
    const forbidden=registry.repositories.flatMap(repo=>[repo.clonePath,repo.stateDirectory]);
    // Reject a symlink and any ancestor/descendant overlap with worker data before creating anything.
    const parent=await realpath(join(directory,'..'));
    const candidate=join(parent,directory.split(sep).at(-1)!);
    if (forbidden.some(path=>candidate===path || candidate.startsWith(path+sep) || path.startsWith(candidate+sep))) throw new ControlError('controller_path_overlap');
    await assertRecoveryClear(candidate);
    await mkdir(candidate,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    return Controller.openExisting(registry,candidate);
  }
  static async openExisting(registry:Registry,directory:string):Promise<Controller> {
    const entry=await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid!==process.getuid?.() || (entry.mode&0o077)!==0) throw new ControlError('controller_directory_unsafe');
    const root=await realpath(directory);
    const paths=registry.repositories.flatMap(repo=>[repo.clonePath,repo.stateDirectory]);
    if (paths.some(path=>root===path || root.startsWith(path+sep) || path.startsWith(root+sep))) throw new ControlError('controller_path_overlap');
    const ids=registry.repositories.map(repo=>repo.id);
    const topology=controllerTopology(registry);
    await assertRecoveryClear(root);
    const lock=await open(join(root,'controller.lock'),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
    try {
      await assertRecoveryClear(root);
      await lock.writeFile(JSON.stringify({version:1,instance:randomUUID()}));await lock.sync();
      let state:ControllerState;
      try {
        const raw=(await readPrivateJson(join(root,'controller.json'))).value;
        if (!record(raw) || !keys(raw,['version','topology','revision','paused','repositories','requests']) || raw.version!==1 || raw.topology!==topology || !Number.isSafeInteger(raw.revision) || (raw.revision as number)<0 || typeof raw.paused!=='boolean' || !record(raw.repositories) || !keys(raw.repositories,ids) || !Array.isArray(raw.requests) || raw.requests.length>1024) throw new ControlError('controller_state_invalid');
        for (const item of Object.values(raw.repositories)) if (!record(item) || !keys(item,['enabled','paused']) || typeof item.enabled!=='boolean' || typeof item.paused!=='boolean') throw new ControlError('controller_state_invalid');
        const seen=new Set<string>();let revision=0;let paused=true;
        const preferences=Object.fromEntries(registry.repositories.map(repo=>[repo.id,{enabled:repo.enabled,paused:true}]));
        for (const item of raw.requests) {
          if (!record(item) || !keys(item,['command','ack'])) throw new ControlError('controller_state_invalid');
          const command=parseControl(item.command,ids);
          if (seen.has(command.requestId) || command.expectedRevision!==revision || !record(item.ack) || !keys(item.ack,['requestId','revision','status','scope']) || item.ack.requestId!==command.requestId || item.ack.revision!==++revision || item.ack.status!=='applied' || item.ack.scope!=='dispatch-intent') throw new ControlError('controller_state_invalid');
          seen.add(command.requestId);
          if(command.target==='global')paused=command.action==='pause';
          else {const preference=preferences[command.target]!;if(command.action==='pause'||command.action==='resume')preference.paused=command.action==='pause';else preference.enabled=command.action==='enable';}
        }
        if (raw.paused!==paused || ids.some(id=>{const item=(raw.repositories as Record<string,{enabled:boolean;paused:boolean}>)[id]!;return item.enabled!==preferences[id]!.enabled || item.paused!==preferences[id]!.paused;})) throw new ControlError('controller_state_invalid');
        if (raw.revision!==revision) throw new ControlError('controller_state_invalid');
        state=raw as unknown as ControllerState;
      } catch(error) {
        if (!(error instanceof Error) || !('code' in error) || error.code!=='ENOENT') throw error;
        state=initialControllerState(registry);
      }
      const controller=new Controller(state,root,ids,lock);
      await controller.persist(state);return controller;
    } catch(error) {await lock.close();await unlink(join(root,'controller.lock'));throw error;}
  }
  private async persist(state:ControllerState):Promise<void> {
    const path=join(this.directory,`${randomUUID()}.tmp`);
    const handle=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
    try {await handle.writeFile(JSON.stringify(state));await handle.sync();} finally {await handle.close();}
    try {await rename(path,join(this.directory,'controller.json'));const dir=await open(this.directory,constants.O_RDONLY);try {await dir.sync();} finally {await dir.close();}}
    finally {await unlink(path).catch(()=>{});}
  }
  attachRuntime(runtime:NonNullable<Controller['runtime']>):void {if(this.runtime)throw new ControlError('runtime_already_connected');this.runtime=runtime;}
  directoryPath():string {return this.directory;}
  async dispatchGate<T>(work:(view:ControllerView)=>Promise<T>):Promise<T> {
    const pending=this.lane.then(()=>{if(this.closed||!this.writable)throw new ControlError('controller_unavailable',503);return work(this.view());});
    this.lane=pending.then(()=>{},()=>{});return pending;
  }
  preferences():ControllerView {return {status:this.state.paused?'paused':'observing',globalConcurrency:1,execution:'not-managed',revision:this.state.revision,paused:this.state.paused,controls:'dispatch-intent',repositories:Object.entries(this.state.repositories).map(([id,value])=>({id,...value}))};}
  view():ControllerView {
    const scheduler=this.runtime?.view();
    return {status:!this.writable?'blocked':scheduler?.status??(this.state.paused?'paused':'observing'),globalConcurrency:1,execution:scheduler?'managed':'not-managed',...(scheduler?{scheduler}:{}),revision:this.state.revision,paused:this.state.paused,controls:'dispatch-intent',repositories:Object.entries(this.state.repositories).map(([id,value])=>({id,...value}))};
  }
  project(snapshot:Snapshot):Snapshot {const view=this.view();return {...snapshot,mode:view.execution==='managed'?'managed':snapshot.mode,controller:view,repositories:snapshot.repositories.map(repo=>({...repo,ownership:view.scheduler?.managedRepositoryIds.includes(repo.id)?'managed':repo.ownership}))};}
  apply(value:unknown):Promise<ControlAck> {
    const command=parseControl(value,this.ids);
    const work=this.lane.then(async()=>{
      if (!this.writable) throw new ControlError('controller_storage_uncertain',503);
      if (this.closed) throw new ControlError('controller_closed',503);
      const prior=this.state.requests.find(item=>item.command.requestId===command.requestId);
      if (prior) {
        if (JSON.stringify(prior.command)!==JSON.stringify(command)) throw new ControlError('request_id_conflict',409);
        return this.ack(command.requestId)!;
      }
      if (command.expectedRevision!==this.state.revision) throw new ControlError('revision_conflict',409);
      if (this.state.requests.length>=1024) throw new ControlError('request_history_full',503);
      const next=structuredClone(this.state);
      if (command.target==='global') next.paused=command.action==='pause';
      else {
        const repo=next.repositories[command.target]!;
        if (command.action==='pause' || command.action==='resume') repo.paused=command.action==='pause';
        else repo.enabled=command.action==='enable';
      }
      const ack:ControlAck={requestId:command.requestId,revision:++next.revision,status:'applied',scope:'dispatch-intent'};
      next.requests.push({command,ack});try {await this.persist(next);} catch(error) {this.writable=false;throw error;}this.state=next;return this.ack(command.requestId)!;
    });
    this.lane=work.then(()=>{},()=>{});return work;
  }
  ack(requestId:string):ControlAck|null {
    const index=this.state.requests.findIndex(item=>item.command.requestId===requestId);const item=this.state.requests[index];if(!item)return null;
    if(!this.runtime)return {...item.ack};
    const axis=(action:ControlRequest['action'])=>action==='pause'||action==='resume'?'pause':'enable';
    const superseded=this.state.requests.slice(index+1).some(later=>later.command.target===item.command.target&&axis(later.command.action)===axis(item.command.action));
    return {...item.ack,application:superseded?{status:'superseded',reason:'superseded'}:this.runtime.application(item.command)};
  }
  async close():Promise<void> {if(this.closed)return;this.closed=true;await this.lane;await this.lock.close();await unlink(join(this.directory,'controller.lock'));}
}

export function controllerTopology(registry:Registry):string {return createHash('sha256').update(JSON.stringify(registry.repositories.map(repo=>[repo.id,repo.repo,repo.clonePath,repo.stateDirectory,repo.enabled]).sort())).digest('hex');}
export function initialControllerState(registry:Registry):ControllerState {return {version:1,topology:controllerTopology(registry),revision:0,paused:true,repositories:Object.fromEntries(registry.repositories.map(repo=>[repo.id,{enabled:repo.enabled,paused:true}])),requests:[]};}
