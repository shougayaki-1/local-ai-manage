import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command } from './lib/process.mjs';
import { ensureWorktree } from './lib/worktree.mjs';
import { verificationTests } from './lib/verification.mjs';
import { implementationPrompt } from './lib/codex-runner.mjs';
import { worker, configuration } from './continuous-worker.mjs';
import { saveJson, emptyState, loadState } from './lib/state.mjs';

const scripts = { typecheck: 'tsc --noEmit', lint: 'eslint', test: 'npm run test:unit && npm run test:ui', 'test:unit': 'vitest run --project unit', 'test:ui': 'vitest run --project storybook' };
const result = { status: 'completed', safe_to_open_pr: true, summary: 'Done', tests: ['unit'], unrun_tests: 'npm run test: UI listen EPERM in sandbox, delegated to parent', security_impact: 'none', remaining_work: 'none' };

async function fixture(t, { advance = true, packageData } = {}) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'worker-safety-')));
  t.after(() => rm(path, { recursive: true, force: true }));
  const root = join(path, 'root'); await mkdir(root);
  const git = (args, cwd = root) => command('git', args, { cwd });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Worker Test']);
  await git(['config', 'user.email', 'worker@example.invalid']);
  await git(['remote', 'add', 'origin', 'https://github.com/test/repo.git']);
  await writeFile(join(root,'vercel.json'),JSON.stringify({git:{deploymentEnabled:false}}));
  await writeFile(join(root, 'example.txt'), 'original\n');
  if (packageData) await writeFile(join(root, 'package.json'), JSON.stringify(packageData));
  await git(['add', '.']); await git(['commit', '-m', 'base']);
  const old = await git(['rev-parse', 'HEAD']);
  const stateDir = join(path, 'state'); const worktree = join(stateDir, 'worktrees/issue-51');
  await mkdir(join(stateDir, 'worktrees'), { recursive: true });
  const branch = 'codex/issue-51-test';
  await git(['worktree', 'add', '-b', branch, worktree, old]);
  if (advance) {
    await writeFile(join(root, 'upstream.txt'), 'main update\n');
    await git(['add', '.']); await git(['commit', '-m', 'main update']);
  }
  const latest = await git(['rev-parse', 'HEAD']);
  await git(['update-ref', 'refs/remotes/origin/main', latest]);
  const calls = [];
  const execute = async (binary, args, options) => {
    calls.push([binary, args, options]);
    if (binary === 'git' && args[0] === 'fetch') return '';
    return command(binary, args, options);
  };
  return { root, stateDir, worktree, old, latest, git, execute, calls,
    current: { number: 51, branch, worktree, base: old, stage: 'prepare', session: null, failures: 0, quotaWaits: 0 } };
}

test('existing HEAD == saved base == latest is reused without changing history', async t => {
  const f = await fixture(t, { advance: false });
  await ensureWorktree(f.current, f.root, f.execute);
  assert.equal(f.current.base, f.old);
  assert.ok(!f.calls.some(([, args]) => ['merge', 'reset', 'rebase'].includes(args[0])));
});

test('clean untouched stale worktree is fast-forwarded and only then saves the actual base', async t => {
  const f = await fixture(t);
  await ensureWorktree(f.current, f.root, f.execute);
  assert.equal(f.current.base, f.latest);
  assert.equal(await f.git(['rev-parse', 'HEAD'], f.worktree), f.latest);
  assert.ok(f.calls.some(([, args]) => args[0] === 'merge' && args[1] === '--ff-only'));
});

test('dirty stale worktree preserves tracked and untracked bytes and saved base', async t => {
  const f = await fixture(t);
  f.current.base = f.latest; // Regression: state was assigned remote HEAD despite older worktree.
  await writeFile(join(f.worktree, 'example.txt'), 'unfinished implementation\n');
  await writeFile(join(f.worktree, 'new.txt'), 'untracked implementation\n');
  const status = await f.git(['status', '--porcelain'], f.worktree);
  await assert.rejects(ensureWorktree(f.current, f.root, f.execute), { reason: 'worktree_base_mismatch' });
  assert.equal(await f.git(['rev-parse', 'HEAD'], f.worktree), f.old);
  assert.equal(await f.git(['status', '--porcelain'], f.worktree), status);
  assert.equal(await readFile(join(f.worktree, 'example.txt'), 'utf8'), 'unfinished implementation\n');
  assert.equal(await readFile(join(f.worktree, 'new.txt'), 'utf8'), 'untracked implementation\n');
  assert.equal(f.current.base, f.latest);
});

test('clean stale worktree with an implementation commit is never rebased or reset', async t => {
  const f = await fixture(t);
  await writeFile(join(f.worktree, 'implementation.txt'), 'done\n');
  await f.git(['add', '.'], f.worktree); await f.git(['commit', '-m', 'implementation'], f.worktree);
  const head = await f.git(['rev-parse', 'HEAD'], f.worktree);
  await assert.rejects(ensureWorktree(f.current, f.root, f.execute), { reason: 'stale_existing_worktree' });
  assert.equal(await f.git(['rev-parse', 'HEAD'], f.worktree), head);
  assert.equal(f.current.base, f.old);
});

test('implementation commits on a coherent saved/latest base are retained and accepted', async t => {
  const f = await fixture(t, { advance: false });
  await writeFile(join(f.worktree, 'implementation.txt'), 'done\n');
  await f.git(['add', '.'], f.worktree); await f.git(['commit', '-m', 'implementation'], f.worktree);
  f.current.stage = 'implement';
  const check = await ensureWorktree(f.current, f.root, f.execute);
  assert.equal(check.localCommits, 1);
  assert.equal(f.current.base, f.old);
});

test('session/progress prevent even clean stale worktree updates', async t => {
  for (const saved of [{ session: 'saved-session' }, { progress: 'work remains' }, { stage: 'implement' }]) {
    const f = await fixture(t); Object.assign(f.current, saved);
    await assert.rejects(ensureWorktree(f.current, f.root, f.execute), { reason: 'stale_existing_worktree' });
    assert.equal(await f.git(['rev-parse', 'HEAD'], f.worktree), f.old);
    assert.equal(f.current.base, f.old);
  }
});

test('resume mismatch pauses with diagnostic state, preserving base/session/failures without Codex or publish', async t => {
  const f = await fixture(t);
  Object.assign(f.current, { base: f.latest, stage: 'implement', session: 'saved-session', failures: 2 });
  await saveJson(join(f.stateDir, 'state.json'), { ...emptyState(), repo: 'test/repo', paused: true, status: 'needs-human', current: f.current });
  const reports = [];
  await assert.rejects(worker({ root: f.root, config: { ...configuration(), stateDir: f.stateDir }, mode: 'once', resume: true,
    run: () => assert.fail('Codex must not run'), report: line => reports.push(line),
    execute: async (binary, args, options) => {
      if (binary === 'codex') return '--json --output-schema';
      if (binary === 'gh') return args[0] === 'api' ? JSON.stringify({ number: 51, state: 'open', labels: [] }) : '';
      return f.execute(binary, args, options);
    } }), /worktree_base_mismatch/);
  const state = await loadState(f.stateDir);
  assert.equal(state.lastReason, 'worktree_base_mismatch');
  assert.equal(state.paused, true); assert.equal(state.current.base, f.latest);
  assert.equal(state.current.session, 'saved-session'); assert.equal(state.current.failures, 2);
  assert.equal(state.current.worktreeCheck.head, f.old);
  assert.ok(reports.some(line => line.includes('worktree_base_mismatch')));
  assert.ok(!f.calls.some(([, args]) => ['reset', 'rebase', 'clean', 'stash', 'push', 'commit'].includes(args[0])));
});

test('standard test is selected only for inspected local unit/UI scripts and rejects unsafe hooks/commands', () => {
  assert.deepEqual(verificationTests(['M\tpackage.json'], scripts), ['test']);
  assert.deepEqual(verificationTests(['M\tpackage-lock.json'], scripts), ['test']);
  assert.deepEqual(verificationTests(['M\tsrc/components/ui/Button.tsx'], scripts), ['test:unit', 'test:ui']);
  for (const bad of [{ test: 'npm run test:e2e' }, { test: 'npm run test:unit' }, { pretest: 'deploy' }, { 'posttest:ui': 'curl external' }, { 'test:ui': 'supabase db reset' }]) {
    assert.throws(() => verificationTests(['M\tpackage.json'], { ...scripts, ...bad }), /human verification/);
  }
});

test('prompt only delegates guaranteed sandbox-limited checks and keeps human/security barriers', () => {
  const prompt = implementationPrompt({ number: 51, title: 'test' }, { worktree: '/worktree', branch: 'codex/issue-51-test' });
  for (const text of ['listen EPERM', 'unrun_tests', 'safe_to_open_pr=true', 'Never treat assertion failures', 'never bypass the sandbox', 'authentication', 'DB/RLS/migration', 'parent MUST run npm run test', '240/320/375px/desktop', 'visual/manual specification']) assert.ok(prompt.includes(text), text);
});

for (const fails of [false, true]) {
  test(`parent standard unit/UI subprocess ${fails ? 'assertion failure blocks' : 'success permits'} publication after sandbox handoff`, async t => {
    const f = await fixture(t, { advance: false, packageData: { name: 'local-tests', scripts: { typecheck: scripts.typecheck, lint: scripts.lint, 'test:unit': scripts['test:unit'], 'test:ui': scripts['test:ui'] } } });
    let pushed = false;
    const state = await worker({ root: f.root, config: { ...configuration(), stateDir: f.stateDir }, mode: 'once', report: () => {}, wait: async () => {},
      execute: async (binary, args, options) => {
        if (binary === 'codex') return '--json --output-schema';
        if (binary === 'gh') {
          if (args[0] === 'api') return args.at(-1).includes('issues?') ? JSON.stringify([[{ number: 51, title: 'test', state: 'open', labels: ['codex:ready'] }]]) : args.at(-1).match(/issues\/51$/) ? JSON.stringify({ number: 51, title: 'test', state: 'open', labels: ['codex:ready'] }) : '[[]]';
          if (args[0] === 'pr') return args[1] === 'list' ? '[]' : 'https://github.com/test/repo/pull/1';
          return '';
        }
        if (binary === 'git' && args[0] === 'push') { pushed = true; return ''; }
        if (binary === 'npm' && !args.includes('test')) return ''; // Actual npm standard test is exercised below.
        return f.execute(binary, args, options);
      }, run: async () => {
        await writeFile(join(f.worktree, 'package.json'), JSON.stringify({ name: 'local-tests', scripts }));
        await mkdir(join(f.worktree, 'node_modules/.bin'), { recursive: true });
        await writeFile(join(f.worktree, '.gitignore'), 'node_modules/\n');
        await writeFile(join(f.worktree, 'node_modules/.bin/vitest'), `#!/usr/bin/env node\nif(process.argv.includes('storybook') && ${fails}) {console.error('assertion failed');process.exit(1);}\n`, { mode: 0o700 });
        return { code: 0, result: { ...result, tests: [...result.tests] } };
      } });
    assert.equal(pushed, !fails);
    assert.equal(state.lastReason, fails ? 'verification_retry_exhausted' : 'completed');
    if (fails) {
      assert.equal(state.current.stage, 'publish');
      assert.equal(await f.git(['rev-parse', 'HEAD'], f.worktree), f.old);
    }
    assert.ok(f.calls.some(([binary, args, options]) => binary === 'npm' && args[1] === 'test' && options.testMode));
  });
}

test('parent test environment is synthetic and does not inherit credential/session values', async () => {
  const env = JSON.parse(await command(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'], { testMode: true,
    parentEnv: { PATH: process.env.PATH, HOME: '/owner', GH_TOKEN: 'dummy-gh', CODEX_HOME: '/owner/.codex', SUPABASE_SERVICE_ROLE_KEY: 'real-secret', DBUS_SESSION_BUS_ADDRESS: 'session' } }));
  assert.equal(env.GH_TOKEN, undefined); assert.equal(env.CODEX_HOME, undefined); assert.equal(env.DBUS_SESSION_BUS_ADDRESS, undefined);
  assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, 'ci-test-service-role-key');
  assert.equal(env.NEXT_PUBLIC_SUPABASE_URL, 'http://127.0.0.1:54321');
  assert.notEqual(env.HOME, '/owner');
  await assert.rejects(command(process.execPath, [], { purpose: 'github', testMode: true }), /build-only/);
});

test('once/resume retains bounded implementation retries after safety validation', async t => {
  const f = await fixture(t, { advance: false });
  f.current.stage = 'implement';
  await saveJson(join(f.stateDir, 'state.json'), { ...emptyState(), repo: 'test/repo', paused: true, status: 'needs-human', current: f.current });
  let turns = 0;
  const state = await worker({ root: f.root, config: { ...configuration(), stateDir: f.stateDir, stopOnFailure: true }, mode: 'once', resume: true,
    report: () => {}, wait: async () => {}, run: async () => { turns++; return { code: 1 }; },
    execute: async (binary, args, options) => {
      if (binary === 'codex') return '--json --output-schema';
      if (binary === 'gh') return args[0] === 'api' ? JSON.stringify({ number: 51, state: 'open', labels: [] }) : '';
      return f.execute(binary, args, options);
    } });
  assert.equal(turns, 2);
  assert.equal(state.status, 'needs-human');
  assert.equal(state.current.failures, 1);
});

test('#50-type sandbox UI handoff -> real parent assertion failure -> same-session minimal repair -> mock Draft PR', async t => {
  const f = await fixture(t, { advance: false, packageData: { name: 'ui-regression', scripts } });
  let turns = 0; let pushed = false;
  const reports = [];
  const outcome = { ...result, status: 'needs_human', safe_to_open_pr: false,
    reasons: [{ category: 'sandbox_capability', check: 'test:ui' }], unrun_tests: 'UI: listen EPERM in sandbox' };
  const state = await worker({ root: f.root, config: { ...configuration(), stateDir: f.stateDir }, mode: 'once',
    now: () => turns, wait: async () => {}, report: text => reports.push(text),
    execute: async (binary, args, options) => {
      if (binary === 'codex') return '--json --output-schema';
      if (binary === 'gh') {
        if (args[0] === 'api') return args.at(-1).includes('issues?') ? JSON.stringify([[{ number: 51, title: 'test', state: 'open', labels: ['codex:ready'] }]]) : /issues\/51$/.test(args.at(-1)) ? JSON.stringify({ number: 51, title: 'test', state: 'open', labels: ['codex:ready'] }) : '[[]]';
        if (args[0] === 'pr') { assert.equal(turns, 2); return args[1] === 'list' ? '[]' : 'https://github.com/test/repo/pull/1'; }
        return '';
      }
      if (binary === 'git' && args[0] === 'push') { assert.equal(turns, 2); pushed = true; return ''; }
      if (binary === 'npm' && args[1] !== 'test:ui') return '';
      return f.execute(binary, args, options);
    },
    run: async ({ current, onSession }) => {
      turns++;
      if (turns === 1) {
        await onSession('preserved-ui-session');
        await mkdir(join(f.worktree, 'src/components/ui'), { recursive: true });
        await writeFile(join(f.worktree, 'src/components/ui/Example.stories.ts'), 'Service Dates\nScreen Widths\nProcessing\n');
        await mkdir(join(f.worktree, 'node_modules/.bin'), { recursive: true });
        await writeFile(join(f.worktree, '.gitignore'), 'node_modules/\n');
        await writeFile(join(f.worktree, 'node_modules/.bin/vitest'), `#!/usr/bin/env node
const fs = require('node:fs');
if (fs.readFileSync('src/components/ui/Example.stories.ts', 'utf8').includes('Processing')) {
 console.error('AssertionError color-contrast ghp_example_secret patient PRIVATE-PATIENT token=private-secret');
 process.exit(1);
}
`, { mode: 0o700 });
      } else {
        assert.equal(current.session, 'preserved-ui-session');
        assert.equal(current.worktree, f.worktree); assert.equal(current.branch, f.current.branch); assert.equal(current.base, f.old);
        assert.equal(current.failures, 1);
        assert.deepEqual(current.repair, { category: 'local_verification', check: 'test:ui', diagnostic: 'assertion_failed' });
        assert.equal(await f.git(['rev-parse', 'HEAD'], f.worktree), f.old, 'not committed before passing UI');
        const prompt = implementationPrompt({ number: 51, title: 'Service Dates' }, current);
        for (const value of ['ghp_example_secret', 'PRIVATE-PATIENT', 'private-secret']) assert.ok(!prompt.includes(value));
        // Only remove the out-of-scope failing Processing story. Required coverage remains.
        await writeFile(join(f.worktree, 'src/components/ui/Example.stories.ts'), 'Service Dates\nScreen Widths\n');
      }
      return { code: 0, result: outcome };
    },
  });
  assert.equal(turns, 2); assert.ok(pushed); assert.equal(state.lastReason, 'completed');
  const saved = JSON.parse(await readFile(join(f.stateDir, 'issue-51.json'), 'utf8'));
  assert.equal(saved.session, 'preserved-ui-session'); assert.equal(saved.base, f.old); assert.equal(saved.worktree, f.worktree);
  assert.equal(saved.failures, 1); assert.equal(saved.result.safe_to_open_pr, true);
  assert.ok(!f.calls.some(([, args]) => ['reset', 'rebase', 'clean', 'stash'].includes(args[0])));
  const artifacts = JSON.stringify(saved) + await readFile(join(f.stateDir, 'state.json'), 'utf8') + reports.join('\n');
  for (const value of ['ghp_example_secret', 'PRIVATE-PATIENT', 'private-secret']) assert.ok(!artifacts.includes(value));
  assert.equal(await readFile(join(f.worktree, 'src/components/ui/Example.stories.ts'), 'utf8'), 'Service Dates\nScreen Widths\n');
});
