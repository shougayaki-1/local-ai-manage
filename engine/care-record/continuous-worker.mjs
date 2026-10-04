import { readSuppressedDeployment, branchSuppressionOnly, PublicationSafetyError } from './lib/publication.mjs';
import { assertProfileId, assertManagerCheck, managerProtected, ProfileBindingError } from './profiles.mjs';
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

export async function verify(current, execute, profile='care-record-v1') {
  assertProfileId(profile);
  await ensureWorktree(current, current.worktree, execute);
  const run = args => execute('git', args, { cwd: current.worktree });
  const beforeHead = await run(['rev-parse', 'HEAD']);
  if (await run(['branch', '--show-current']) !== current.branch) throw new WorktreeSafetyError('worktree_branch_mismatch');
  const beforeChecks = await run(['status', '--porcelain']);
  const changed = (await run(['diff', '--name-status', '--no-renames', current.base])).split('\n').filter(Boolean);
  const untracked = (await run(['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
  changed.push(...untracked.map(path => `A\t${path}`));
  if(profile==='local-ai-manage-v1'&&managerProtected(changed))throw new Error('Controller/security change requires human verification');
  if (!changed.length) throw new Error('No implementation changes');
  if (changed.some(line => /^(?!A\s)\S+\s+supabase\/migrations\//.test(line) || /\s+supabase\/migrations\/old\//.test(line) || /\s+(?:.*\/)?(?:\.env(?!\.example$)|auth\.json|WORKER-PROGRESS\.md|.*\.pem$)/.test(line))) throw new Error('Protected file changed');
  // DB/RLS changes never reach test commands or publication automatically.
  if (changed.some(line => /\s+(?:supabase\/migrations\/|src\/utils\/permissions\.ts)/.test(line))) throw new Error('DB/RLS change requires human verification before publishing');
  if (changed.some(line => /\s+(?:src\/(?:app\/auth\/|components\/auth\/|utils\/supabase\/|utils\/.*(?:[Aa]uth|[Pp]ermission|[Tt]enant|[Rr]etention)|proxy\.ts)|scripts\/(?:db|e2e)\/|supabase\/)/.test(line))) throw new Error('Security-sensitive change requires human verification');
  const deploymentConfig=profile==='care-record-v1'?await readSuppressedDeployment(current.worktree,current.branch):null;
  if(changed.some(line=>/\s+vercel\.json$/.test(line))){if(profile!=='care-record-v1'||!branchSuppressionOnly(JSON.parse(await run(['show',`${current.base}:vercel.json`])),deploymentConfig,current.branch))throw new Error('Deployment configuration change requires human verification');}
  let scripts = null;
  try { scripts = JSON.parse(await readFile(join(current.worktree, 'package.json'), 'utf8')).scripts ?? {}; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const tests = [...new Set([
    ...(profile==='care-record-v1'?verificationTests(changed, scripts ?? {}, current.result?.reasons ?? []):['test','build',...(current.result?.reasons??[]).map(reason=>{if(reason.category!=='sandbox_capability'||!['typecheck','lint','test','build','diff-check'].includes(reason.check))throw new Error('Unsafe handoff reason');return reason.check;}).filter(name=>!['typecheck','lint','diff-check'].includes(name))]),
    ...(current.verificationChecks ?? []).filter(name => !['typecheck', 'lint', 'diff-check'].includes(name)),
  ])];
  const names = ['typecheck', 'lint', ...tests];
  // Validate the entire plan before executing any script, including hooks.
  if(profile==='local-ai-manage-v1')await assertProfile(current.worktree,profile);
  for (const name of names) (profile==='care-record-v1'?assertLocalCheck:assertManagerCheck)(scripts, name);
  // A repaired Codex result must not drop checks delegated by an earlier result.
  current.verificationChecks = [...names, 'diff-check'];
  for (const name of names) {
    try {
      await execute('npm', ['run', name, ...(name === 'lint' ? ['--', '--max-warnings=0'] : [])], { cwd: current.worktree, timeout: 600_000, testMode: true });
    } catch (error) {
      if (beforeHead !== await run(['rev-parse', 'HEAD']) || beforeChecks !== await run(['status', '--porcelain'])) throw new WorktreeSafetyError('verification_changed_worktree');
      throw new VerificationFailure(name, error);
    }
  }
  try { await run(['diff', '--check', current.base]); }
  catch (error) { throw new VerificationFailure('diff-check', error); }
  const afterChecks = await run(['status', '--porcelain']);
  if (beforeHead !== await run(['rev-parse', 'HEAD']) || beforeChecks !== afterChecks) throw new Error('Verification changed worktree files');
  if(profile==='care-record-v1'&&JSON.stringify(await readSuppressedDeployment(current.worktree,current.branch))!==JSON.stringify(deploymentConfig))throw new PublicationSafetyError();
  if (afterChecks) {
    await run(['add', '--all', '--', '.']);
    await run(['commit', '-m', `Implement issue #${current.number}`]);
  }
  if (Number(await run(['rev-list', '--count', `${current.base}..HEAD`])) < 1) throw new Error('No implementation commit');
  if (await run(['status', '--porcelain'])) throw new Error('Verification changed tracked files');
  return ['npm run typecheck', 'npm run lint -- --max-warnings=0', ...tests.map(name => `npm run ${name}`), 'git diff --check'];
}

export async function worker({ config, mode = 'normal', resume = false, expectedIssue, root = process.cwd(), execute = command, run = runCodex, now = Date.now, wait = sleep, signal, report = console.log, telemetry, profile='care-record-v1' }) {
  assertProfileId(profile);
  if (expectedIssue !== undefined && (!Number.isSafeInteger(expectedIssue) || expectedIssue <= 0 || mode !== 'once' || resume)) throw new Error('Invalid bounded dispatch');
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
  const github = new GitHub(repo, execute);
  let state = await loadState(config.stateDir);
  if (state.repo && state.repo !== repo) throw new Error('Saved state belongs to another repository');
  const persist = async () => { await saveJson(join(config.stateDir, 'state.json'), state); await telemetry?.update(state); };
  if (mode === 'dry-run') {
    const snapshot = await github.snapshot();
    const issue = state.current ? await github.issue(state.current.number) : selectIssue(snapshot.issues, snapshot.dependencies, snapshot.linked);
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
    if (expectedIssue !== undefined && state.current && state.current.number !== expectedIssue) return state;
    if (expectedIssue !== undefined && ['needs-human','failed'].includes(state.status)) return state;
    state.repo = repo;
    await telemetry?.update(state);
    if (state.paused && !resume) { report('Worker paused. Review state and use --resume.'); return state; }
    // Resume only clears the pause after worktree safety is proven.
    if (resume && !state.current) { state.paused = false; await persist(); }
    let canResumeSession;
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
        const issue = selectIssue(snapshot.issues, snapshot.dependencies, snapshot.linked);
        if (expectedIssue !== undefined && issue?.number !== expectedIssue) return state;
        if (!issue) { state.status = 'idle'; await persist(); if (mode === 'once') return state; await wait(config.pollMs, signal); continue; }
        // Recheck before claiming; run only one worker per repository (documented).
        const fresh = await github.issue(issue.number);
        // Bounded dispatch uses fresh dependencies and PR associations as well as fresh Issue labels.
        const rechecked = expectedIssue === undefined ? snapshot : await github.snapshot();
        if ((expectedIssue !== undefined && selectIssue(rechecked.issues, rechecked.dependencies, rechecked.linked)?.number !== expectedIssue) || !selectIssue([fresh], rechecked.dependencies, rechecked.linked)) { if (mode === 'once') return state; await wait(config.pollMs, signal); continue; }
        state.current = { number: issue.number, branch: branchName(issue), worktree: join(config.stateDir, 'worktrees', `issue-${issue.number}`), failures: 0, quotaWaits: 0, stage: 'prepare', session: null };
        await persist();
      }
      const current = state.current;
      if (resolve(current.worktree) !== join(config.stateDir, 'worktrees', `issue-${current.number}`)) throw new Error('Unexpected worktree path in state');
      const issue = await github.issue(current.number);
      const intervention = issue.state !== 'open' || labels(issue).some(n => ['codex:blocked', 'codex:failed', 'codex:needs-human'].includes(n));
      if (intervention && !resume) { state.paused = true; state.status = 'needs-human'; state.lastReason = 'needs_human'; await persist(); return state; }
      if(typeof issue.body==='string'&&/<!--\s*codex-worker-status\s*-->/.test(issue.body)){state.paused=true;state.status='needs-human';state.lastReason='needs_human';await persist();return state;}
      if (issue.state !== 'open' || labels(issue).includes('codex:blocked')) throw new Error('Current issue is closed or blocked');
      const preflight = preflightReason(issue.body);
      if (preflight) {
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
      if (expectedIssue !== undefined) await saveJson(join(config.stateDir, 'result.schema.json'), resultSchema);
      if (canResumeSession === undefined) {
        const execHelp = await execute('codex', ['exec', '--help'], { purpose: 'codex' });
        let resumeHelp = '';
        try { resumeHelp = await execute('codex', ['exec', 'resume', '--help'], { purpose: 'codex' }); } catch { /* Initial runs may fall back to the same worktree. */ }
        for (const flag of ['--json', '--output-schema']) if (!execHelp.includes(flag)) throw new Error('Codex CLI needs JSON and schema support for exec');
        canResumeSession = ['--json', '--output-schema'].every(flag => resumeHelp.includes(flag));
      }
      current.worktreeCheck = await ensureWorktree(current, root, execute);
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
        const status = disposition(outcome, current.failures, config);
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
      try { verified = await verify(current, execute, profile); }
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
        state.paused = true; state.status = 'needs-human';
        state.lastReason = error instanceof WorktreeSafetyError || error instanceof PublicationSafetyError ? error.reason : error instanceof VerificationFailure
          ? error.retryable ? 'verification_retry_exhausted' : 'unsafe_or_unavailable_verification' : 'parent_verification_safety_failed';
        if (error instanceof VerificationFailure && error.retryable) current.repair = error.diagnostic;
        if (error instanceof WorktreeSafetyError) current.worktreeCheck = error.check;
        if (error instanceof PublicationSafetyError) current.preflight={category:'deploy',reason:error.reason};
        await persist(); await github.mark(current.number, 'needs_human');
        report(`Issue #${current.number}: parent verification needs human review.`);
        return state;
      }
      try {
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
