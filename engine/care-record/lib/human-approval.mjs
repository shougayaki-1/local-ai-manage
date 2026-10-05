import {parseCanonicalBinding} from './canonical-spec.mjs';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { reasonCategories } from './failure.mjs';
import { managerProtected } from '../profiles.mjs';

// Only these review gates are grantable. Production/credentials/deployment,
// destructive operations and worktree/sandbox safety are never grants.
export const operationalReasons = Object.freeze(['local_verification', 'sandbox_capability', 'verification_retry_limit']);
export const approvableReasons = Object.freeze(['db', 'auth', 'permission', 'tenant', 'security', 'retention', 'manual_e2e']);
export const e2eSpecs = Object.freeze(['auth', 'workspace-routing', 'staff-features', 'tenant-isolation', 'admin-features', 'integration-flow', 'recovery', 'record-feed', 'record-routing', 'record-ui', 'password-recovery']);
export const e2eProjects = Object.freeze(['chromium', 'mobile-chrome']);
export const digest = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const commit = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
export function parseE2e(value) {
  if (!exact(value, ['specs', 'projects']) || !Array.isArray(value.specs) || !value.specs.length || value.specs.length > e2eSpecs.length
    || !Array.isArray(value.projects) || !value.projects.length || value.projects.length > e2eProjects.length
    || value.specs.some(item => !e2eSpecs.includes(item)) || value.projects.some(item => !e2eProjects.includes(item))
    || new Set(value.specs).size !== value.specs.length || new Set(value.projects).size !== value.projects.length) throw new Error('invalid_e2e_scope');
  return { specs: [...value.specs].sort(), projects: [...value.projects].sort() };
}
export function parseBinding(value) {
  if (exact(value, ['kind', 'issueDigest']) && value.kind === 'issue' && hash(value.issueDigest)) return { ...value };
  if (exact(value, ['kind', 'base', 'head', 'diffDigest']) && value.kind === 'diff' && commit(value.base) && commit(value.head) && hash(value.diffDigest)) return { ...value };
  throw new Error('invalid_approval_binding');
}
export function parseGrant(value) {
  if (!exact(value, ['repositoryId', 'repo', 'issue', 'reason', 'binding', 'approvedAt', 'e2e'])
    || typeof value.repositoryId !== 'string' || !/^[a-z0-9_.-]+--[a-z0-9_.-]+$/.test(value.repositoryId)
    || typeof value.repo !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value.repo)
    || !Number.isSafeInteger(value.issue) || value.issue <= 0 || !approvableReasons.includes(value.reason)
    || !Number.isSafeInteger(value.approvedAt) || value.approvedAt < 0 || value.approvedAt > 8.64e15) throw new Error('invalid_approval');
  const binding = parseBinding(value.binding);
  if ((value.reason === 'manual_e2e') !== (binding.kind === 'issue') || (value.reason !== 'manual_e2e' && value.e2e !== null)) throw new Error('invalid_approval');
  return { ...value, binding, e2e: value.reason === 'manual_e2e' ? parseE2e(value.e2e) : null };
}
export function pendingReasons(current) {
  return [...new Set([...(current?.humanReasons ?? []), current?.preflight?.category, current?.repair?.category, ...(current?.result?.reasons ?? []).map(item => item.category)]
    .filter(reason => reasonCategories.includes(reason)))];
}
export function guardReasons(changed, profile = 'care-record-v1', patch = '') {
  const found = new Set();
  if (profile === 'local-ai-manage-v1' && managerProtected(changed)) found.add('security');
  for (const line of changed) {
    if (/\s+(?:supabase\/migrations\/|src\/utils\/permissions\.ts)/.test(line)) found.add('db');
    if (/\s+src\/utils\/permissions\.ts/.test(line)) found.add('permission');
    if (/\s+src\/(?:app\/auth\/|components\/auth\/|utils\/supabase\/|utils\/.*[Aa]uth|proxy\.ts)/.test(line)) found.add('auth');
    if (/\s+src\/utils\/.*[Pp]ermission/.test(line)) found.add('permission');
    if (/\s+src\/utils\/.*[Tt]enant/.test(line)) found.add('tenant');
    if (/\s+src\/utils\/.*[Rr]etention/.test(line)) found.add('retention');
    if (/\s+(?:scripts\/(?:db|e2e)\/|supabase\/)/.test(line)) found.add('security');
  }
  if (changed.some(line => /\s+supabase\/migrations\//.test(line))) {
    if (/row\s+level\s+security|(?:create|alter|drop)\s+policy/i.test(patch)) found.add('permission');
    if (/tenant[_-]?id|tenant boundary/i.test(patch)) found.add('tenant');
  }
  return [...found];
}
export class HumanApprovalError extends Error {
  constructor(reasons, status = 'missing') {
    super('Change requires human verification and a matching approval'); this.reasons = reasons; this.reason = 'human_approval_required'; this.approvalStatus = status;
  }
}
export function approvalStatus(grants, repositoryId, repo, issue, reason, binding) {
  const grant = grants.find(item => item.repositoryId === repositoryId && item.repo === repo && item.issue === issue && item.reason === reason);
  if (!grant) return 'missing';
  return JSON.stringify(grant.binding) === JSON.stringify(binding) ? 'approved' : 'stale';
}
export function requireApprovals(grants, repositoryId, repo, issue, reasons, bindings) {
  const denied = reasons.filter(reason => !approvableReasons.includes(reason) || approvalStatus(grants, repositoryId, repo, issue, reason, reason === 'manual_e2e' ? bindings.issue : bindings.diff) !== 'approved');
  if (denied.length) throw new HumanApprovalError(denied, denied.some(reason => approvalStatus(grants, repositoryId, repo, issue, reason, reason === 'manual_e2e' ? bindings.issue : bindings.diff) === 'stale') ? 'stale' : 'missing');
}
export const issueBinding = issue => ({ kind: 'issue', issueDigest: digest(issue.body ?? '') });

// Hash effective content against the saved base, including binary and untracked
// bytes. No external diff/textconv, raw content, filenames or paths are persisted.
export async function diffBinding(current, execute) {
  if (!commit(current.base) || await realpath(current.worktree) !== current.worktree) throw new HumanApprovalError(['worktree_safety']);
  const git = args => execute('git', args, { cwd: current.worktree });
  const head = await git(['rev-parse', 'HEAD']);
  if (!commit(head) || await git(['branch', '--show-current']) !== current.branch
    || await git(['merge-base', 'HEAD', current.base]) !== current.base) throw new HumanApprovalError(['worktree_safety']);
  const raw = (await git(['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', current.base, '--'])).split('\0').filter(Boolean);
  if (raw.length % 2) throw new HumanApprovalError(['worktree_safety']);
  const entries = [];
  for (let i = 0; i < raw.length; i += 2) entries.push([raw[i + 1], raw[i]]);
  entries.push(...(await git(['ls-files', '-z', '--others', '--exclude-standard'])).split('\0').filter(Boolean).map(name => [name, 'A']));
  entries.sort((a, b) => a[0].localeCompare(b[0], 'en'));
  if (entries.length > 4096) throw new HumanApprovalError(['worktree_safety']);
  const hasher = createHash('sha256'); let total = 0;
  for (const [name, status] of entries) {
    if (/(?:^|\/)(?:\.env(?!\.example$)|auth\.json$|.*\.pem$)/.test(name)) throw new HumanApprovalError(['credential']);
    hasher.update(JSON.stringify([name, status]));
    if (status === 'D') continue;
    const path = resolve(current.worktree, name);
    if (!path.startsWith(current.worktree + sep) || await realpath(path) !== path) throw new HumanApprovalError(['worktree_safety']);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1_048_576 || (total += stat.size) > 20_000_000) throw new HumanApprovalError(['worktree_safety']);
      const buffer = Buffer.alloc(1_048_577); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 1_048_576) throw new HumanApprovalError(['worktree_safety']);
      hasher.update(JSON.stringify(stat.mode & 0o111)).update(digest(buffer.subarray(0, bytesRead)));
    } finally { await file.close(); }
  }
  if (head !== await git(['rev-parse', 'HEAD'])) throw new HumanApprovalError(['worktree_safety']);
  return { kind: 'diff', base: current.base, head, diffDigest: hasher.digest('hex') };
}
export async function changedFiles(current, execute) {
  const git = args => execute('git', args, { cwd: current.worktree });
  const raw = await git(['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', current.base]);
  const changed = [];
  if (raw.includes('\0')) {
    const parts = raw.split('\0').filter(Boolean);
    if (parts.length % 2) throw new HumanApprovalError(['worktree_safety']);
    for (let i = 0; i < parts.length; i += 2) changed.push(`${parts[i]}\t${parts[i + 1]}`);
  } else {
    // Synthetic command adapters may use the text representation.
    changed.push(...raw.split('\n').filter(Boolean));
  }
  return [...changed,
    ...(await git(['ls-files', '-z', '--others', '--exclude-standard'])).split('\0').filter(Boolean).map(path => `A\t${path}`)];
}
export async function protectedReasons(current, execute, profile) {
  const changed = await changedFiles(current, execute);
  // Include untracked migrations in the RLS/tenant inspection; the diff binding
  // already checks every untracked entry for size, regular file and canonical path.
  let patch = await execute('git', ['diff', '--no-ext-diff', '--no-textconv', current.base, '--'], { cwd: current.worktree });
  for (const line of changed.filter(line => /^A\s+supabase\/migrations\//.test(line))) {
    const path = line.slice(2);
    const target = resolve(current.worktree, path);
    if (/(?:^|\/)(?:\.env(?!\.example$)|auth\.json$|.*\.pem$)/.test(path)) throw new HumanApprovalError(['credential']);
    if (!target.startsWith(current.worktree + sep) || await realpath(target) !== target) throw new HumanApprovalError(['worktree_safety']);
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat(); if (!stat.isFile() || stat.size > 1_048_576) throw new HumanApprovalError(['worktree_safety']);
      const buffer = Buffer.alloc(1_048_577); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 1_048_576) throw new HumanApprovalError(['worktree_safety']);
      patch += buffer.subarray(0, bytesRead).toString();
    } finally { await file.close(); }
  }
  return guardReasons(changed, profile, patch);
}

// Recovery is a verification capability, never a human approval or a command input.
export function recoveryState(current) {
  const reasons = pendingReasons(current);
  if (!reasons.some(reason => operationalReasons.includes(reason))) return null;
  if (current.recoveryStatus === 'investigation') return 'human_investigation_required';
  const supplied = current.result?.reasons ?? [];
  const checks = [...(current.verificationChecks ?? []), ...(current.repair ? [current.repair.check] : []),
    ...supplied.filter(reason => operationalReasons.includes(reason.category)).map(reason => reason.check)];
  if (!current.base || !checks.length || checks.some(check => !['typecheck','lint','test','test:unit','test:ui','build','test:codex-worker','test:ci-scope','diff-check'].includes(check))) return 'human_investigation_required';
  return 'automatic_retry_pending';
}
export function parseRecovery(value) {
  if (!exact(value, ['issue', 'diff'])) throw new Error('invalid_recovery');
  const issue = parseBinding(value.issue), diff = parseBinding(value.diff);
  if (issue.kind !== 'issue' || diff.kind !== 'diff') throw new Error('invalid_recovery');
  return {issue, diff};
}

export function parseReevaluation(value) {
  if (!exact(value, ['requestId','issue','previousIssueDigest','diff',...(Object.hasOwn(value??{},'canonical')?['canonical','previousCanonicalDigest']:[])]) || typeof value.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.requestId) || !hash(value.previousIssueDigest)) throw new Error('invalid_reevaluation');
  const issue=parseBinding(value.issue), diff=value.diff===null?null:parseBinding(value.diff);
  if(issue.kind!=='issue'||issue.issueDigest===value.previousIssueDigest&&!value.canonical||diff&&diff.kind!=='diff')throw new Error('invalid_reevaluation');
  if(value.canonical){const binding=parseCanonicalBinding(value.canonical);if(!hash(value.previousCanonicalDigest)||binding.digest===value.previousCanonicalDigest)throw new Error('invalid_reevaluation');}
  return {...value,issue,diff};
}

export function parseReviewBinding(value) {
  if (!exact(value,['issue','diff',...(Object.hasOwn(value??{},'canonical')?['canonical']:[])])) throw new Error('invalid_review_binding');
  const issue=parseBinding(value.issue),diff=value.diff===null?null:parseBinding(value.diff);
  if(issue.kind!=='issue'||diff&&diff.kind!=='diff')throw new Error('invalid_review_binding');
  return {issue,diff,...(value.canonical?{canonical:parseCanonicalBinding(value.canonical)}:{})};
}
// Trusted opt-in policy; never selected from Issue text or worker output.
export const automaticReviewReasons=Object.freeze([...approvableReasons]);
export const automaticReviewEligible=reasons=>Array.isArray(reasons)&&reasons.length>0&&reasons.every(reason=>automaticReviewReasons.includes(reason));
export const automaticReason=(policy,profile,reason)=>policy==='local-automatic'&&profile==='care-record-v1'&&automaticReviewReasons.includes(reason);
