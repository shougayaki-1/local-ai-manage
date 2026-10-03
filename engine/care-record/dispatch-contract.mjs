import { profileIds } from './profiles.mjs';
import { isAbsolute } from 'node:path';
export function parseDispatchDescriptor(value) {
  const keys=['version','profile','repo','clonePath','stateDirectory','expectedIssue'];
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==keys.length || !keys.every(key=>Object.hasOwn(value,key)) || value.version!==1 || !profileIds.includes(value.profile) || typeof value.repo!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value.repo) || typeof value.clonePath!=='string' || !isAbsolute(value.clonePath) || typeof value.stateDirectory!=='string' || !isAbsolute(value.stateDirectory) || !Number.isSafeInteger(value.expectedIssue) || value.expectedIssue<=0) throw new Error('invalid_dispatch');
  return value;
}
export function projectOutcome(state,expectedIssue) {
  if(!state || state.version!==1 || !['idle','running','quota-wait','needs-human','failed'].includes(state.status) || typeof state.paused!=='boolean')throw new Error('invalid_outcome');
  return {version:1,issue:expectedIssue,status:state.status,paused:state.paused,currentIssue:state.current?.number??null,nextRetryAt:Number.isFinite(state.nextRetryAt)?state.nextRetryAt:null};
}
