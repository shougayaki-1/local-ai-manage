// Resolve the same trusted artifact in source and compiled CLI layouts.
const policy = await import(new URL(import.meta.url.endsWith('.ts') ? '../engine/care-record/lib/human-approval.mjs' : '../../engine/care-record/lib/human-approval.mjs', import.meta.url).href) as typeof import('../engine/care-record/lib/human-approval.mjs');
export const { localProbeEligible, automaticReason, automaticReviewEligible, operationalReasons, recoveryState, parseReviewBinding, parseReevaluation, parseRecovery, approvableReasons, e2eSpecs, e2eProjects, parseGrant, parseE2e, pendingReasons, guardReasons, approvalStatus, issueBinding, diffBinding, changedFiles, protectedReasons } = policy;
export type { Reevaluation, Grant, Binding, E2eScope } from '../engine/care-record/lib/human-approval.mjs';
