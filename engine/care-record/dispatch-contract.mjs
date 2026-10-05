import { profileIds } from './profiles.mjs';
import { isAbsolute } from 'node:path';
import { parseGrant } from './lib/human-approval.mjs';
export function parseDispatchDescriptor(value) {
  const keys=['version','profile','repo','clonePath','stateDirectory','expectedIssue', ...(Object.hasOwn(value ?? {}, 'approval') ? ['approval'] : []), ...(Object.hasOwn(value ?? {}, 'reviewPolicy') ? ['reviewPolicy'] : [])];
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==keys.length || !keys.every(key=>Object.hasOwn(value,key)) || value.version!==1 || !profileIds.includes(value.profile) || typeof value.repo!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value.repo) || typeof value.clonePath!=='string' || !isAbsolute(value.clonePath) || typeof value.stateDirectory!=='string' || !isAbsolute(value.stateDirectory) || !Number.isSafeInteger(value.expectedIssue) || value.expectedIssue<=0) throw new Error('invalid_dispatch');
  if(value.reviewPolicy!==undefined && !['manual','local-automatic'].includes(value.reviewPolicy))throw new Error('invalid_dispatch');
  if (value.approval !== undefined) {
    if (!value.approval || Object.keys(value.approval).length !== 3 || typeof value.approval.repositoryId !== 'string' || value.approval.repo !== value.repo || !Array.isArray(value.approval.grants) || value.approval.grants.length > 256) throw new Error('invalid_dispatch');
    for (const raw of value.approval.grants) { const grant = parseGrant(raw); if (grant.repositoryId !== value.approval.repositoryId || grant.repo !== value.repo || grant.issue !== value.expectedIssue) throw new Error('invalid_dispatch'); }
  }
  return value;
}
export function projectOutcome(state,expectedIssue) {
  if(!state || state.version!==1 || !['idle','running','quota-wait','needs-human','failed'].includes(state.status) || typeof state.paused!=='boolean')throw new Error('invalid_outcome');
  return {version:1,issue:expectedIssue,status:state.status,paused:state.paused,currentIssue:state.current?.number??null,nextRetryAt:Number.isFinite(state.nextRetryAt)?state.nextRetryAt:null};
}
