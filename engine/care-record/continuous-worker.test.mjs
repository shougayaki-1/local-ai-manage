import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { branchName, metadata, selectIssue, disposition } from './lib/queue.mjs';
import { emptyState, loadState, saveJson, lockState } from './lib/state.mjs';
import { codexArgs, redact, quotaKind, quotaResetAt, nextQuotaRetry, runCodex, validateResult } from './lib/codex-runner.mjs';
import { command, safeEnvironment } from './lib/process.mjs';
import { configuration, worker } from './continuous-worker.mjs';
import { GitHub } from './lib/github.mjs';

const issue = (number, names = ['codex:ready'], body = '') => ({ number, title: `Task ${number}`, state: 'open', labels: names.map(name => ({ name })), body, html_url: `https://github.com/test/repo/issues/${number}` });
const result = { status: 'completed', summary: 'Implemented', tests: ['typecheck', 'lint'], unrun_tests: 'E2E: human confirmation required', security_impact: 'None', remaining_work: 'None', safe_to_open_pr: true };
const config = configuration({});
const localScripts = { typecheck: 'tsc --noEmit', lint: 'eslint', test: 'npm run test:unit && npm run test:ui', 'test:unit': 'vitest run --project unit', 'test:ui': 'vitest run --project storybook', build: 'next build --webpack', 'test:codex-worker': 'node --test scripts/codex/*.test.mjs', 'test:ci-scope': 'node --test scripts/ci/*.test.mjs scripts/e2e/playwright-arguments.test.mjs' };

test('priority labels, metadata, issue order and default priority', () => {
  const issues = [issue(1), issue(8, ['codex:ready', 'priority:p1']), issue(9, ['codex:ready', 'priority:p0']), issue(7, ['codex:ready', 'priority:p1'])];
  assert.equal(selectIssue(issues, new Map()).number, 9);
  assert.equal(selectIssue(issues.filter(i => i.number !== 9), new Map()).number, 7);
  assert.equal(selectIssue([issue(1), issue(2, ['codex:ready'], '<!-- codex-queue\npriority: p2\ndepends_on: []\n-->')], new Map()).number, 2);
});

test('open or unknown dependency blocks; closed dependency allows selection', () => {
  const item = issue(40, ['codex:ready'], '<!-- codex-queue\npriority: p1\ndepends_on: [39]\n-->');
  for (const state of ['open', undefined]) assert.equal(selectIssue([item], new Map([[39, state]])), null);
  assert.equal(selectIssue([item], new Map([[39, 'closed']])).number, 40);
  assert.deepEqual(metadata(item.body), { dependencies: [39], priority: 'p1' });
});

test('invalid dependency metadata fails closed', () => {
  for (const value of ['["39"]', '39', '[0]', '[1,]']) assert.equal(selectIssue([issue(1, ['codex:ready'], `<!-- codex-queue\ndepends_on: ${value}\n-->`)], new Map()), null);
});

test('blocked, running, failed, needs-human, closed and linked PR issues are excluded', () => {
  for (const label of ['codex:blocked', 'codex:running', 'codex:failed', 'codex:needs-human']) assert.equal(selectIssue([issue(1, ['codex:ready', label])], new Map()), null);
  assert.equal(selectIssue([{ ...issue(1), state: 'closed' }], new Map()), null);
  assert.equal(selectIssue([issue(1)], new Map(), new Set([1])), null);
});

test('branch slug remains valid for Japanese and hostile titles', () => {
  assert.equal(branchName({ number: 56, title: '日本語' }), 'codex/issue-56-implementation');
  assert.equal(branchName({ number: 56, title: '../Fix `x` / BUG' }), 'codex/issue-56-fix-x-bug');
});

test('quota reset and retry-after take precedence over conservative exponential backoff', () => {
  const now = 1_800_000_000_000;
  assert.equal(quotaResetAt({ error: { reset_at: (now + 30_000) / 1000 } }, now), now + 30_000);
  assert.equal(quotaResetAt({ headers: { 'Retry-After': 60 } }, now), now + 60_000);
  assert.equal(quotaResetAt({ resets_at: new Date(now + 90_000).toISOString() }, now), now + 90_000);
  assert.equal(quotaResetAt('retry-after: 120', now), now + 120_000);
  assert.equal(quotaResetAt({ reset_at: (now - 1000) / 1000 }, now), null);
  assert.equal(nextQuotaRetry({ resetAt: now + 30_000 }, 20, config, now), now + 30_000);
  assert.equal(nextQuotaRetry({}, 0, config, now), now + config.quotaBackoffMs);
  assert.equal(nextQuotaRetry({}, 1, config, now), now + config.quotaBackoffMs * 2);
  assert.equal(nextQuotaRetry({ quota: 'weekly' }, 0, config, now), now + config.weeklyBackoffMs);
  assert.equal(nextQuotaRetry({}, 100, config, now), now + config.quotaMaxBackoffMs);
  const localNow = new Date(2026, 9, 3, 12, 0).getTime();
  assert.equal(quotaResetAt({ error: { message: 'Usage limit. Try again at 3:20 PM.' } }, localNow), new Date(2026, 9, 3, 15, 20).getTime());
  assert.equal(quotaResetAt('Try again at Oct 4th, 2026 3:20 PM.', localNow), new Date(2026, 9, 4, 15, 20).getTime());
});

test('quota, weekly quota, interruptions, failures and bounded retry are distinct', () => {
  assert.equal(disposition({ quota: 'window' }, 99, config), 'quota_wait');
  assert.equal(disposition({ quota: 'window' }, 0, config, 2), 'quota_wait');
  assert.equal(disposition({ quota: 'weekly' }, 0, config), 'quota_wait');
  assert.equal(disposition({ result: { status: 'quota_wait' } }, 0, config), 'quota_wait');
  assert.equal(disposition({ interrupted: true }, 0, config), 'paused');
  assert.equal(disposition({ code: 1 }, 0, config), 'retry');
  assert.equal(disposition({ code: 1 }, 1, config), 'needs_human');
  assert.equal(disposition({ result: { status: 'needs_human' } }, 0, config), 'needs_human');
  assert.equal(disposition({ needsHuman: true, code: 1 }, 0, config), 'needs_human');
  assert.equal(disposition({ code: 1, result }, 1, config), 'needs_human');
});

test('quota detection handles codes, variants and weekly limits', () => {
  for (const text of ['usage_limit_reached', 'Rate limit exceeded', 'insufficient_quota', '利用上限に達しました', 'HTTP 429', 'Your workspace is out of credits']) assert.equal(quotaKind({ error: { message: text } }), 'window');
  assert.equal(quotaKind('Weekly usage limit reached'), 'weekly');
  assert.equal(quotaKind('invalid credential'), null);
});

for (const session of [null, 'saved-session']) {
  test(`Codex ${session ? 'resume' : 'exec'} pins model and effort while preserving safety overrides`, () => {
    assert.deepEqual(codexArgs({ session }, '/schema'), [
      'exec', '--json', '--output-schema', '/schema',
      '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"',
      '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"',
      '-c', 'model="gpt-6.1-sol"', '-c', 'model_reasoning_effort="medium"',
      '-c', 'sandbox_workspace_write.network_access=false',
      '-c', 'shell_environment_policy.inherit="none"',
      ...(session ? ['resume', session] : []), '-',
    ]);
  });
}

test('credentials are redacted and not inherited by Codex', () => {
  assert.equal(redact('token=my-private-token sk-example123 ghp_example123', { MY_SECRET: 'my-private-token' }).includes('my-private-token'), false);
  assert.equal(redact('https://user:password@host/path'), 'https://[REDACTED]@host/path');
  const env = safeEnvironment({ PATH: '/bin', OPENAI_API_KEY: 'secret', SUPABASE_SERVICE_ROLE_KEY: 'secret', GH_TOKEN: 'secret' }, { home: '/credential-free-home' });
  for (const name of ['OPENAI_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'GH_TOKEN']) assert.equal(env[name], undefined);
  assert.equal(env.HOME, '/credential-free-home');
  const args = codexArgs({ session: 'session-id' }, '/schema');
  assert.ok(args.includes('resume'));
  assert.ok(args.includes('forced_login_method="chatgpt"'));
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.equal(validateResult({ ...result, tests: [1] }), null);
});

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'care-worker-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return realpath(path);
}

test('atomic state persistence, restart restoration, corrupt state and exclusive lock', async t => {
  const path = await directory(t);
  const state = { ...emptyState(), status: 'quota-wait', nextRetryAt: 123, current: { number: 40, branch: 'codex/issue-40-task', worktree: '/worktree', failures: 0, quotaWaits: 0, stage: 'implement', session: 'abc' } };
  await saveJson(join(path, 'state.json'), state);
  assert.deepEqual(await loadState(path), state);
  const unlock = await lockState(path);
  await assert.rejects(lockState(path), /lock exists/);
  await unlock();
  await writeFile(join(path, 'state.json'), '{broken');
  await assert.rejects(loadState(path), /unreadable/);
});

function mockExecute(items, calls) {
  return async (binary, args, options) => {
    calls.push([binary, args, options]);
    if (binary === 'git') {
      if (args[0] === 'remote') return 'https://github.com/test/repo.git';
      if (args[0] === 'rev-parse') return args.includes('--git-common-dir') ? '/git-meta' : 'base-sha';
      if (args[0] === 'branch') { const n = options?.cwd?.match(/issue-(\d+)$/)?.[1] ?? '40'; return `codex/issue-${n}-task-${n}`; }
      if (args[0] === 'merge-base') return 'base-sha';
      if (args[0] === 'worktree' && args[1] === 'add') {
        await mkdir(args[4], { recursive: true });
        await writeFile(join(args[4], 'vercel.json'),JSON.stringify({git:{deploymentEnabled:false}}));
        await writeFile(join(args[4], 'package.json'), JSON.stringify({ scripts: localScripts }));
      }
      if (args[0] === 'rev-list') return args.at(-1) === 'base-sha..HEAD' && args.includes('--count') ? '1' : '0';
      if (args[0] === 'diff') return 'A\tscripts/example.mjs';
      return '';
    }
    if (binary === 'npm') return '';
    if (binary === 'codex') return '--json --output-schema';
    if (args[0] === 'api') {
      const endpoint = args.at(-1);
      const number = endpoint.match(/\/issues\/(\d+)$/)?.[1];
      if (number) return JSON.stringify(items.find(i => i.number === Number(number)) ?? issue(Number(number)));
      if (endpoint.includes('/timeline?')) return '[[]]';
      if (endpoint.includes('/pulls?')) return '[[]]';
      return JSON.stringify([items]);
    }
    if (args[0] === 'pr' && args[1] === 'list') return '[]';
    if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/test/repo/pull/99';
    return '';
  };
}

test('dry-run is read-only: no fetch, lock, state write, Codex run or GitHub mutation', async t => {
  const path = await directory(t);
  const calls = [];
  const stateDir = join(path, 'state');
  await assert.rejects(worker({ config: { ...config, stateDir }, root: path, mode: 'dry-run', execute: mockExecute([issue(40)], calls), report: () => {} }), /outside/);
  const root = join(path, 'root'); await mkdir(root);
  await worker({ config: { ...config, stateDir }, root, mode: 'dry-run', execute: mockExecute([issue(40)], calls), report: () => {}, run: () => assert.fail('Codex executed') });
  assert.ok(calls.every(([binary, args]) => binary === 'git' ? args[0] === 'remote' : binary === 'gh' && args[0] === 'api'));
  await assert.rejects(readFile(join(stateDir, 'state.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(stateDir, 'worker.lock')), { code: 'ENOENT' });
});

test('quota wait survives restart and resumes same Issue before queue selection', async t => {
  const path = await directory(t);
  const root = join(path, 'root'); await mkdir(root);
  const stateDir = join(path, 'state'); await mkdir(stateDir);
  const calls = [];
  let time = 1000;
  const options = { config: { ...config, stateDir }, root, mode: 'once', now: () => time, execute: mockExecute([issue(40)], calls), report: () => {} };
  const first = await worker({ ...options, run: async ({ onSession }) => { await onSession('session-id'); return { quota: 'window', code: 1 }; } });
  assert.equal(first.lastReason, 'quota_wait');
  assert.equal(first.current.number, 40);
  assert.equal(first.current.session, 'session-id');
  assert.equal(first.current.failures, 0);
  assert.equal(first.status, 'quota-wait');
  let resumed = false;
  calls.length = 0;
  await worker({ ...options, run: () => assert.fail('Resumed before reset') });
  assert.ok(calls.every(([binary, args]) => !(binary === 'gh' && args[0] === 'api')));
  time = first.nextRetryAt;
  const second = await worker({ ...options, run: async ({ current }) => {
    resumed = true;
    assert.equal(current.number, 40);
    assert.equal(current.session, 'session-id');
    return { code: 0, result };
  } });
  assert.ok(resumed);
  assert.equal(second.current, null);
  assert.equal(second.lastReason, 'completed');
  assert.ok(calls.some(([binary, args]) => binary === 'git' && args[0] === 'push'));
  assert.ok(calls.some(([binary, args]) => binary === 'gh' && args[1] === 'create' && args.includes('--draft')));
  assert.ok(!calls.some(([, args]) => args.includes('merge')));
  assert.ok(calls.some(([binary, args, options]) => binary === 'git' && args[0] === 'fetch' && options.purpose === 'github'));
});

test('status is read-only and requires neither GitHub nor Codex', async t => {
  const path = await directory(t);
  const state = { ...emptyState(), status: 'quota-wait', nextRetryAt: 1234 };
  await saveJson(join(path, 'state.json'), state);
  let output;
  await worker({ config: { ...config, stateDir: path }, mode: 'status', report: text => { output = JSON.parse(text); }, execute: () => assert.fail('External command ran') });
  assert.equal(output.status, 'quota-wait');
  assert.equal(output.nextRetryAt, 1234);
});

test('JSONL runner persists session and safe projection while extracting structured quota reset', async t => {
  const path = await directory(t);
  const binary = join(path, 'fake-codex.mjs');
  await writeFile(binary, `#!/usr/bin/env node\nprocess.stdin.resume();\nconsole.log(JSON.stringify({type:'thread.started',thread_id:'session-123'}));\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'cat .env',aggregated_output:'PHI secret ghp_secret'}}));\nconsole.log(JSON.stringify({type:'turn.failed',error:{code:'usage_limit_reached',reset_at:1800000060,message:'private patient'}}));\nconsole.error('secret=value');\n`, { mode: 0o700 });
  let session;
  const outcome = await runCodex({ current: { number: 40, branch: 'codex/issue-40-task', worktree: path }, issue: issue(40), schemaPath: '/schema', tracePath: join(path, 'trace'), stderrPath: join(path, 'stderr'), now: () => 1_800_000_000_000, binary, onSession: async id => { session = id; } });
  assert.equal(session, 'session-123');
  assert.equal(outcome.quota, 'window');
  assert.equal(outcome.resetAt, 1_800_000_060_000);
  const log = await readFile(join(path, 'trace'), 'utf8') + await readFile(join(path, 'stderr'), 'utf8');
  for (const secret of ['PHI', 'ghp_secret', 'private patient', 'secret=value', 'cat .env']) assert.ok(!log.includes(secret));
});

test('continuous worker remains active after 180 minutes and waits only on quota', async t => {
  const path = await directory(t);
  const root = join(path, 'root'); await mkdir(root);
  const stateDir = join(path, 'state');
  const calls = [];
  const controller = new AbortController();
  let time = 0;
  let turns = 0;
  const items = [issue(40), issue(41)];
  const execute = mockExecute(items, calls);
  const state = await worker({ config: { ...config, stateDir }, root, execute: async (binary, args, options) => {
    if (binary === 'gh' && args[0] === 'issue' && args.includes('--remove-label') && !args.includes('--add-label')) items.shift();
    return execute(binary, args, options);
  }, signal: controller.signal, now: () => time, report: () => {},
    run: async ({ current }) => { turns++; assert.equal(current.number, turns === 1 ? 40 : 41); time += 200 * 60_000; return turns === 1 ? { code: 0, result } : { code: 1, quota: 'window' }; },
    wait: async () => controller.abort(),
  });
  assert.equal(turns, 2);
  assert.equal(state.status, 'quota-wait');
  assert.equal(state.current.number, 41);
});

test('finite implementation retries end in needs-human and never publish', async t => {
  const path = await directory(t);
  const root = join(path, 'root'); await mkdir(root);
  const calls = [];
  let turns = 0;
  const state = await worker({ config: { ...config, stateDir: join(path, 'state') }, root, mode: 'once', execute: mockExecute([issue(40)], calls), report: () => {}, wait: async () => {}, run: async () => { turns++; return { code: 1 }; } });
  assert.equal(turns, 2);
  assert.equal(state.status, 'needs-human');
  assert.equal(state.current.failures, 1);
  assert.ok(calls.some(([binary, args]) => binary === 'gh' && args.includes('codex:needs-human')));
  assert.ok(!calls.some(([binary, args]) => binary === 'git' && args[0] === 'push'));
});

test('needs-human pauses immediately without publishing or consuming retries', async t => {
  const path = await directory(t);
  const root = join(path, 'root'); await mkdir(root);
  const calls = [];
  const state = await worker({ config: { ...config, stateDir: join(path, 'state') }, root, mode: 'once', execute: mockExecute([issue(40)], calls), report: () => {}, run: async () => ({ code: 0, result: { ...result, status: 'needs_human', safe_to_open_pr: false } }) });
  assert.equal(state.status, 'needs-human');
  assert.equal(state.paused, true);
  assert.equal(state.current.failures, 0);
  assert.ok(calls.some(([binary, args]) => binary === 'gh' && args.includes('codex:needs-human')));
  assert.ok(!calls.some(([binary, args]) => binary === 'git' && args[0] === 'push'));
});

test('unclassified operational verification failures preserve publish stage and do not repair', async t => {
  const path = await directory(t);
  const root = join(path, 'root'); await mkdir(root);
  const stateDir = join(path, 'state');
  const calls = [];
  const execute = mockExecute([issue(40)], calls);
  const state = await worker({ config: { ...config, stateDir }, root, mode: 'once', report: () => {}, execute: async (binary, args, options) => {
    if (binary === 'npm' && args.includes('typecheck')) throw new Error('typecheck failed');
    return execute(binary, args, options);
  }, run: async () => ({ code: 0, result }) });
  assert.equal(state.current.stage, 'publish');
  assert.equal(state.status, 'needs-human');
  assert.ok(!calls.some(([binary, args]) => binary === 'git' && args[0] === 'push'));
  const restored = await worker({ config: { ...config, stateDir }, root, mode: 'once', resume: true, execute, report: () => {}, run: () => assert.fail('Codex reran while publishing') });
  assert.equal(restored.lastReason, 'completed');
});

test('resume falls back to the same worktree when CLI cannot resume with schema', async t => {
  const path = await directory(t);
  const root = join(path, 'root'); await mkdir(root);
  const stateDir = join(path, 'state');
  const calls = [];
  const execute = mockExecute([issue(40)], calls);
  await worker({ config: { ...config, stateDir }, root, mode: 'once', execute, report: () => {}, now: () => 0, run: async ({ onSession }) => { await onSession('old-session'); return { quota: 'window', code: 1, resetAt: 1000 }; } });
  let resumed = false;
  await worker({ config: { ...config, stateDir }, root, mode: 'once', now: () => 1000, execute: async (binary, args, options) => {
    if (binary === 'codex' && args.includes('resume')) return '--json';
    return execute(binary, args, options);
  }, report: () => {}, run: async ({ current }) => { resumed = true; assert.equal(current.session, null); assert.equal(current.number, 40); return { code: 0, result }; } });
  assert.ok(resumed);
});

test('GitHub snapshot excludes open PR timeline references and branch associations', async () => {
  const github = new GitHub('test/repo', async (_binary, args) => {
    assert.ok(args.includes('--paginate'));
    const endpoint = args.at(-1);
    if (endpoint.includes('/issues?')) return JSON.stringify([[issue(1)], [issue(2)]]);
    if (endpoint.includes('/pulls?')) return JSON.stringify([[{ head: { ref: 'codex/issue-1-task' } }]]);
    if (endpoint.includes('/issues/2/timeline')) return JSON.stringify([[{ source: { issue: { state: 'open', pull_request: {} } } }]]);
    return '[[]]';
  });
  const snapshot = await github.snapshot();
  assert.deepEqual([...snapshot.linked].sort(), [1, 2]);
  assert.equal(selectIssue(snapshot.issues, snapshot.dependencies, snapshot.linked), null);
});

test('publication recovery reuses a Draft PR and rejects non-draft or closed PR', async () => {
  for (const [state, isDraft, allowed] of [['OPEN', true, true], ['OPEN', false, false], ['CLOSED', true, false], ['MERGED', true, false]]) {
    const github = new GitHub('test/repo', async (_binary, args) => {
      assert.equal(args[1], 'list');
      return JSON.stringify([{ state, isDraft, url: 'https://github.com/test/repo/pull/1' }]);
    });
    if (allowed) assert.equal(await github.draft({ number: 40, branch: 'codex/issue-40-task' }, result), 'https://github.com/test/repo/pull/1');
    else await assert.rejects(github.draft({ number: 40, branch: 'codex/issue-40-task' }, result), /human review/);
  }
});

test('Codex interruption preserves resumable state and captures no raw stderr', async t => {
  const path = await directory(t);
  const binary = join(path, 'fake-interrupt.mjs');
  await writeFile(binary, `#!/usr/bin/env node\nprocess.stdin.resume();\nconsole.log(JSON.stringify({type:'thread.started',thread_id:'interrupted-session'}));\nsetInterval(()=>{},1000);\n`, { mode: 0o700 });
  const outcome = await runCodex({ current: { number: 40, branch: 'codex/issue-40-task', worktree: path }, issue: issue(40), schemaPath: '/schema', tracePath: join(path, 'trace'), stderrPath: join(path, 'stderr'), binary, maxRunMs: 200, onSession: async () => {} });
  assert.equal(outcome.interrupted, true);
  assert.equal(disposition(outcome, 0, config), 'paused');
});

test('parent worker verifies and commits actual isolated worktree changes before publishing', async t => {
  const path = await directory(t);
  const root = join(path, 'root'); await mkdir(root);
  const git = args => command('git', args, { cwd: root });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Worker Test']);
  await git(['config', 'user.email', 'worker-test@example.invalid']);
  await writeFile(join(root, 'example.txt'), 'baseline\n');
  await writeFile(join(root, 'vercel.json'),JSON.stringify({git:{deploymentEnabled:false}}));
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: localScripts }));
  await git(['add', 'example.txt', 'package.json', 'vercel.json']);
  await git(['commit', '-m', 'baseline']);
  await git(['remote', 'add', 'origin', 'https://github.com/test/repo.git']);
  await git(['update-ref', 'refs/remotes/origin/main', await git(['rev-parse', 'HEAD'])]);
  const calls = [];
  const mock = mockExecute([issue(40)], calls);
  let pushed = false;
  const state = await worker({ config: { ...config, stateDir: join(path, 'state') }, root, mode: 'once', report: () => {}, execute: async (binary, args, options) => {
    if (binary === 'git') {
      if (args[0] === 'fetch') return '';
      if (args[0] === 'push') {
        assert.equal(await command('git', ['status', '--porcelain'], options), '');
        assert.equal(await command('git', ['log', '-1', '--format=%s'], options), 'Implement issue #40');
        pushed = true;
        return '';
      }
      return command(binary, args, options);
    }
    return mock(binary, args, options);
  }, run: async ({ current }) => {
    assert.equal(await readFile(join(current.worktree, 'example.txt'), 'utf8'), 'baseline\n');
    await writeFile(join(current.worktree, 'example.txt'), 'implementation\n');
    await writeFile(join(current.worktree, 'added.txt'), 'new content\n');
    return { code: 0, result };
  } });
  assert.equal(state.lastReason, 'completed');
  assert.ok(pushed);
  assert.equal(await readFile(join(root, 'example.txt'), 'utf8'), 'baseline\n');
  assert.equal(await git(['branch', '--show-current']), 'main');
});

test('protected files and RLS changes cannot be committed or published automatically', async t => {
  for (const changed of ['M\tsupabase/migrations/20260101000000_existing.sql', 'A\tsupabase/migrations/old/new.sql', 'A\tauth.json', 'M\tsrc/utils/permissions.ts']) {
    const path = await directory(t);
    const root = join(path, 'root'); await mkdir(root);
    const calls = [];
    const execute = mockExecute([issue(40)], calls);
    const state = await worker({ config: { ...config, stateDir: join(path, 'state') }, root, mode: 'once', report: () => {}, execute: async (binary, args, options) => {
      if (binary === 'git' && args[0] === 'diff') return changed;
      return execute(binary, args, options);
    }, run: async () => ({ code: 0, result }) });
    assert.equal(state.status, 'needs-human');
    assert.ok(!calls.some(([binary, args]) => binary === 'git' && ['commit', 'push'].includes(args[0])));
  }
});


const credentialNames = ['CODEX_HOME', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR', 'GH_HOST', 'SSH_AUTH_SOCK', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY', 'NPM_TOKEN'];
const credentialEnvironment = () => ({
  PATH: process.env.PATH, HOME: '/owner-home', CODEX_HOME: '/owner-codex',
  XDG_CONFIG_HOME: '/owner-config', GH_CONFIG_DIR: '/owner-gh',
  GH_TOKEN: 'dummy-gh-token', GITHUB_TOKEN: 'dummy-github-token', GH_HOST: 'github.com',
  SSH_AUTH_SOCK: '/owner-agent', OPENAI_API_KEY: 'dummy-openai-key', CODEX_API_KEY: 'dummy-codex-key',
  CODEX_ACCESS_TOKEN: 'dummy-codex-token', SUPABASE_SERVICE_ROLE_KEY: 'dummy-supabase-key',
  NPM_TOKEN: 'dummy-npm-token', npm_config_userconfig: '/owner-npmrc', GIT_CONFIG_GLOBAL: '/owner-gitconfig',
});

function assertNoCredentials(env, allowed = []) {
  for (const name of credentialNames) if (!allowed.includes(name)) assert.equal(env[name], undefined, name);
}

test('environment policies separate build, Codex and GitHub credential capabilities', () => {
  const source = credentialEnvironment();
  const build = safeEnvironment(source, { purpose: 'build', home: '/private-home' });
  assertNoCredentials(build);
  assert.equal(build.HOME, '/private-home');
  assert.equal(build.XDG_CONFIG_HOME, '/private-home/config');
  assert.equal(build.npm_config_userconfig, '/private-home/config/npmrc');
  assert.equal(build.npm_config_globalconfig, '/private-home/config/global-npmrc');
  assert.equal(build.GIT_CONFIG_GLOBAL, '/private-home/config/gitconfig');
  const codex = safeEnvironment(source, { purpose: 'codex' });
  assertNoCredentials(codex, ['CODEX_HOME']);
  assert.equal(codex.HOME, source.HOME);
  assert.equal(codex.CODEX_HOME, source.CODEX_HOME);
  assert.equal(codex.XDG_CONFIG_HOME, undefined);
  const github = safeEnvironment(source, { purpose: 'github', home: '/github-private-home' });
  assertNoCredentials(github, ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR', 'GH_HOST', 'SSH_AUTH_SOCK']);
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR', 'GH_HOST', 'SSH_AUTH_SOCK']) assert.equal(github[name], source[name]);
  assert.equal(github.HOME, source.HOME);
  assert.equal(github.GIT_CONFIG_GLOBAL, source.GIT_CONFIG_GLOBAL);
  assert.equal(safeEnvironment({ HOME: '/owner-home', XDG_CONFIG_HOME: '/owner-config' }, { purpose: 'github', home: '/private-home' }).GH_CONFIG_DIR, '/owner-config/gh');
  assert.equal(safeEnvironment({ HOME: '/owner-home' }, { purpose: 'github', home: '/private-home' }).GH_CONFIG_DIR, '/owner-home/.config/gh');
  assert.throws(() => safeEnvironment(source), /separate absolute HOME/);
  assert.throws(() => safeEnvironment(source, { home: source.HOME }), /separate absolute HOME/);
  assert.throws(() => safeEnvironment(source, { purpose: 'untrusted' }), /Unknown subprocess purpose/);
});

test('real npm lifecycle, typecheck, lint and test subprocesses use fresh credential-free HOME/cache', async t => {
  const path = await directory(t);
  const packageData = { name: 'worker-env-fixture', version: '1.0.0', private: true, scripts: Object.fromEntries(['preinstall', 'typecheck', 'lint', 'test'].map(name => [name, 'node probe.mjs'])) };
  await writeFile(join(path, 'package.json'), JSON.stringify(packageData));
  await writeFile(join(path, 'package-lock.json'), JSON.stringify({ name: packageData.name, version: packageData.version, lockfileVersion: 3, requires: true, packages: { '': { name: packageData.name, version: packageData.version, hasInstallScript: true } } }));
  await writeFile(join(path, 'probe.mjs'), "import { writeFileSync, statSync } from 'node:fs'; writeFileSync('environment.json', JSON.stringify({ env: process.env, mode: statSync(process.env.HOME).mode & 0o777 }));");
  const homes = new Set();
  for (const args of [['ci', '--offline', '--no-audit', '--no-fund'], ['run', 'typecheck'], ['run', 'lint'], ['run', 'test']]) {
    await command('npm', args, { cwd: path, parentEnv: credentialEnvironment() });
    const { env, mode } = JSON.parse(await readFile(join(path, 'environment.json'), 'utf8'));
    assertNoCredentials(env);
    assert.notEqual(env.HOME, '/owner-home');
    assert.equal(mode, 0o700);
    assert.equal(env.npm_config_cache, join(env.HOME, 'cache/npm'));
    assert.equal(env.npm_config_userconfig, join(env.HOME, 'config/npmrc'));
    assert.equal(env.npm_config_globalconfig, join(env.HOME, 'config/global-npmrc'));
    assert.equal(env.GIT_CONFIG_GLOBAL, join(env.HOME, 'config/gitconfig'));
    assert.equal(env.XDG_CONFIG_HOME, join(env.HOME, 'config'));
    assert.ok(!homes.has(env.HOME)); homes.add(env.HOME);
    await assert.rejects(realpath(env.HOME), { code: 'ENOENT' });
  }
});

for (const session of [null, 'saved-session']) {
  test(`real Codex ${session ? 'resume' : 'exec'} runner passes pinned settings and only Codex auth locations`, async t => {
    const path = await directory(t);
    const binary = join(path, 'fake-auth-codex.mjs');
    await writeFile(binary, '#!/usr/bin/env node\nprocess.stdin.resume();\nconsole.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify(' + JSON.stringify(result).replace('"Implemented"', 'JSON.stringify({env:process.env,args:process.argv.slice(2)})') + ')}}));\n', { mode: 0o700 });
    const outcome = await runCodex({ current: { number: 40, branch: 'codex/issue-40-task', worktree: path, session }, issue: issue(40), schemaPath: '/schema', tracePath: join(path, 'trace'), stderrPath: join(path, 'stderr'), binary, parentEnv: credentialEnvironment(), onSession: async () => {} });
    assert.equal(outcome.code, 0);
    const { env, args } = JSON.parse(outcome.result.summary);
    assert.deepEqual(args, codexArgs({ session }, '/schema'));
    assert.ok(args.includes('model="gpt-6.1-sol"'));
    assert.ok(args.includes('model_reasoning_effort="medium"'));
    assertNoCredentials(env, ['CODEX_HOME']);
    assert.equal(env.HOME, '/owner-home');
    assert.equal(env.CODEX_HOME, '/owner-codex');
  });
}

test('real GitHub subprocess receives GH/SSH capabilities without Codex auth locations', async t => {
  const path = await directory(t);
  const env = JSON.parse(await command(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'], { cwd: path, purpose: 'github', parentEnv: credentialEnvironment() }));
  assertNoCredentials(env, ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR', 'GH_HOST', 'SSH_AUTH_SOCK']);
  assert.equal(env.GH_CONFIG_DIR, '/owner-gh');
  assert.equal(env.SSH_AUTH_SOCK, '/owner-agent');
  assert.equal(env.HOME, '/owner-home');
});

test('worker routes authenticated fetch/push/gh and Codex separately from npm/local Git', async t => {
  const path = await directory(t);
  const root = join(path, 'root'); await mkdir(root);
  const calls = [];
  await worker({ config: { ...config, stateDir: join(path, 'state') }, root, mode: 'once', execute: mockExecute([issue(40)], calls), report: () => {}, run: async () => ({ code: 0, result }) });
  for (const [binary, args, options] of calls) {
    const expected = binary === 'codex' ? 'codex' : binary === 'gh' || (binary === 'git' && ['fetch', 'push'].includes(args[0])) ? 'github' : 'build';
    assert.equal(options?.purpose ?? 'build', expected, `${binary} ${args[0]}`);
  }
  assert.ok(calls.some(([binary, args]) => binary === 'git' && args[0] === 'fetch'));
  assert.ok(calls.some(([binary, args]) => binary === 'git' && args[0] === 'push'));
  assert.ok(calls.some(([binary, args]) => binary === 'npm' && args[0] === 'ci'));
});


test('keyring-only GitHub auth retains login HOME/session without exporting tokens to other purposes', async t => {
  const path = await directory(t);
  const owner = join(path, 'owner'); await mkdir(owner);
  const source = { PATH: process.env.PATH, HOME: owner, CODEX_HOME: join(owner, '.codex'),
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fake-session', XDG_RUNTIME_DIR: '/fake-runtime' };
  const fakeGh = join(path, 'fake-gh.mjs');
  await writeFile(fakeGh, '#!/usr/bin/env node\nif (process.env.HOME !== ' + JSON.stringify(owner) + ' || process.env.DBUS_SESSION_BUS_ADDRESS !== "unix:path=/fake-session" || process.env.XDG_RUNTIME_DIR !== "/fake-runtime" || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.CODEX_HOME) process.exit(1); console.log("keyring authenticated");\n', { mode: 0o700 });
  for (const args of [['auth', 'status'], ['api', 'user'], ['api', 'repos/owner/repo']]) {
    assert.equal(await command(fakeGh, args, { purpose: 'github', parentEnv: source }), 'keyring authenticated');
  }
  const build = safeEnvironment(source, { purpose: 'build', home: join(path, 'build') });
  const codex = safeEnvironment(source, { purpose: 'codex' });
  for (const env of [build, codex]) {
    assert.equal(env.DBUS_SESSION_BUS_ADDRESS, undefined);
    assert.equal(env.XDG_RUNTIME_DIR, undefined);
    assert.equal(env.GH_CONFIG_DIR, undefined);
  }
  assert.notEqual(build.HOME, owner);
  assert.equal(build.CODEX_HOME, undefined);
});

// All worker regression cases use a fresh temporary state and mocked publication.
// No existing worker state, worktree or session is discovered or accessed.
async function repairFixture(t, { body = '', maxRetries = 1 } = {}) {
  const path = await directory(t);
  const root = join(path, 'root'); await mkdir(root);
  const calls = [];
  const stateDir = join(path, 'state');
  const execute = mockExecute([issue(40, ['codex:ready'], body)], calls);
  return { path, root, calls, stateDir, execute,
    options: { root, config: { ...config, stateDir, maxRetries }, mode: 'once', wait: async () => {}, report: () => {} } };
}

for (const body of [
  '## Acceptance Criteria\n- E2Eを実行して成功すること',
  '## Required Tests\n- npm run test:e2e:critical',
  'You MUST run E2E tests successfully.',
]) test(`E2E execution preflight stops before any worktree or Codex command: ${body}`, async t => {
  const f = await repairFixture(t, { body });
  const state = await worker({ ...f.options, execute: f.execute, run: () => assert.fail('Codex ran') });
  assert.equal(state.lastReason, 'manual_e2e_required');
  assert.equal(state.status, 'needs-human');
  assert.equal(state.current.stage, 'prepare');
  assert.ok(f.calls.some(([b, a]) => b === 'gh' && a.includes('codex:needs-human')));
  assert.ok(!f.calls.some(([b, a]) => b === 'codex' || b === 'npm' || (b === 'git' && ['fetch', 'worktree', 'push'].includes(a[0]))));
  await assert.rejects(readFile(join(f.stateDir, 'worktrees/issue-40/package.json')), { code: 'ENOENT' });
});

for (const body of [
  '## Acceptance Criteria\n- E2E test file tests/foo.spec.ts のselectorを更新すること。実行自体は必須ではない。',
  '## Required Tests\n- Update the E2E fixture/test code without running E2E.\n- Run typecheck.',
  'Background: E2E tests run in CI.\n## Acceptance Criteria\n- Update selectors in tests/foo.spec.ts',
  'E2E実行は禁止。\n## Acceptance Criteria\n- unitを実行すること',
]) test(`E2E code/optional mentions do not block implementation: ${body}`, async t => {
  const f = await repairFixture(t, { body });
  let ran = false;
  const state = await worker({ ...f.options, execute: f.execute, run: async () => { ran = true; return { code: 0, result }; } });
  assert.ok(ran); assert.equal(state.lastReason, 'completed');
  assert.ok(!f.calls.some(([b, a]) => b === 'npm' && a.some(s => /test:e2e/.test(s))));
});

for (const check of ['typecheck', 'lint', 'test:unit', 'test:ui', 'build', 'test:ci-scope', 'diff-check']) {
  test(`parent ${check} assertion returns safe feedback to same session and only publishes after repair`, async t => {
    const f = await repairFixture(t);
    let turns = 0; let checks = 0;
    const handoff = { ...result, status: 'needs_human', safe_to_open_pr: false,
      unrun_tests: 'listen EPERM: delegated local check', reasons: [{ category: 'sandbox_capability', check }] };
    const { CommandFailure } = await import('./lib/failure.mjs');
    const state = await worker({ ...f.options, now: () => turns, execute: async (b, a, o) => {
      if ((b === 'npm' && a[1] === check) || (check === 'diff-check' && b === 'git' && a[0] === 'diff' && a[1] === '--check')) {
        checks++;
        if (checks === 1) throw new CommandFailure({ assertion: true });
      }
      if (b === 'git' && a[0] === 'push') assert.ok(checks >= 2, 'premature publication');
      return f.execute(b, a, o);
    }, run: async ({ current, onSession }) => {
      turns++;
      if (turns === 1) await onSession('same-session');
      else {
        assert.equal(current.session, 'same-session');
        assert.equal(current.worktree, join(f.stateDir, 'worktrees/issue-40'));
        assert.equal(current.branch, 'codex/issue-40-task-40');
        assert.equal(current.base, 'base-sha');
        assert.equal(current.failures, 1);
        assert.deepEqual(current.repair, { category: 'local_verification', check, diagnostic: 'assertion_failed' });
      }
      return { code: 0, result: turns === 1 ? handoff : { ...result, reasons: [] } };
    } });
    assert.equal(turns, 2); assert.equal(state.lastReason, 'completed');
    assert.ok(!f.calls.some(([, a]) => ['reset', 'rebase', 'clean', 'stash'].includes(a[0]) || a.includes('codex:needs-human')));
  });
}

test('quota during parent self-repair persists feedback/count/session and resumes without consuming another retry', async t => {
  const f = await repairFixture(t);
  const { CommandFailure } = await import('./lib/failure.mjs');
  let turns = 0; let time = 10; let checks = 0;
  const options = { ...f.options, now: () => time, execute: async (b, a, o) => {
    if (b === 'npm' && a[1] === 'typecheck' && ++checks === 1) throw new CommandFailure({ type: true });
    return f.execute(b, a, o);
  } };
  const first = await worker({ ...options, run: async ({ onSession }) => {
    await onSession('repair-quota-session'); turns++;
    return turns === 1 ? { code: 0, result } : { code: 1, quota: 'window', resetAt: 100 };
  } });
  assert.equal(first.status, 'quota-wait'); assert.equal(first.current.failures, 1);
  assert.equal(first.current.repair.diagnostic, 'type_error');
  assert.equal(first.current.session, 'repair-quota-session');
  time = 100;
  const final = await worker({ ...options, run: async ({ current }) => {
    assert.equal(current.failures, 1); assert.equal(current.session, 'repair-quota-session');
    assert.equal(current.repair.check, 'typecheck'); return { code: 0, result };
  } });
  assert.equal(final.lastReason, 'completed');
});

test('parent verification retry is bounded and exhausted failures require human review', async t => {
  const f = await repairFixture(t, { maxRetries: 2 });
  const { CommandFailure } = await import('./lib/failure.mjs');
  let turns = 0;
  const state = await worker({ ...f.options, execute: async (b, a, o) => {
    if (b === 'npm' && a[1] === 'typecheck') throw new CommandFailure({ assertion: true });
    return f.execute(b, a, o);
  }, run: async () => { turns++; return { code: 0, result }; } });
  assert.equal(turns, 3); assert.equal(state.current.failures, 2);
  assert.equal(state.lastReason, 'verification_retry_exhausted');
  assert.equal(state.paused, true);
  assert.ok(!f.calls.some(([b, a]) => b === 'git' && ['push', 'commit'].includes(a[0])));
});

for (const category of ['db', 'auth', 'permission', 'tenant', 'production', 'deploy', 'credential', 'external_service', 'destructive', 'security', 'retention', 'specification', 'manual_e2e', 'worktree_safety']) {
  test(`unsafe ${category} reason is never overridden even alongside sandbox reasons`, async t => {
    const f = await repairFixture(t);
    const state = await worker({ ...f.options, execute: f.execute, run: async () => ({ code: 0, result: { ...result,
      reasons: [{ category: 'sandbox_capability', check: 'test:ui' }, { category, check: 'none' }] } }) });
    assert.equal(state.status, 'needs-human'); assert.equal(state.current.failures, 0);
    assert.deepEqual(state.current.result.reasons,[{category:'sandbox_capability',check:'test:ui'},{category,check:'none'}]);
    assert.ok(!f.calls.some(([b, a]) => b === 'git' && a[0] === 'push'));
  });
}

test('unsafe parent command failure never triggers repair', async t => {
  const f = await repairFixture(t);
  const { CommandFailure } = await import('./lib/failure.mjs');
  let turns = 0;
  const state = await worker({ ...f.options, execute: async (b, a, o) => {
    if (b === 'npm' && a[1] === 'typecheck') throw new CommandFailure({ unsafe: true });
    return f.execute(b, a, o);
  }, run: async () => { turns++; return { code: 0, result }; } });
  assert.equal(turns, 1); assert.equal(state.current.failures, 0);
  assert.equal(state.lastReason, 'unsafe_or_unavailable_verification');
});

for (const failure of ['push', 'pr']) test(`${failure} publication failure never reruns Codex`, async t => {
  const f = await repairFixture(t);
  let turns = 0;
  const state = await worker({ ...f.options, execute: async (b, a, o) => {
    if ((failure === 'push' && b === 'git' && a[0] === 'push') || (failure === 'pr' && b === 'gh' && a[0] === 'pr' && a[1] === 'create')) throw new Error('private credential error');
    return f.execute(b, a, o);
  }, run: async () => { turns++; return { code: 0, result }; } });
  assert.equal(turns, 1); assert.equal(state.lastReason, 'publication_failed');
  assert.equal(state.current.stage, 'publish'); assert.equal(state.current.failures, 0);
  assert.ok(!(await readFile(join(f.stateDir, 'state.json'), 'utf8')).includes('private credential error'));
});

test('failed process output is projected to fixed diagnostics without stderr/secret/PHI', async () => {
  let error;
  try {
    await command(process.execPath, ['-e', "console.log('TS2322 patient example@example.invalid'); console.error('AssertionError ghp_private token=secret-value'); process.exit(1)"]);
  } catch (caught) { error = caught; }
  assert.equal(error.diagnostic, 'type_error');
  for (const text of ['patient', 'example@', 'ghp_private', 'secret-value', 'TS2322']) assert.ok(!JSON.stringify(error).includes(text));
});

for (const status of ['completed', 'needs_human']) test(`structured sandbox ${status}/false is eligible; free text alone is never an override`, () => {
  const handoff = { ...result, status, safe_to_open_pr: false,
    reasons: [{ category: 'sandbox_capability', check: 'test:ui' }] };
  assert.equal(disposition({ code: 0, result: handoff }, 0, config), 'completed');
  assert.notEqual(disposition({ code: 0, result: { ...handoff, reasons: undefined } }, 0, config), 'completed');
  assert.equal(disposition({ code: 0, needsHuman: true, result: handoff }, 0, config), 'needs_human');
  assert.equal(disposition({ code: 0, result: { ...handoff, unrun_tests: 'migration required' } }, 0, config), 'needs_human');
  assert.equal(validateResult({ ...handoff, reasons: [{ category: 'sandbox_capability', check: 'test:e2e' }] }), null);
  assert.equal(validateResult({ ...handoff, reasons: [{ category: 'sandbox_capability', check: 'test:ui', detail: 'secret' }] }), null);
});

test('preflight leaves only a fixed safe Issue reason and does not duplicate it on resume', async t => {
  const f = await repairFixture(t, { body: '## Acceptance Criteria\n### Required browser checks\n- E2Eを実行して成功すること PRIVATE-ISSUE-TEXT' });
  await worker({ ...f.options, execute: f.execute, run: () => assert.fail('Codex ran') });
  await worker({ ...f.options, resume: true, execute: f.execute, run: () => assert.fail('Codex ran') });
  const comments = f.calls.filter(([b, a]) => b === 'gh' && a[0] === 'issue' && a[1] === 'comment');
  assert.equal(comments.length, 1);
  assert.ok(comments[0][2].input.includes('manual_e2e_required'));
  assert.ok(!comments[0][2].input.includes('PRIVATE-ISSUE-TEXT'));
  assert.ok(!(await readFile(join(f.stateDir, 'state.json'), 'utf8')).includes('PRIVATE-ISSUE-TEXT'));
});

test('unsafe/hooked check scripts stop the entire verification plan before executing any npm check', async t => {
  for (const scripts of [
    { ...localScripts, 'pretest:ui': 'npm run test:e2e' },
    { ...localScripts, build: 'deploy production' },
    { ...localScripts, typecheck: 'npm run test:e2e' },
    { ...localScripts, postlint: 'curl external-service' },
  ]) {
    const f = await repairFixture(t);
    const state = await worker({ ...f.options, execute: f.execute, run: async ({ current }) => {
      await writeFile(join(current.worktree,'vercel.json'),JSON.stringify({git:{deploymentEnabled:false}}));
      await writeFile(join(current.worktree, 'package.json'), JSON.stringify({ scripts }));
      return { code: 0, result: { ...result, reasons: [{ category: 'sandbox_capability', check: 'test:ui' }, { category: 'sandbox_capability', check: 'build' }] } };
    } });
    assert.equal(state.lastReason, 'parent_verification_safety_failed');
    assert.ok(!f.calls.some(([b, a]) => b === 'npm' && a[0] === 'run'));
    assert.ok(!f.calls.some(([b, a]) => b === 'git' && a[0] === 'push'));
  }
});

test('parent test changing HEAD/status on failure is a safety anomaly, never a self-repair', async t => {
  const f = await repairFixture(t);
  const { CommandFailure } = await import('./lib/failure.mjs');
  let changed = false; let turns = 0;
  const state = await worker({ ...f.options, execute: async (b, a, o) => {
    if (b === 'npm' && a[1] === 'typecheck') { changed = true; throw new CommandFailure({ assertion: true }); }
    if (changed && b === 'git' && a[0] === 'status') return '?? unexpected-file';
    return f.execute(b, a, o);
  }, run: async () => { turns++; return { code: 0, result }; } });
  assert.equal(turns, 1); assert.equal(state.lastReason, 'verification_changed_worktree');
  assert.equal(state.current.failures, 0);
});

for (const resumeAvailable of [true, false]) test(`repair keeps saved session and stops if ${resumeAvailable ? 'a different session is reported' : 'CLI resume is unavailable'}`, async t => {
  const f = await repairFixture(t);
  const { CommandFailure } = await import('./lib/failure.mjs');
  let turns = 0;
  await assert.rejects(worker({ ...f.options, execute: async (b, a, o) => {
    if (!resumeAvailable && b === 'codex' && a.includes('resume')) return '--json';
    if (b === 'npm' && a[1] === 'typecheck') throw new CommandFailure({ assertion: true });
    return f.execute(b, a, o);
  }, run: async ({ onSession }) => {
    turns++;
    await onSession(turns === 1 ? 'saved-session' : 'different-session');
    return { code: 0, result };
  } }), /repair_session/);
  const state = await loadState(f.stateDir);
  assert.equal(state.current.session, 'saved-session');
  assert.equal(state.lastReason, resumeAvailable ? 'repair_session_mismatch' : 'repair_session_resume_unavailable');
  assert.equal(state.paused, true); assert.equal(state.current.failures, 1);
  assert.equal(turns, resumeAvailable ? 2 : 1);
});

test('real JSONL resume refuses a replacement thread during self-repair', async t => {
  const path = await directory(t);
  const binary = join(path, 'session-mismatch.mjs');
  await writeFile(binary, `#!/usr/bin/env node\nprocess.stdin.resume();\nconsole.log(JSON.stringify({type:'thread.started',thread_id:'different-thread'}));\n`, { mode: 0o700 });
  const outcome = await runCodex({ current: { worktree: path, session: 'saved-thread', repair: { category: 'local_verification', check: 'typecheck', diagnostic: 'type_error' } },
    issue: issue(40), schemaPath: '/schema', tracePath: join(path, 'trace'), stderrPath: join(path, 'stderr'), binary, onSession: () => assert.fail('Session was replaced') });
  assert.equal(outcome.safetyReason, 'repair_session_mismatch');
});

test('dry-run reports required E2E preflight without preparing state/worktree/Codex commands', async t => {
  const f = await repairFixture(t, { body: 'Required Tests:\n- E2E execution must pass.' });
  let preview;
  await worker({ ...f.options, mode: 'dry-run', execute: f.execute, report: value => { preview = JSON.parse(value); }, run: () => assert.fail('Codex ran') });
  assert.equal(preview.preflight, 'manual_e2e_required'); assert.deepEqual(preview.commands, []);
  await assert.rejects(readFile(join(f.stateDir, 'state.json')), { code: 'ENOENT' });
});

for (const failure of ['migration required', 'authentication required', 'credentials required', 'requires external service']) test(`real unsafe command diagnostic prevents local-verification classification: ${failure}`, async () => {
  await assert.rejects(command(process.execPath, ['-e', `console.error(${JSON.stringify(failure)});process.exit(1)`]), error => error.category === 'unsafe' && !JSON.stringify(error).includes(failure));
});

test('bounded dispatch rejects a changed candidate without state or GitHub writes',async t=>{
 const path=await directory(t);const root=join(path,'root');await mkdir(root);const stateDir=join(path,'state');await mkdir(stateDir);
 const raw=JSON.stringify({...emptyState(),repo:'test/repo'});await writeFile(join(stateDir,'state.json'),raw);const calls=[];
 await worker({config:{...config,stateDir},root,mode:'once',expectedIssue:40,execute:mockExecute([issue(41)],calls),run:()=>assert.fail('Codex executed'),report:()=>{}});
 assert.equal(await readFile(join(stateDir,'state.json'),'utf8'),raw);
 assert.ok(calls.every(([binary,args])=>binary==='git'?args[0]==='remote':binary==='gh'&&['api','auth'].includes(args[0])));
 await assert.rejects(readFile(join(stateDir,'result.schema.json')),{code:'ENOENT'});
});
test('bounded dispatch refreshes dependency and PR observations before claiming',async t=>{
 for(const change of ['dependency','linked']) {
  const path=await directory(t);const root=join(path,'root');await mkdir(root);const stateDir=join(path,'state');await mkdir(stateDir);
  const raw=JSON.stringify({...emptyState(),repo:'test/repo'});await writeFile(join(stateDir,'state.json'),raw);const calls=[];
  const candidate=issue(40,['codex:ready'],'<!-- codex-queue\ndepends_on: [39]\n-->');let scans=0;
  const fallback=mockExecute([candidate],calls);
  const execute=async(binary,args,options)=>{
   const endpoint=args.at(-1);
   if(binary==='gh'&&args[0]==='api') {
    if(endpoint.includes('/issues?'))scans++;
    if(endpoint.endsWith('/issues/39'))return JSON.stringify({...issue(39),state:scans>1&&change==='dependency'?'open':'closed'});
    if(endpoint.includes('/pulls?')&&scans>1&&change==='linked')return JSON.stringify([[{head:{ref:'codex/issue-40-task'}}]]);
   }
   return fallback(binary,args,options);
  };
  await worker({config:{...config,stateDir},root,mode:'once',expectedIssue:40,execute,run:()=>assert.fail('Codex executed'),report:()=>{}});
  assert.equal(scans,2);assert.equal(await readFile(join(stateDir,'state.json'),'utf8'),raw);
  assert.ok(!calls.some(([binary,args])=>binary==='gh'&&args[0]==='issue'));
 }
});
test('bounded dispatch preserves paused, quota and mismatching saved current bytes',async t=>{
 for(const variant of ['paused','quota','mismatch','human-unpaused']) {
  const path=await directory(t);const root=join(path,'root');await mkdir(root);const stateDir=join(path,'state');await mkdir(stateDir);
  const state={...emptyState(),repo:'test/repo',status:variant==='paused'||variant==='human-unpaused'?'needs-human':variant==='quota'?'quota-wait':'running',paused:variant==='paused',nextRetryAt:variant==='quota'?1000:null,current:{number:40,branch:'codex/issue-40-task',worktree:join(stateDir,'worktrees/issue-40'),base:'saved-base',session:'saved-session',failures:1,quotaWaits:2,stage:'implement'}};
  const raw=JSON.stringify(state);await writeFile(join(stateDir,'state.json'),raw);
  await worker({config:{...config,stateDir},root,mode:'once',expectedIssue:variant==='mismatch'?41:40,now:()=>0,execute:mockExecute([issue(41)],[]),run:()=>assert.fail('Codex executed'),report:()=>{}});
  assert.equal(await readFile(join(stateDir,'state.json'),'utf8'),raw);
 }
 await assert.rejects(worker({config,mode:'normal',expectedIssue:40}),/bounded dispatch/);
 await assert.rejects(worker({config,mode:'once',resume:true,expectedIssue:40}),/bounded dispatch/);
});
test('bounded current recovery retains saved session, base and retry budget',async t=>{
 const path=await directory(t);const root=join(path,'root');await mkdir(root);const stateDir=join(path,'state');await mkdir(stateDir);
 const current={number:40,branch:'codex/issue-40-task-40',worktree:join(stateDir,'worktrees/issue-40'),base:'base-sha',session:'saved-session',failures:1,quotaWaits:2,stage:'implement'};
 await mkdir(current.worktree,{recursive:true});await writeFile(join(current.worktree,'vercel.json'),JSON.stringify({git:{deploymentEnabled:false}}));await writeFile(join(current.worktree,'package.json'),JSON.stringify({scripts:localScripts}));
 await saveJson(join(stateDir,'state.json'),{...emptyState(),repo:'test/repo',status:'running',current});
 let ran=false;await worker({config:{...config,stateDir},root,mode:'once',expectedIssue:40,execute:mockExecute([issue(41)],[]),report:()=>{},run:async({current:restored})=>{
  ran=true;assert.equal(restored.session,'saved-session');assert.equal(restored.base,'base-sha');assert.equal(restored.failures,1);assert.equal(restored.quotaWaits,2);return {quota:'window',code:1};
 }});assert.equal(ran,true);
 const saved=await loadState(stateDir);assert.equal(saved.current.session,'saved-session');assert.equal(saved.current.failures,1);assert.equal(saved.current.quotaWaits,3);
});

test('managed continuation parks human work with its session, base and failures while another issue runs',async t=>{
 const path=await directory(t);const root=join(path,'root');await mkdir(root);const stateDir=join(path,'state');await mkdir(stateDir);
 const current={number:40,branch:'codex/issue-40-task',worktree:join(stateDir,'worktrees/issue-40'),base:'saved-base',session:'saved-session',failures:1,quotaWaits:2,stage:'implement',result:{status:'needs_human',reasons:[{category:'external_service',check:'build'}]}};
 await saveJson(join(stateDir,'state.json'),{...emptyState(),repo:'test/repo',status:'needs-human',paused:true,lastReason:'needs_human',current});
 const calls=[];let ran=false;
 const state=await worker({config:{...config,stateDir},root,mode:'once',expectedIssue:41,continueAfterHuman:true,now:()=>1000,execute:mockExecute([issue(40),issue(41)],calls),report:()=>{},run:async({current:next})=>{ran=true;assert.equal(next.number,41);return {quota:'window',code:1};}});
 assert.ok(ran);assert.equal(state.current.number,41);assert.deepEqual(state.humanWaiting,[{current,reason:'needs_human',since:1000}]);
 assert.equal(state.status,'quota-wait');assert.ok(!calls.some(([,args])=>args.some((arg,index)=>arg==='--remove-label'&&args[index+1]==='codex:needs-human')));
 const saved=await loadState(stateDir);assert.deepEqual(saved.humanWaiting[0].current,current);
});

test('managed continuation never clears manual pauses, failed states, quota or a changed candidate',async t=>{
 for(const variant of ['paused','failed','quota','changed','same']){
  const path=await directory(t);const root=join(path,'root');await mkdir(root);const stateDir=join(path,'state');await mkdir(stateDir);
  const state={...emptyState(),repo:'test/repo',status:variant==='paused'?'running':variant==='failed'?'failed':'needs-human',paused:true,nextRetryAt:variant==='quota'?9999:null,current:{number:40,branch:'codex/issue-40-task',worktree:join(stateDir,'worktrees/issue-40'),base:'saved-base',session:'saved-session',failures:1,quotaWaits:2,stage:'implement'}};
  const raw=JSON.stringify(state);await writeFile(join(stateDir,'state.json'),raw);
  await worker({config:{...config,stateDir},root,mode:'once',expectedIssue:variant==='same'?40:41,continueAfterHuman:true,now:()=>0,execute:mockExecute([issue(42)],[]),report:()=>{},run:()=>assert.fail('Codex executed')});
  assert.equal(await readFile(join(stateDir,'state.json'),'utf8'),raw);
 }
});

test('waiting human work is excluded even after its GitHub labels are accidentally cleared',async t=>{
 const path=await directory(t);const root=join(path,'root');await mkdir(root);const stateDir=join(path,'state');await mkdir(stateDir);
 const waiting={number:40,branch:'codex/issue-40-task',worktree:join(stateDir,'worktrees/issue-40'),base:'base-sha',session:'saved-session',failures:1,quotaWaits:2,stage:'implement'};
 await saveJson(join(stateDir,'state.json'),{...emptyState(),repo:'test/repo',humanWaiting:[{current:waiting,reason:'needs_human',since:1000}]});
 const state=await worker({config:{...config,stateDir},root,mode:'once',expectedIssue:41,continueAfterHuman:true,execute:mockExecute([issue(40),issue(41)],[]),report:()=>{},run:async({current})=>{assert.equal(current.number,41);return {quota:'window',code:1};}});
 assert.equal(state.humanWaiting[0].current.session,'saved-session');assert.equal(state.current.number,41);
});

test('invalid or duplicate parked work is rejected on restart',async t=>{
 const path=await directory(t);const current={number:40,branch:'codex/issue-40-task',worktree:'/saved',failures:1,quotaWaits:2,stage:'implement'};
 for(const humanWaiting of [[{current:{...current,stage:'unknown'},reason:'needs_human',since:1}],[{current,reason:'needs_human',since:1},{current,reason:'needs_human',since:1}],[{current,reason:'needs_human',since:-1}]]){
  await saveJson(join(path,'state.json'),{...emptyState(),humanWaiting});await assert.rejects(loadState(path),/Invalid worker state/);
 }
});


test('minute-only CLI quota reset in the current minute retries shortly rather than tomorrow',()=>{
 const now=new Date(2026,9,4,23,30,13).getTime();
 assert.equal(quotaResetAt('Usage limit. Try again at 11:30 PM.',now),now+60000);
 assert.equal(quotaResetAt('Usage limit. Try again at 11:29 PM.',now),new Date(2026,9,5,23,29).getTime());
 assert.equal(quotaResetAt('Usage limit. Try again at 11:31 PM.',now),new Date(2026,9,4,23,31).getTime());
 assert.equal(quotaResetAt({error:{resets_at:new Date(now+3600000).toISOString()}},now),now+3600000);
});

for (const succeeds of [true, false]) test(`automatic alternative implementation is bounded and ${succeeds ? 'publishes only after verification' : 'retains failed work'}`, async t => {
  const f = await repairFixture(t);
  const { CommandFailure } = await import('./lib/failure.mjs');
  let turns = 0, checks = 0;
  const state = await worker({ ...f.options, expectedIssue: 40, reviewPolicy: 'local-automatic', continueAfterHuman: true,
    execute: async (b, a, o) => {
      if (b === 'git' && a[0] === 'show' && a[1]?.endsWith(':vercel.json')) return JSON.stringify({ git: { deploymentEnabled: false } });
      if (b === 'git' && a[0] === 'rev-list' && a.includes('--count') && a.at(-1).endsWith('..HEAD')) return '1';
      if (b === 'git' && (a[0] === 'merge-base' || a[0] === 'rev-parse' && !a.includes('--git-common-dir'))) return 'a'.repeat(40);
      if (b === 'git' && a[0] === 'diff' && a.includes('-z')) return 'A\0scripts/example.mjs\0';
      if (b === 'git' && a[0] === 'worktree' && a[1] === 'add') {
        const value = await f.execute(b, a, o);
        await mkdir(join(a[4], 'scripts/e2e'),{recursive:true});
        await writeFile(join(a[4], 'playwright.config.ts'),await readFile(new URL('./e2e/playwright.config.ts.reference',import.meta.url)));
        await writeFile(join(a[4], 'scripts/e2e/local-environment.mjs'),await readFile(new URL('./e2e/local-environment.mjs',import.meta.url)));
        await writeFile(join(a[4], 'package.json'),JSON.stringify({scripts:{...localScripts,dev:'next dev --webpack'}}));
        await writeFile(join(a[4], 'scripts/example.mjs'), 'export const example = true;');
        return value;
      }
      if (b === 'npm' && a[1] === 'typecheck') {
        checks++;
        if (!succeeds || checks < 4) throw new CommandFailure({ assertion: true });
      }
      if (b === 'git' && ['push','commit'].includes(a[0])) assert.equal(checks, 4);
      return f.execute(b, a, o);
    }, run: async ({ current, onSession }) => {
      turns++;
      if (turns === 1) await onSession('alternative-session');
      else assert.equal(current.session, 'alternative-session');
      if (turns >= 3) {
        assert.equal(current.alternativeHistory.length, turns - 2);
        assert.equal(current.base, 'a'.repeat(40));
        assert.equal(current.failures, turns - 1);
      }
      return { code: 0, result: { ...result, reasons: [] } };
    } });
  assert.equal(turns, 4, JSON.stringify({ reason: state.lastReason, humanReasons: state.current?.humanReasons, checks }));
  assert.equal(checks, 4);
  assert.equal(state.lastReason, succeeds ? 'completed' : 'automatic_verification_failed');
  if (!succeeds) {
    assert.equal(state.current.alternativeHistory.length, 2);
    assert.equal((await loadState(f.stateDir)).current.session, 'alternative-session');
    assert.ok(!f.calls.some(([b,a]) => b === 'git' && ['push','commit'].includes(a[0])));
  }
});

test('alternative planning excludes unsafe, operational and DB environment failures', async () => {
  const { planAlternative, VerificationFailure, CommandFailure } = await import('./lib/failure.mjs');
  for (const failure of [new Error('operational'), new CommandFailure({ unsafe: true }), new CommandFailure({ capability: true }), new CommandFailure({ localPhase: 'start' }), new CommandFailure({ localPhase: 'migrations' })]) {
    const current = { failures: 1, stage: 'publish' };
    assert.equal(planAlternative(current, new VerificationFailure('local_db_e2e', failure)), false);
    assert.deepEqual(current, { failures: 1, stage: 'publish' });
  }
});

test('alternative prompt preserves acceptance criteria and required verification', async () => {
  const { implementationPrompt } = await import('./lib/codex-runner.mjs');
  const diagnostic = { category: 'local_verification', check: 'test:ui', diagnostic: 'assertion_failed' };
  const prompt = implementationPrompt(issue(40), { number: 40, repair: diagnostic, alternativeHistory: [diagnostic] }, 'care-record-v1', 'local-automatic');
  assert.match(prompt, /Alternative implementation attempt 1\/2/);
  assert.match(prompt, /materially different implementation/);
  assert.match(prompt, /preserve every acceptance criterion/);
  assert.match(prompt, /never claim unrun verification passed/);
  assert.match(prompt, /Do not remove required behavior/);
});

test('alternative history survives quota without consuming another attempt', async t => {
  const f = await repairFixture(t);
  const { CommandFailure } = await import('./lib/failure.mjs');
  let turns = 0, checks = 0, time = 1000;
  const options = { ...f.options, expectedIssue: 40, reviewPolicy: 'local-automatic', continueAfterHuman: true, now: () => time,
    execute: async (b, a, o) => {
      if (b === 'git' && a[0] === 'show' && a[1]?.endsWith(':vercel.json')) return JSON.stringify({ git: { deploymentEnabled: false } });
      if (b === 'git' && a[0] === 'rev-list' && a.includes('--count') && a.at(-1).endsWith('..HEAD')) return '1';
      if (b === 'git' && (a[0] === 'merge-base' || a[0] === 'rev-parse' && !a.includes('--git-common-dir'))) return 'a'.repeat(40);
      if (b === 'git' && a[0] === 'diff' && a.includes('-z')) return 'A\0scripts/example.mjs\0';
      if (b === 'git' && a[0] === 'worktree' && a[1] === 'add') {
        const value = await f.execute(b,a,o);
        await mkdir(join(a[4], 'scripts/e2e'),{recursive:true});
        await writeFile(join(a[4], 'playwright.config.ts'),await readFile(new URL('./e2e/playwright.config.ts.reference',import.meta.url)));
        await writeFile(join(a[4], 'scripts/e2e/local-environment.mjs'),await readFile(new URL('./e2e/local-environment.mjs',import.meta.url)));
        await writeFile(join(a[4], 'package.json'),JSON.stringify({scripts:{...localScripts,dev:'next dev --webpack'}}));
        await writeFile(join(a[4], 'scripts/example.mjs'), 'export const example = true;');
        return value;
      }
      if (b === 'npm' && a[1] === 'typecheck' && ++checks <= 2) throw new CommandFailure({ type: true });
      return f.execute(b,a,o);
    } };
  const first = await worker({ ...options, run: async ({ onSession }) => {
    turns++; if (turns === 1) await onSession('alternative-quota-session');
    return turns === 3 ? { quota: 'window', code: 1 } : { code: 0, result: { ...result, reasons: [] } };
  } });
  assert.equal(first.lastReason, 'quota_wait', JSON.stringify({ turns, checks, humanReasons: first.current?.humanReasons }));
  assert.equal(first.current.alternativeHistory.length, 1);
  assert.equal(first.current.failures, 2);
  const invalid = structuredClone(first);
  invalid.current.alternativeHistory = Array(3).fill(first.current.repair);
  await saveJson(join(f.stateDir, 'state.json'), invalid);
  await assert.rejects(loadState(f.stateDir), /Invalid worker state/);
  await saveJson(join(f.stateDir, 'state.json'), first);
  time = first.nextRetryAt;
  const second = await worker({ ...options, run: async ({ current }) => {
    assert.equal(current.session, 'alternative-quota-session');
    assert.equal(current.alternativeHistory.length, 1);
    assert.equal(current.failures, 2);
    return { code: 0, result: { ...result, reasons: [] } };
  } });
  assert.equal(second.lastReason, 'completed');
});

for (const labels of [['codex:running'], ['codex:blocked'], ['codex:needs-human']]) {
  test(`managed saved repair uses ordinary session resume and respects intervention: ${labels.join(',')}`, async t => {
    const f = await repairFixture(t);
    const current = { number: 40, branch: 'codex/issue-40-task-40', worktree: join(f.stateDir, 'worktrees/issue-40'),
      base: 'base-sha', session: 'saved-repair-session', stage: 'implement', failures: 1, quotaWaits: 0,
      repair: { category: 'local_verification', check: 'test:unit', diagnostic: 'check_failed' },
      result: { ...result, reasons: [{ category: 'db', check: 'none' }, { category: 'sandbox_capability', check: 'test:ui' }] } };
    await mkdir(current.worktree, { recursive: true });
    await saveJson(join(f.stateDir, 'state.json'), { ...emptyState(), repo: 'test/repo', status: 'running', paused: false,
      lastReason: 'parent_verification_retry', current });
    const execute = mockExecute([issue(40, labels)], f.calls);
    let runs = 0;
    const state = await worker({ ...f.options, expectedIssue: 40, reviewPolicy: 'local-automatic', continueAfterHuman: true,
      execute, run: async ({ current: restored }) => {
        runs++;
        for (const key of ['session', 'worktree', 'branch', 'base', 'failures']) assert.equal(restored[key], current[key]);
        assert.deepEqual(restored.repair, current.repair);
        return { quota: 'window', code: 1 };
      } });
    const allowed = labels[0] === 'codex:running';
    assert.equal(runs, allowed ? 1 : 0);
    assert.equal(state.status, allowed ? 'quota-wait' : 'needs-human');
    assert.equal(state.current.session, current.session);
    assert.ok(!f.calls.some(([b,a]) => b === 'git' && ['push','commit','reset','clean','stash','rebase'].includes(a[0])));
  });
}
