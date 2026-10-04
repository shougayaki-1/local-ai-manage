// Trusted fixed artifact; never load worker code from an agent-editable repository clone.
import { createTelemetry } from './telemetry.mjs';
import { assertProfile } from './profile.mjs';
import { worker, configuration } from './continuous-worker.mjs';
import { parseDispatchDescriptor, projectOutcome } from './dispatch-contract.mjs';
process.once('message', async value => {
  try {
    const descriptor=parseDispatchDescriptor(value);
    await assertProfile(descriptor.clonePath,descriptor.profile);
    const state=await worker({config:configuration({CODEX_WORKER_REPO:descriptor.repo,CODEX_WORKER_STATE_DIR:descriptor.stateDirectory}),root:descriptor.clonePath,mode:'once',profile:descriptor.profile,expectedIssue:descriptor.expectedIssue,approval:descriptor.approval,resume:false,continueAfterHuman:true,report:()=>{},telemetry:createTelemetry(descriptor.stateDirectory,descriptor.repo)});
    process.send?.(projectOutcome(state,descriptor.expectedIssue),()=>process.disconnect?.());
  } catch {process.exitCode=1;process.disconnect?.();}
});
// On parent loss, let the bounded worker reach its ordinary safe boundary. The retained
// global reservation prevents restart from assuming orphaned worker/Codex children stopped.
