import { readSuppressedDeployment, branchSuppressionOnly, PublicationSafetyError } from './lib/publication.mjs';
import { assertProfileId, assertManagerCheck, ProfileBindingError } from './profiles.mjs';
import { operationalReasons, recoveryState, parseRecovery, parseGrant, pendingReasons, changedFiles, protectedReasons, issueBinding, diffBinding, requireApprovals, HumanApprovalError } from './lib/human-approval.mjs';
import { runApprovedE2e, assertE2ePlan } from './lib/approved-e2e.mjs';
import { assertProfile } from './profile.mjs';
import { homedir } from 'node:os';
import { resolve, join, relative, isAbsolute, dirname, basename, sep } from 'node:path';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { command } from './lib/process.mjs';
import { ensureWorktree, WorktreeSafetyError } from './lib/worktree.mjs';
import { verificationTests, assertLocalCheck } from './lib/verification.mjs';
import { VerificationFailure } from './lib/failure.mjs';
import { preflightReason } from './lib/preflight.mjs';
import { GitHub } from './lib/github.mjs';
import { branchName, disposition, labels, metadata, selectIssue } from './lib/queue.mjs';
import { loadState, lockState, saveJson } from './lib/state.mjs';
import { codexArgs, nextQuotaRetry, resultSchema, runCodex, validateResult } from './lib/codex-runner.mjs';

export function configuration(env = process.env) {
  const number = (key, fallback, minimum = 1) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${key}`);
    return value;
  };
  return {
    stateDir: resolve(env.CODEX_WORKER_STATE_DIR ?? join(homedir(), '.local/state/care-record-codex-worker')),
    repo: env.CODEX_WORKER_REPO,
    maxRunMs: number('CODEX_WORKER_MAX_RUN_MINUTES', 0, 0) * 60_000,
    maxRetries: number('CODEX_WORKER_MAX_RETRIES', 1, 0),
    quotaBackoffMs: number('CODEX_WORKER_QUOTA_BACKOFF_MINUTES', 15) * 60_000,
    quotaMaxBackoffMs: number('CODEX_WORKER_QUOTA_MAX_BACKOFF_MINUTES', 1440) * 60_000,
    weeklyBackoffMs: number('CODEX_WORKER_WEEKLY_BACKOFF_MINUTES', 720) * 60_000,
    pollMs: number('CODEX_WORKER_POLL_SECONDS', 60) * 1000,
    stopOnFailure: env.CODEX_WORKER_STOP_ON_FAILURE === 'true',
  };
}

export function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

async function canonicalPath(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}

export async function verify(current, execute, profile='care-record-v1', approval, verificationIssue = null) {
  assertProfileId(profile);
  await ensureWorktree(current, current.worktree, execute);
  const run = args => execute('git', args, { cwd: current.worktree });
  const beforeHead = await run(['rev-parse', 'HEAD']);
  if (await run(['branch', '--show-current']) !== current.branch) throw new WorktreeSafetyError('worktree_branch_mismatch');
  const beforeChecks = await run(['status', '--porcelain']);
  const verificationBinding = verificationIssue ? await diffBinding(current, execute) : null;
  const changed = await changedFiles(current, execute);
  if (!changed.length) throw new Error('No implementation changes');
  if (changed.some(line => /^(?!A\s)\S+\s+supabase\/migrations\//.test(line) || /\s+supabase\/migrations\/old\//.test(line) || /\s+(?:.*\/)?(?:\.env(?!\.example$)|auth\.json|WORKER-PROGRESS\.md|.*\.pem$)/.test(line))) throw new Error('Protected file changed');
  const humanReasons = [...new Set([...await protectedReasons(current, execute, profile), ...pendingReasons(current).filter(reason => !operationalReasons.includes(reason))])];
  let approvedDiff;
  if (humanReasons.length) {
    if (!approval) throw new HumanApprovalError(humanReasons);
    approvedDiff = await diffBinding(current, execute);
    requireApprovals(approval.grants, approval.repositoryId, approval.repo, current.number, humanReasons, { issue: issueBinding(await approval.issue()), diff: approvedDiff });
  }
  const deploymentConfig=profile==='care-record-v1'?await readSuppressedDeployment(current.worktree,current.branch):null;
  if(changed.some(line=>/\s+vercel\.json$/.test(line))){if(profile!=='care-record-v1'||!branchSuppressionOnly(JSON.parse(await run(['show',`${current.base}:vercel.json`])),deploymentConfig,current.branch))throw new Error('Deployment configuration change requires human verification');}
  let scripts = null;
  try { scripts = JSON.parse(await readFile(join(current.worktree, 'package.json'), 'utf8')).scripts ?? {}; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const delegated = (current.result?.reasons ?? []).filter(reason => operationalReasons.includes(reason.category));
  const tests = [...new Set([
    ...(profile==='care-record-v1'?verificationTests(changed, scripts ?? {}, delegated):['test','build',...delegated.map(reason=>{if(!operationalReasons.includes(reason.category)||!['typecheck','lint','test','build','diff-check'].includes(reason.check))throw new Error('Unsafe handoff reason');return reason.check;}).filter(name=>!['typecheck','lint','diff-check'].includes(name))]),
    ...(current.verificationChecks ?? []).filter(name => !['typecheck', 'lint', 'diff-check'].includes(name)),
  ])];
  const names = ['typecheck', 'lint', ...tests];
  // Validate the entire plan before executing any script, including hooks.
  if(profile==='local-ai-manage-v1')await assertProfile(current.worktree,profile);
  for (const name of names) (profile==='care-record-v1'?assertLocalCheck:assertManagerCheck)(scripts, name);
  const e2e = humanReasons.includes('manual_e2e') ? approval.grants.find(grant => grant.issue === current.number && grant.reason === 'manual_e2e')?.e2e : null;
  if (e2e) await assertE2ePlan(current.worktree, scripts, profile, e2e);
  // A repaired Codex result must not drop checks delegated by an earlier result.
  current.verificationChecks = [...names, 'diff-check'];
  for (const name of names) {
    try {
      await execute('npm', ['run', name, ...(name === 'lint' ? ['--', '--max-warnings=0'] : [])], { cwd: current.worktree, timeout: 600_000, testMode: true });
    } catch (error) {
      if (beforeHead !== await run(['rev-parse', 'HEAD']) || beforeChecks !== await run(['status', '--porcelain'])) throw new WorktreeSafetyError('verification_changed_worktree');
      if (verificationBinding && JSON.stringify(verificationBinding) !== JSON.stringify(await diffBinding(current, execute))) throw new WorktreeSafetyError('verification_changed_worktree');
      throw new VerificationFailure(name, error);
    }
  }
  if (e2e) {
    requireApprovals(approval.grants, approval.repositoryId, approval.repo, current.number, humanReasons, { issue: issueBinding(await approval.issue()), diff: await diffBinding(current, execute) });
    await runApprovedE2e(current, scripts, profile, e2e, execute);
  }
  try { await run(['diff', '--check', current.base]); }
  catch (error) { throw new VerificationFailure('diff-check', error); }
  const afterChecks = await run(['status', '--porcelain']);
  if (beforeHead !== await run(['rev-parse', 'HEAD']) || beforeChecks !== afterChecks) throw new Error('Verification changed worktree files');
  if(profile==='care-record-v1'&&JSON.stringify(await readSuppressedDeployment(current.worktree,current.branch))!==JSON.stringify(deploymentConfig))throw new PublicationSafetyError();
  if (approvedDiff) {
    requireApprovals(approval.grants, approval.repositoryId, approval.repo, current.number, humanReasons, { issue: issueBinding(await approval.issue()), diff: await diffBinding(current, execute) });
  }
  if (verificationBinding && JSON.stringify(verificationBinding) !== JSON.stringify(await diffBinding(current, execute))) throw new WorktreeSafetyError('verification_changed_worktree');
  if (verificationIssue && JSON.stringify(verificationIssue) !== JSON.stringify(issueBinding(await approval.issue()))) throw new WorktreeSafetyError('verification_issue_changed');
  if (afterChecks) {
    await run(['add', '--all', '--', '.']);
    await run(['commit', '-m', `Implement issue #${current.number}`]);
  }
  if (Number(await run(['rev-list', '--count', `${current.base}..HEAD`])) < 1) throw new Error('No implementation commit');
  if (await run(['status', '--porcelain'])) throw new Error('Verification changed tracked files');
  const verified = ['npm run typecheck', 'npm run lint -- --max-warnings=0', ...tests.map(name => `npm run ${name}`), ...(e2e ? ['approved local E2E (retries=0)'] : []), 'git diff --check'];
  if (approvedDiff) {
    const after = await diffBinding(current, execute);
    // The parent's own commit may change HEAD, but may not change reviewed bytes.
    if (after.base !== approvedDiff.base || after.diffDigest !== approvedDiff.diffDigest) throw new HumanApprovalError(humanReasons, 'stale');
    verified.approvalBinding = after; verified.humanReasons = humanReasons;
  }
  if (verificationIssue) verified.recoveryBinding = await diffBinding(current, execute);
  return verified;
}

export async function worker({ config, mode = 'normal', resume = false, expectedIssue, continueAfterHuman = false, approval, recovery, root = process.cwd(), execute = command, run = runCodex, now = Date.now, wait = sleep, signal, report = console.log, telemetry, profile='care-record-v1' }) {
  assertProfileId(profile);
  if (expectedIssue !== undefined && (!Number.isSafeInteger(expectedIssue) || expectedIssue <= 0 || mode !== 'once' || resume)) throw new Error('Invalid bounded dispatch');
  if (continueAfterHuman && (expectedIssue === undefined || mode !== 'once' || resume)) throw new Error('Continuation requires bounded dispatch');
  if (approval) {
    if (expectedIssue === undefined || mode !== 'once' || resume || !Array.isArray(approval.grants) || approval.grants.length > 256) throw new Error('Invalid approval dispatch');
    approval = { repositoryId: approval.repositoryId, repo: approval.repo, grants: approval.grants.map(parseGrant) };
    if (approval.grants.some(grant => grant.repositoryId !== approval.repositoryId || grant.repo !== approval.repo || grant.issue !== expectedIssue)) throw new Error('Invalid approval scope');
  }
  if (recovery) {
    if (expectedIssue === undefined || mode !== 'once' || resume) throw new Error('Invalid recovery dispatch');
    recovery = parseRecovery(recovery);
  }
  const originalExecute = execute;
  execute = (binary, args, options) => originalExecute(binary, args, { ...options, signal });
  config = { ...config, stateDir: await canonicalPath(config.stateDir) };
  if (mode === 'status') {
    const state = await loadState(config.stateDir);
    report(JSON.stringify({ status: state.status, paused: state.paused, issue: state.current?.number ?? null, branch: state.current?.branch ?? null,
      worktree: state.current?.worktree ?? null, lastReason: state.lastReason, quotaWaitStarted: state.quotaWaitStarted,
      nextRetryAt: state.nextRetryAt, failures: state.current?.failures ?? 0, remainingWork: state.current?.progress ?? state.current?.result?.remaining_work ?? null }, null, 2));
    return state;
  }
  root = await realpath(root);
  const local = relative(root, config.stateDir);
  if (local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)) throw new Error('State directory must be outside the repository');
  const remote = await execute('git', ['remote', 'get-url', 'origin'], { cwd: root });
  const repo = remote.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/)?.[1];
  if (!repo || (config.repo && config.repo !== repo)) throw new Error('Origin must match the configured GitHub repository');
  if (approval && approval.repo !== repo) throw new Error('Invalid approval repository');
  const github = new GitHub(repo, execute);
  if (approval) approval.issue = () => github.issue(expectedIssue);
  let state = await loadState(config.stateDir);
  if (state.repo && state.repo !== repo) throw new Error('Saved state belongs to another repository');
  const persist = async () => { await saveJson(join(config.stateDir, 'state.json'), state); await telemetry?.update(state); };
  if (mode === 'dry-run') {
    const snapshot = await github.snapshot();
    const issue = state.current ? await github.issue(state.current.number) : selectIssue(snapshot.issues, snapshot.dependencies, new Set([...snapshot.linked, ...(state.humanWaiting ?? []).map(entry => entry.current.number)]));
    const current = state.current ?? (issue ? { number: issue.number, branch: branchName(issue), worktree: join(config.stateDir, 'worktrees', `issue-${issue.number}`) } : null);
    const preflight = issue ? preflightReason(issue.body) : null;
    report(JSON.stringify({ mode, issue: issue?.number ?? null, dependencies: issue ? metadataForReport(issue) : [], branch: current?.branch ?? null, status: state.status, nextRetryAt: state.nextRetryAt, paused: state.paused, preflight,
      commands: current && !preflight ? [['git', 'fetch', 'origin', 'main'], ['git', 'worktree', 'add', '-b', current.branch, current.worktree, 'origin/main'], ['npm', 'ci'], ['codex', ...codexArgs(current, join(config.stateDir, 'result.schema.json'))], ['git', 'push', 'origin', current.branch], ['gh', 'pr', 'create', '--draft']] : [] }, null, 2));
    return state;
  }
  let resumePending = resume;
  const unlock = await lockState(config.stateDir);
  try {
    // Reload after obtaining the lock; another process may have just completed.
    state = await loadState(config.stateDir);
    if (state.repo && state.repo !== repo) throw new Error('Saved state belongs to another repository');
    if(state.profile!==undefined&&state.profile!==profile)throw new ProfileBindingError('Saved worker profile mismatch');
    if(profile!=='care-record-v1'&&state.current&&state.profile===undefined)throw new ProfileBindingError('Saved work requires a reviewed profile binding');
    if(profile!=='care-record-v1')state.profile=profile;
    const waitingNumbers = new Set((state.humanWaiting ?? []).map(entry => entry.current.number));
    const approvalResume = (!!approval?.grants.length || !!recovery) && (state.status === 'needs-human' && state.paused && state.current?.number === expectedIssue
      || waitingNumbers.has(expectedIssue) && !state.current && state.status === 'idle' && state.paused === false && state.nextRetryAt === null);
    if (approvalResume && waitingNumbers.has(expectedIssue)) {
      if (state.current) return state; // Preserve active work; do not overwrite it.
      const entry = state.humanWaiting.find(item => item.current.number === expectedIssue);
      state.current = entry.current; state.status = 'needs-human'; state.paused = true; state.lastReason = entry.reason;
      state.humanWaiting = state.humanWaiting.filter(item => item !== entry);
    }
    // Park only a confirmed issue-level human stop, inside the existing worker lock.
    // A quota wait, manual pause, failed state or an unknown worktree is never cleared.
    const parking = continueAfterHuman && state.status === 'needs-human' && state.paused === true
      && state.current && state.current.number !== expectedIssue && state.nextRetryAt === null
      && ['prepare', 'implement', 'publish'].includes(state.current.stage);
    if (waitingNumbers.has(expectedIssue) && !approvalResume) return state;
    if (!parking && expectedIssue !== undefined && state.current && state.current.number !== expectedIssue) return state;
    if (!parking && !approvalResume && expectedIssue !== undefined && ['needs-human','failed'].includes(state.status)) return state;
    if (state.paused && !resume && !parking && !approvalResume) { report('Worker paused. Review state and use --resume.'); return state; }
    if (parking) {
      const snapshot = await github.snapshot();
      const excluded = new Set([...snapshot.linked, ...waitingNumbers, state.current.number]);
      const selected = selectIssue(snapshot.issues, snapshot.dependencies, excluded);
      if (selected?.number !== expectedIssue || (state.humanWaiting?.length ?? 0) >= 256) return state;
      const fresh = await github.issue(expectedIssue);
      const rechecked = await github.snapshot();
      const linked = new Set([...rechecked.linked, ...waitingNumbers, state.current.number]);
      if (selectIssue(rechecked.issues, rechecked.dependencies, linked)?.number !== expectedIssue
        || !selectIssue([fresh], rechecked.dependencies, linked)) return state;
      // Ensure GitHub also excludes the old issue before releasing its active slot.
      await github.mark(state.current.number, 'needs_human');
      state.humanWaiting = [...(state.humanWaiting ?? []), {current: state.current, reason: state.lastReason ?? 'needs_human', since: now()}];
      state.current = null; state.status = 'idle'; state.paused = false; state.lastReason = null;
      await persist();
    }
    state.repo = repo;
    await telemetry?.update(state);
    // Resume only clears the pause after worktree safety is proven.
    if (resume && !state.current) { state.paused = false; await persist(); }
    let canResumeSession;
    let recoveryValidated = false;
    await execute('gh', ['auth', 'status'], { purpose: 'github' });
    if (expectedIssue === undefined) await saveJson(join(config.stateDir, 'result.schema.json'), resultSchema);
    while (!signal?.aborted) {
      if (state.nextRetryAt !== null && now() < state.nextRetryAt) {
        if (mode === 'once') return state;
        await wait(Math.min(60_000, state.nextRetryAt - now()), signal);
        continue;
      }
      if (!state.current) {
        const snapshot = await github.snapshot();
        const issue = selectIssue(snapshot.issues, snapshot.dependencies, new Set([...snapshot.linked, ...(state.humanWaiting ?? []).map(entry => entry.current.number)]));
        if (expectedIssue !== undefined && issue?.number !== expectedIssue) return state;
        if (!issue) { state.status = 'idle'; await persist(); if (mode === 'once') return state; await wait(config.pollMs, signal); continue; }
        // Recheck before claiming; run only one worker per repository (documented).
        const fresh = await github.issue(issue.number);
        // Bounded dispatch uses fresh dependencies and PR associations as well as fresh Issue labels.
        const rechecked = expectedIssue === undefined ? snapshot : await github.snapshot();
        if ((expectedIssue !== undefined && selectIssue(rechecked.issues, rechecked.dependencies, new Set([...rechecked.linked, ...(state.humanWaiting ?? []).map(entry => entry.current.number)]))?.number !== expectedIssue) || !selectIssue([fresh], rechecked.dependencies, new Set([...rechecked.linked, ...(state.humanWaiting ?? []).map(entry => entry.current.number)]))) { if (mode === 'once') return state; await wait(config.pollMs, signal); continue; }
        state.current = { number: issue.number, branch: branchName(issue), worktree: join(config.stateDir, 'worktrees', `issue-${issue.number}`), failures: 0, quotaWaits: 0, stage: 'prepare', session: null };
        await persist();
      }
      const current = state.current;
      if (resolve(current.worktree) !== join(config.stateDir, 'worktrees', `issue-${current.number}`)) throw new Error('Unexpected worktree path in state');
      const issue = await github.issue(current.number);
      if (approvalResume) {
        const snapshot = await github.snapshot();
        for (const dependency of metadata(issue.body).dependencies) snapshot.dependencies.set(dependency, (await github.issue(dependency)).state);
        const timeline = JSON.parse(await github.gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${current.number}/timeline?per_page=100`]));
        if (!Array.isArray(timeline) || timeline.some(page => !Array.isArray(page)) || timeline.flat().some(event => event.source?.issue?.pull_request && event.source.issue.state === 'open')) return state;
        const eligible = { ...issue, labels: [...labels(issue).filter(name => name !== 'codex:needs-human'), 'codex:ready'] };
        if (!selectIssue([eligible], snapshot.dependencies, snapshot.linked)) return state;
        const reasons = [...new Set([...pendingReasons(current), ...(current.base ? await protectedReasons(current, execute, profile) : [])])];
        if (!reasons.length) return state;
        if (recovery && !recoveryValidated && (recoveryState(current) !== 'automatic_retry_pending' || JSON.stringify(recovery.issue) !== JSON.stringify(issueBinding(issue)) || JSON.stringify(recovery.diff) !== JSON.stringify(await diffBinding(current, execute)))) return state;
        if (!recovery && !recoveryValidated && reasons.some(reason => operationalReasons.includes(reason))) return state;
        const bindings = { issue: issueBinding(issue), diff: current.base ? await diffBinding(current, execute) : undefined };
        try { requireApprovals(approval?.grants ?? [], approval?.repositoryId ?? '', repo, current.number, reasons.filter(reason => !operationalReasons.includes(reason)), bindings); }
        catch (error) {
          if (!(error instanceof HumanApprovalError)) throw error;
          current.humanReasons = reasons; current.approvalStatus = error.approvalStatus;
          await persist(); await github.mark(current.number, 'needs_human'); return state;
        }
      }
      const intervention = issue.state !== 'open' || labels(issue).some(n => ['codex:blocked', 'codex:failed', 'codex:needs-human'].includes(n));
      if (intervention && !resume && !approvalResume) { state.paused = true; state.status = 'needs-human'; state.lastReason = 'needs_human'; await persist(); return state; }
      if(typeof issue.body==='string'&&/<!--\s*codex-worker-status\s*-->/.test(issue.body)){state.paused=true;state.status='needs-human';state.lastReason='needs_human';await persist();return state;}
      if (issue.state !== 'open' || labels(issue).includes('codex:blocked')) throw new Error('Current issue is closed or blocked');
      const preflight = preflightReason(issue.body);
      let manualApproved = false;
      if (preflight && approval) {
        try { requireApprovals(approval.grants, approval.repositoryId, repo, current.number, ['manual_e2e'], { issue: issueBinding(issue) }); manualApproved = true; }
        catch (error) { if (!(error instanceof HumanApprovalError)) throw error; current.approvalStatus = error.approvalStatus; }
      }
      if (preflight && !manualApproved) {
        state.paused = true; state.status = 'needs-human'; state.lastReason = preflight;
        const reported = current.preflight?.reason === preflight && current.preflight?.reported === true;
        current.preflight = { category: 'manual_e2e', reason: preflight, reported };
        await persist();
        await github.mark(current.number, 'needs_human');
        if (!reported) {
          await github.gh(['issue', 'comment', String(current.number), '--repo', repo, '--body-file', '-'], {
            input: 'Codex Worker preflight: manual_e2e_required. Issue completion explicitly requires E2E execution. Stopped before worktree preparation and Codex execution; E2E was not run. Human review is required.\n',
          });
          current.preflight.reported = true;
          await persist();
        }
        report(`Issue #${current.number}: E2E execution is required; stopped before worktree/Codex preparation.`);
        return state;
      }
      if (manualApproved) current.preflight = { category: 'manual_e2e', reason: preflight, reported: true };
      if (expectedIssue !== undefined) await saveJson(join(config.stateDir, 'result.schema.json'), resultSchema);
      if (canResumeSession === undefined) {
        const execHelp = await execute('codex', ['exec', '--help'], { purpose: 'codex' });
        let resumeHelp = '';
        try { resumeHelp = await execute('codex', ['exec', 'resume', '--help'], { purpose: 'codex' }); } catch { /* Initial runs may fall back to the same worktree. */ }
        for (const flag of ['--json', '--output-schema']) if (!execHelp.includes(flag)) throw new Error('Codex CLI needs JSON and schema support for exec');
        canResumeSession = ['--json', '--output-schema'].every(flag => resumeHelp.includes(flag));
      }
      current.worktreeCheck = await ensureWorktree(current, root, execute);
      if (approvalResume) state.paused = false;
      if (recovery && !recoveryValidated) { current.stage = 'publish'; recoveryValidated = true; }
      if (resumePending) { state.paused = false; current.failures = 0; resumePending = false; }
      await persist();
      if (intervention) await github.gh(['issue', 'edit', String(current.number), '--repo', repo, '--remove-label', 'codex:failed', '--remove-label', 'codex:needs-human']);
      await github.mark(current.number, 'running');
      if (current.stage === 'prepare') {
        if(profile!=='care-record-v1')await assertProfile(current.worktree,profile);
        await execute('npm', ['ci'], { cwd: current.worktree, timeout: 600_000 });
        current.stage = 'implement';
        await persist();
      }
      if (current.stage !== 'publish') {
        if (signal?.aborted) break;
        state.status = 'running';
        state.nextRetryAt = null;
        state.lastReason = 'running';
        await persist();
        const runDir = join(config.stateDir, 'runs', `${current.number}-${now()}`);
        await mkdir(runDir, { recursive: true, mode: 0o700 });
        current.lastRun = runDir;
        if (!canResumeSession && current.repair && current.session) throw new WorktreeSafetyError('repair_session_resume_unavailable');
        if (!canResumeSession && expectedIssue !== undefined && current.session) throw new WorktreeSafetyError('repair_session_resume_unavailable');
        if (!canResumeSession) current.session = null;
        await persist();
        const outcome = await run({ current, issue, profile, schemaPath: join(config.stateDir, 'result.schema.json'), tracePath: join(runDir, 'trace.jsonl'), stderrPath: join(runDir, 'stderr.log'), signal, maxRunMs: config.maxRunMs,
          onLaunch: () => telemetry?.launched(),
          onSession: async session => {
            if (current.repair && current.session && current.session !== session) throw new WorktreeSafetyError('repair_session_mismatch');
            current.session = session; await persist();
          } });
        if (outcome.safetyReason === 'repair_session_mismatch') throw new WorktreeSafetyError(outcome.safetyReason);
        outcome.result = validateResult(outcome.result);
        if (outcome.result) {
          await saveJson(join(runDir, 'result.json'), outcome.result);
          current.progress = outcome.result.remaining_work;
          current.result = outcome.result;
        }
        let status = disposition(outcome, current.failures, config);
        if (status === 'needs_human' && approval && !outcome.needsHuman && outcome.code === 0 && !outcome.quota && !outcome.interrupted
          && outcome.result?.reasons?.length && outcome.result.reasons.every(reason => [...operationalReasons,'db','auth','permission','tenant','security','retention','manual_e2e'].includes(reason.category))) {
          try {
            requireApprovals(approval.grants, approval.repositoryId, repo, current.number, outcome.result.reasons.map(reason => reason.category).filter(reason=>!operationalReasons.includes(reason)), { issue: issueBinding(await github.issue(current.number)), diff: await diffBinding(current, execute) });
            status = 'completed';
          } catch (error) { if (!(error instanceof HumanApprovalError)) throw error; current.approvalStatus = error.approvalStatus; }
        }
        state.lastReason = status;
        if (status === 'completed') { current.result = outcome.result; current.stage = 'publish'; }
        else if (status === 'quota_wait') {
          state.status = 'quota-wait';
          state.quotaWaitStarted = now();
          state.nextRetryAt = nextQuotaRetry(outcome, current.quotaWaits, config, now());
          current.quotaWaits++;
          await persist();
          if (mode === 'once' || signal?.aborted) return state;
          continue;
        } else if (status === 'paused') {
          state.paused = !signal?.aborted;
          state.lastReason = signal?.aborted ? 'stopped' : 'paused';
          await persist();
          return state;
        } else if (status === 'retry') { current.failures++; await persist(); await wait(config.pollMs, signal); continue; }
        else {
          await github.mark(current.number, status);
          state.paused = status === 'needs_human' || config.stopOnFailure;
          state.status = status.replace('_', '-');
          await saveJson(join(config.stateDir, `issue-${current.number}.json`), current);
          if (!state.paused) state.current = null;
          await persist();
          if (state.paused || mode === 'once') return state;
          continue;
        }
        await persist();
      }
      let verified;
      try { verified = await verify(current, execute, profile, approval ?? {repositoryId:'',repo,grants:[],issue:()=>github.issue(current.number)}, recoveryValidated ? recovery.issue : null); }
      catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof VerificationFailure && error.retryable && current.failures < config.maxRetries) {
          current.failures++;
          current.repair = error.diagnostic;
          current.stage = 'implement';
          state.lastReason = 'parent_verification_retry';
          await persist();
          report(`Issue #${current.number}: ${error.diagnostic.check} failed; returning to Codex for repair ${current.failures}/${config.maxRetries}.`);
          continue;
        }
        if (error instanceof VerificationFailure || recoveryValidated && !(error instanceof HumanApprovalError)) current.recoveryStatus = 'investigation';
        state.paused = true; state.status = 'needs-human';
        state.lastReason = error instanceof WorktreeSafetyError || error instanceof PublicationSafetyError ? error.reason : error instanceof VerificationFailure
          ? error.retryable ? 'verification_retry_exhausted' : 'unsafe_or_unavailable_verification' : 'parent_verification_safety_failed';
        if (error instanceof VerificationFailure) { current.humanReasons = [...new Set([...pendingReasons(current), 'local_verification', ...(error.retryable ? ['verification_retry_limit'] : [])])]; if (error.retryable) current.repair = error.diagnostic; }
        if (error instanceof WorktreeSafetyError) current.worktreeCheck = error.check;
        if (error instanceof PublicationSafetyError) current.preflight={category:'deploy',reason:error.reason};
        if (error instanceof HumanApprovalError) { current.humanReasons = [...new Set([...pendingReasons(current), ...error.reasons])]; current.approvalStatus = error.approvalStatus; state.lastReason = error.reason; }
        await persist(); await github.mark(current.number, 'needs_human');
        report(`Issue #${current.number}: parent verification needs human review.`);
        return state;
      }
      try {
        if (verified.recoveryBinding) {
          const fresh = await github.issue(current.number);
          if (fresh.state !== 'open' || labels(fresh).some(name=>['codex:blocked','codex:failed','codex:needs-human'].includes(name)) || JSON.stringify(recovery.issue) !== JSON.stringify(issueBinding(fresh)) || JSON.stringify(verified.recoveryBinding) !== JSON.stringify(await diffBinding(current, execute))) throw new WorktreeSafetyError('verification_issue_changed');
        }
        if (verified.approvalBinding) {
          const fresh = await github.issue(current.number);
          if (fresh.state !== 'open' || labels(fresh).includes('codex:blocked')) throw new HumanApprovalError(verified.humanReasons);
          const actual = await diffBinding(current, execute);
          if (JSON.stringify(actual) !== JSON.stringify(verified.approvalBinding)) throw new HumanApprovalError(verified.humanReasons, 'stale');
          requireApprovals(approval.grants, approval.repositoryId, repo, current.number, verified.humanReasons.filter(reason => reason === 'manual_e2e'), { issue: issueBinding(fresh) });
        }
        delete current.repair;
        current.result.status = 'completed';
        current.result.safe_to_open_pr = true;
        current.result.reasons = [];
        current.result.tests = [...new Set([...current.result.tests, ...verified.map(name => `Parent verified: ${name}`)])];
        current.result.unrun_tests += `\nParent verification passed: ${verified.join(', ')}. Any earlier sandbox restriction for these commands is resolved.`;
        if(profile==='care-record-v1')await readSuppressedDeployment(current.worktree,current.branch);
        await execute('git', ['push', 'origin', `${current.branch}:${current.branch}`], { cwd: current.worktree, purpose: 'github' });
        current.pr = await github.draft(current, current.result);
        await persist();
        await github.mark(current.number, 'completed');
        await saveJson(join(config.stateDir, `issue-${current.number}.json`), current);
        state.current = null;
        state.status = 'idle';
        state.quotaWaitStarted = null;
        state.nextRetryAt = null;
        state.lastReason = 'completed';
        await persist();
        report(`Issue #${current.number}: Draft PR ${current.pr}`);
      } catch (error) {
        // Preserve publish stage for idempotent recovery, never rerun Codex blindly.
        state.paused = true;
        state.status = 'needs-human';
        state.lastReason = error instanceof WorktreeSafetyError || error instanceof PublicationSafetyError ? error.reason : 'publication_failed';
        if (error instanceof WorktreeSafetyError) { current.worktreeCheck = error.check; report(`Issue #${current.number}: ${error.message}`); }
        if (error instanceof HumanApprovalError) { current.humanReasons = error.reasons; current.approvalStatus = error.approvalStatus; state.lastReason = error.reason; }
        await persist();
        await github.mark(current.number, 'needs_human');
        report(`Issue #${current.number}: publication needs human review.`);
        return state;
      }
      if (mode === 'once') return state;
    }
    state.lastReason = 'stopped';
    await persist();
    return state;
  } catch (error) {
    if(error instanceof ProfileBindingError)throw error;
    if (signal?.aborted) {
      state.lastReason = 'stopped';
      await persist();
      return state;
    }
    if (state.current) {
      state.status = 'needs-human'; state.paused = true; state.lastReason = error instanceof WorktreeSafetyError ? error.reason : 'operational_error';
      if (error instanceof WorktreeSafetyError) { state.current.worktreeCheck = error.check; report(`Issue #${state.current.number}: ${error.message}`); }
      await persist();
      try { await github.mark(state.current.number, 'needs_human'); } catch { /* Preserve local recovery even if GitHub is unavailable. */ }
    }
    throw error;
  } finally { try { await telemetry?.close(); } finally { await unlock(); } }
}

function metadataForReport(issue) {
  try { return metadata(issue.body).dependencies; } catch { return 'invalid metadata'; }
}
