import { localChecks } from './failure.mjs';

const unit = 'vitest run --project unit';
const ui = 'vitest run --project storybook';
const standard = 'npm run test:unit && npm run test:ui';

const allowed = {
  typecheck: 'tsc --noEmit', lint: 'eslint', build: 'next build --webpack',
  test: standard, 'test:unit': unit, 'test:ui': ui,
  'test:codex-worker': 'node --test scripts/codex/*.test.mjs',
  'test:ci-scope': 'node --test scripts/ci/*.test.mjs scripts/e2e/playwright-arguments.test.mjs',
};

export function assertLocalCheck(scripts, name) {
  if (!scripts || !localChecks.includes(name) || scripts[name] !== allowed[name] || scripts[`pre${name}`] || scripts[`post${name}`]) {
    throw new Error('Check script requires human verification');
  }
  if (name === 'test') assertLocalTests(scripts, ['test:unit', 'test:ui']);
}

function assertLocalTests(scripts, names) {
  for (const name of names) {
    if (scripts[name] !== allowed[name] || scripts[`pre${name}`] || scripts[`post${name}`]) {
      throw new Error('Test script requires human verification: only local unit/UI without lifecycle hooks is allowed');
    }
  }
}

// This is also the exact set of sandbox-limited tests the prompt may delegate.
export function verificationTests(changed, scripts, reasons = []) {
  const checks = [];
  const packageChanged = changed.some(line => /\s+package(?:-lock)?\.json$/.test(line));
  if (packageChanged && scripts.test !== undefined) {
    assertLocalTests(scripts, ['test', 'test:unit', 'test:ui']);
    checks.push('test');
  } else {
    if (changed.some(line => /\s+src\/(?:app\/actions|utils|components)\//.test(line))) {
      assertLocalTests(scripts, ['test:unit']); checks.push('test:unit');
    }
    if (changed.some(line => /\s+src\/components\//.test(line))) {
      assertLocalTests(scripts, ['test:ui']); checks.push('test:ui');
    }
  }
  if (changed.some(line => /\s+scripts\/codex\//.test(line))) checks.push('test:codex-worker');
  if (changed.some(line => /\s+scripts\/ci\//.test(line))) checks.push('test:ci-scope');
  if (changed.some(line => /\s+(?:src\/|next\.config\.|package(?:-lock)?\.json$)/.test(line)) && scripts.build) checks.push('build');
  for (const reason of reasons) {
    if (!['sandbox_capability', 'local_verification', 'verification_retry_limit'].includes(reason.category) || !localChecks.includes(reason.check)) throw new Error('Unsafe handoff reason');
    if (!['typecheck', 'lint', 'diff-check'].includes(reason.check)) checks.push(reason.check);
  }
  return [...new Set(checks)];
}
