export const localChecks = ['typecheck', 'lint', 'test', 'test:unit', 'test:ui', 'build', 'test:codex-worker', 'test:ci-scope', 'diff-check'];
export const reasonCategories = ['sandbox_capability', 'local_verification', 'verification_retry_limit', 'db', 'auth', 'permission', 'tenant', 'production', 'deploy', 'credential', 'external_service', 'destructive', 'security', 'retention', 'specification', 'manual_e2e', 'worktree_safety'];

// Never carry arbitrary output, filenames, assertion values or error messages
// across the process boundary. Diagnostics are a fixed vocabulary projection.
export function failureSignals(text) {
  return {
    unsafe: /authentication required|authentication failed|not logged in|invalid (?:credential|api key)|credential(?:s)? required|missing.{0,30}(?:secret|token|api.key)|permission denied|row.level security|migration required|requires?.{0,30}(?:production|deploy|external service|E2E|database)|tenant boundary|destructive operation|manual approval|security.{0,20}judgment|retention.{0,20}judgment/i.test(text),
    capability: /listen.{0,30}EPERM|EACCES.{0,30}(?:listen|bind)|localhost.{0,30}(?:bind|denied)|browser.{0,40}(?:launch|restriction|denied)|executable doesn't exist/i.test(text),
    type: /\bTS\d{4}\b/.test(text),
    assertion: /assertion|AssertionError|color-contrast|expected.{0,40}(?:equal|be|match)/i.test(text),
  };
}

export class CommandFailure extends Error {
  constructor({ unsafe = false, capability = false, type = false, assertion = false, operational = false } = {}) {
    super('Command failed; output omitted');
    this.category = unsafe ? 'unsafe' : operational ? 'operational' : capability ? 'capability' : 'local_verification';
    this.diagnostic = type ? 'type_error' : assertion ? 'assertion_failed' : 'check_failed';
  }
}

export class VerificationFailure extends Error {
  constructor(check, failure) {
    super('Parent verification failed; output omitted');
    this.retryable = failure instanceof CommandFailure && failure.category === 'local_verification';
    this.reason = failure instanceof CommandFailure ? failure.category : 'operational';
    this.diagnostic = { category: 'local_verification', check, diagnostic: failure instanceof CommandFailure ? failure.diagnostic : 'check_failed' };
  }
}

export function sandboxHandoff(run) {
  const result = run.result;
  return run.code === 0 && !run.needsHuman && ['completed', 'needs_human'].includes(result?.status)
    && !failureSignals([result.summary, result.unrun_tests, result.security_impact, result.remaining_work].join('\n')).unsafe
    && result.reasons?.length > 0 && result.reasons.every(r => r.category === 'sandbox_capability' && localChecks.includes(r.check));
}

export function repairDiagnostic(value) {
  if (!value || value.category !== 'local_verification' || !localChecks.includes(value.check)
    || !['type_error', 'assertion_failed', 'check_failed'].includes(value.diagnostic)
    || Object.keys(value).some(key => !['category', 'check', 'diagnostic'].includes(key))) return null;
  return { category: 'local_verification', check: value.check, diagnostic: value.diagnostic };
}
