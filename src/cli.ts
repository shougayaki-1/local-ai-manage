import { HumanNotifier } from './human-notifier.ts';
import { Approvals } from './approvals.ts';
import { startSupervisorHeartbeat } from './supervisor-heartbeat.ts';
import { startDashboardSocket, dashboardLaunchUrl } from './dashboard-socket.ts';
import { ActionsStatusPublisher } from './status-actions.ts';
import { ReadinessService, demoReadiness } from './readiness.ts';
import { producerPlan } from './producer-plan.ts';
import { loadStatusTargets, lockPublisher, monitorStatus, StatusPublisher } from './status-publisher.ts';
import { preflight } from './preflight.ts';
import { formatRemoteStatus } from './remote-status.ts';
import { reviewedProfiles } from './profiles.ts';
import { recoveryPlan, reconcileOffline, recoveryResumePlan, resumeRecoveryOffline } from './recovery.ts';
import { homedir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { Scheduler } from './scheduler.ts';
import { loadHandoff } from './handoff.ts';
import { Controller } from './controller.ts';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { loadRegistry } from './registry.ts';
import { collectSnapshot, demoSnapshot } from './snapshot.ts';
import { startServer } from './server.ts';
import { QueueObserver } from './github-queue.ts';
async function main() {
  const args=process.argv.slice(2);
  if(args.length===3&&args[0]==='--mobile-link'&&args[1]==='--controller-state'){console.log(await dashboardLaunchUrl(resolve(args[2]!),true));return;}
  if(args.length===3&&args[0]==='--open-existing'&&args[1]==='--controller-state'){const url=await dashboardLaunchUrl(resolve(args[2]!));await new Promise<void>((resolve,reject)=>{const child=spawn('/usr/bin/open',[url],{stdio:'ignore',env:{PATH:'/usr/bin:/bin'}});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('browser_unavailable')));});return;}
  if(args.length===1&&args[0]==='--profiles'){console.log(JSON.stringify(reviewedProfiles,null,2));return;}
  let lanAddress:string|undefined;let tailscaleAddress:string|undefined;
  let actionsPublisher=false;let publisherDirectory:string|undefined;let monitorDirectory:string|undefined;
  let producerReview=false;
  let check=false;let remoteStatus=false;
  let config: string|undefined;let controlDirectory:string|undefined; let mentionUser:string|undefined; let headless=false; let demo=false; let open=false; let status=false; let port=0; let github=false;let execute=false;let recoveryTarget:string|undefined;let recoveryApply=false;let recoveryResume=false;let attestationPath:string|undefined;
  for (let i=0;i<args.length;i++) {
    const arg=args[i];
    if(['--recovery-plan','--reconcile','--recovery-resume-plan','--resume-recovery'].includes(arg!)){if(recoveryTarget)throw new Error('invalid_flags');recoveryTarget=args[++i];recoveryApply=arg==='--reconcile'||arg==='--resume-recovery';recoveryResume=arg==='--recovery-resume-plan'||arg==='--resume-recovery';if(!recoveryTarget||recoveryTarget.startsWith('--'))throw new Error('invalid_flags');}
    else if(arg==='--attestation'){attestationPath=args[++i];if(!attestationPath||attestationPath.startsWith('--'))throw new Error('invalid_flags');}
    else if(arg==='--status-publisher'||arg==='--status-actions'||arg==='--status-monitor'){const value=args[++i];if(!value||value.startsWith('--')||publisherDirectory||monitorDirectory)throw new Error('invalid_flags');if(arg==='--status-monitor')monitorDirectory=resolve(value);else {publisherDirectory=resolve(value);actionsPublisher=arg==='--status-actions';}}
    else if(arg==='--tailscale'){tailscaleAddress=args[++i];if(!tailscaleAddress||tailscaleAddress.startsWith('--'))throw new Error('invalid_flags');}
    else if(arg==='--lan'){lanAddress=args[++i];if(!lanAddress||lanAddress.startsWith('--'))throw new Error('invalid_flags');}
    else if(arg==='--headless') headless=true;
    else if(arg==='--producer-plan') producerReview=true;
    else if(arg==='--preflight') check=true;
    else if(arg==='--remote-status') remoteStatus=true;
    else if (arg==='--mention-user') { const value=args[++i];if(!value||!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value))throw new Error('invalid_mention_user');mentionUser=value; }
    else if (arg==='--demo') demo=true;
    else if (arg==='--open') open=true;
    else if (arg==='--status') status=true;
    else if (arg==='--execute') execute=true;
    else if (arg==='--github') github=true;
    else if (arg==='--controller-state') {controlDirectory=args[++i];if(!controlDirectory||controlDirectory.startsWith('--'))throw new Error('invalid_flags');}
    else if (arg==='--registry') { config=args[++i]; if (!config || config.startsWith('--')) throw new Error('invalid_flags'); }
    else if (arg==='--port') { const v=args[++i]; if (!v || !/^\d+$/.test(v)) throw new Error('invalid_port'); port=Number(v); if (!Number.isSafeInteger(port)||port>65535) throw new Error('invalid_port'); }
    else throw new Error('invalid_flags');
  }
  if(mentionUser&&!publisherDirectory)throw new Error('mention_requires_publisher');
  if((lanAddress||tailscaleAddress)&&(status||check||remoteStatus||producerReview||publisherDirectory||monitorDirectory||recoveryTarget))throw new Error('invalid_lan_flags');
  if(headless&&(!execute||!controlDirectory||open||demo||publisherDirectory||monitorDirectory||status||check||remoteStatus||recoveryTarget))throw new Error('invalid_headless');
  if(producerReview&&(publisherDirectory||monitorDirectory||demo||open||status||execute||check||remoteStatus||controlDirectory||recoveryTarget||attestationPath||port!==0||github||!config))throw new Error('producer_plan_flags_invalid');
  if(publisherDirectory||monitorDirectory){if(demo||open||status||execute||check||remoteStatus||recoveryTarget||attestationPath||port!==0||monitorDirectory&&(config||github||controlDirectory)||publisherDirectory&&(!config||!github))throw new Error('status_service_flags_invalid');}
  if(monitorDirectory){const result=await monitorStatus(await loadStatusTargets(monitorDirectory));console.log(JSON.stringify(result,null,2));process.exitCode=result.repositories.some(r=>['stale','unavailable','unknown'].includes(r.status))?2:0;return;}
  if((check||remoteStatus)&&(demo||open||execute||status||recoveryTarget||attestationPath||port!==0||!config||check&&remoteStatus||check&&!controlDirectory||remoteStatus&&controlDirectory))throw new Error('diagnostic_flags_invalid');
  if (demo && config) throw new Error('choose_one_source');
  if (!demo && !config) throw new Error('registry_required');
  if(execute&&(demo||status||!github))throw new Error('execution_requires_registry_github_dashboard');
  if((attestationPath&&!recoveryApply)||(recoveryTarget&&(!config||!controlDirectory||demo||status||execute||github||open||port!==0||recoveryApply!==!!attestationPath)))throw new Error('recovery_requires_offline_explicit_paths');
  const registry=config?await loadRegistry(resolve(config)):null;
  if(producerReview&&registry){const result=await producerPlan(registry);console.log(JSON.stringify(result,null,2));process.exitCode=result.repositories.some(r=>r.status==='blocked')?2:0;return;}
  if(publisherDirectory&&registry){
    const targets=await loadStatusTargets(publisherDirectory,registry);const release=await lockPublisher(publisherDirectory);const reader=new QueueObserver(registry);const publisher=actionsPublisher?new ActionsStatusPublisher(targets):new StatusPublisher(targets);const notifier=mentionUser?new HumanNotifier(registry,mentionUser):null;let stopping=false;let wake:(()=>void)|undefined;const stop=()=>{stopping=true;wake?.();};process.on('SIGINT',stop);process.on('SIGTERM',stop);
    try{while(!stopping){await loadStatusTargets(publisherDirectory,registry).then(current=>{if(JSON.stringify(current)!==JSON.stringify(targets))throw new Error('status_targets_changed');});const value=await collectSnapshot(registry,Date.now(),controlDirectory);void reader.refresh();value.queue=reader.snapshot();console.log(JSON.stringify(await publisher.tick(value,Date.now(),()=>stopping)));if(notifier)console.log(JSON.stringify(await notifier.tick(value,Date.now(),()=>stopping)));if(!stopping)await new Promise<void>(resolve=>{const timer=setTimeout(()=>{wake=undefined;resolve();},30000);wake=()=>{clearTimeout(timer);wake=undefined;resolve();};});}}finally{reader.close();process.off('SIGINT',stop);process.off('SIGTERM',stop);await release();}return;
  }
  if(check&&registry&&controlDirectory){const result=await preflight(registry,resolve(controlDirectory),{github});console.log(JSON.stringify(result,null,2));process.exitCode=result.status==='blocked'?2:0;return;}
  if(remoteStatus&&registry){const value=await collectSnapshot(registry);if(github){const reader=new QueueObserver(registry);try{await reader.refresh();value.queue=reader.snapshot();}finally{reader.close();}}console.log(JSON.stringify(value.repositories.map(repo=>({repositoryId:repo.id,body:formatRemoteStatus(repo,value.queue.repositories.find(q=>q.repositoryId===repo.id))})),null,2));return;}
  if(recoveryTarget&&registry&&controlDirectory){
    const source=resolve(controlDirectory),replacement=resolve(recoveryTarget);
    const result=recoveryResume?(recoveryApply?await resumeRecoveryOffline({registry,source,replacement,attestationPath:resolve(attestationPath!)}):await recoveryResumePlan(registry,source,replacement)):(recoveryApply?await reconcileOffline({registry,source,replacement,attestationPath:resolve(attestationPath!)}):await recoveryPlan(registry,source,replacement));
    console.log(JSON.stringify(result,null,2));return;
  }
  if (demo && controlDirectory) throw new Error('demo_has_no_durable_controls');
  if (demo && github) throw new Error('demo_is_offline');
  const observer=registry&&github?new QueueObserver(registry):null;
  let controller:Controller|undefined;
  if (registry&&!status) {
    const directory=resolve(controlDirectory??join(homedir(),'.local/state/local-ai-manage'));
    if(!controlDirectory)await mkdir(dirname(directory),{recursive:true,mode:0o700});
    controller=await Controller.create(registry,directory);
  }
  const snapshot=async()=>{
    const value=registry?await collectSnapshot(registry,Date.now(),controlDirectory):demoSnapshot();
    if(observer) { void observer.refresh(); value.queue=observer.snapshot(); }
    return controller?approvals!.project(controller.project(value)):value;
  };
  let approvals:Approvals|undefined;
  try{approvals=registry&&controller?await Approvals.create(registry,controller,{read:github?undefined:async()=>{throw new Error('approval_github_not_connected');}}):undefined;}
  catch(error){observer?.close();await controller?.close();throw error;}
  if (status) { if(observer)await observer.refresh(); console.log(JSON.stringify(await snapshot(),null,2)); observer?.close(); return; }
  let scheduler:Scheduler|undefined;
  try {if(execute&&registry&&controller){const handoffs=await loadHandoff(join(controller.directoryPath(),'handoff.json'),registry);scheduler=await Scheduler.create({registry,controller,handoffs,snapshot:async()=>{await observer?.refresh();return snapshot();}});}}
  catch(error){observer?.close();await controller?.close();throw error;}
  const readiness=registry&&controller?new ReadinessService(registry,controller.directoryPath(),{activeDashboard:true}):null;
  let dashboard;
  try {dashboard=await startServer({snapshot,webDirectory:join(dirname(fileURLToPath(import.meta.url)),'../web'),port,controller,approvals,lanAddress,tailscaleAddress,readiness:readiness?()=>readiness.get():demo?async()=>demoReadiness():undefined});}
  catch(error) {await scheduler?.close();observer?.close();await controller?.close();throw error;}
  let socket:Awaited<ReturnType<typeof startDashboardSocket>>|undefined;
  if(headless&&controller){try{socket=await startDashboardSocket(controller.directoryPath(),(mobile)=>dashboard.issueLaunchUrl(mobile));}catch(error){await dashboard.close();await scheduler?.close();observer?.close();await controller.close();throw error;}}
  const supervisor=scheduler&&controller&&registry?await startSupervisorHeartbeat(controller.directoryPath(),registry):undefined;
  scheduler?.start();
  console.log(`Local AI Manage: ${dashboard.origin} (${execute?'managed · dispatch initially follows saved preferences':'observe-only'})`);
  if(dashboard.mobileOrigin)console.log(`Mobile dashboard (${tailscaleAddress?'Tailscale':'same Wi-Fi'}): ${dashboard.mobileOrigin}`);
  if (open && process.platform==='darwin') {
    const child=spawn('/usr/bin/open',[dashboard.launchUrl],{stdio:'ignore',env:{PATH:'/usr/bin:/bin'}});
    child.once('error',()=>console.error('Browser could not be opened. Restart without --open.'));
  } else if(!headless) {
    // One-time dashboard-only capability; never worker credentials. Do not redirect/share this output.
    console.log(`One-time login link (expires in 2 minutes): ${dashboard.launchUrl}`);
  }
  let stopping=false;
  const stop=()=>{if(stopping)return;stopping=true;console.log('Stopping new dispatch; waiting for the current job to finish.');void (scheduler?scheduler.close():Promise.resolve()).then(()=>{observer?.close();return dashboard.close();}).then(()=>supervisor?.close()).then(()=>socket?.close()).then(()=>controller?.close()).then(()=>process.exit(0)).catch(()=>{console.error('Shutdown incomplete; retained state requires review.');process.exitCode=1;});};
  process.on('SIGINT',stop); process.on('SIGTERM',stop);
}
main().catch(error=>{if(process.argv.some(arg=>['--recovery-plan','--reconcile','--recovery-resume-plan','--resume-recovery'].includes(arg))){console.error('Recovery did not complete. Check the private attestation, unchanged plan, worker locks and recovery markers. Retained evidence requires review; no worker state or lock is cleared automatically.');process.exitCode=1;return;}void error;console.error('Startup failed. Check registry paths, origin, build and CLI flags. Legacy worker state was not changed.');process.exitCode=1;});
