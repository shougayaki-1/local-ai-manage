export const localChecks = ['typecheck', 'lint', 'test', 'test:unit', 'test:ui', 'build', 'test:codex-worker', 'test:ci-scope', 'diff-check'];
export const reasonCategories = ['sandbox_capability', 'local_verification', 'verification_retry_limit', 'db', 'auth', 'permission', 'tenant', 'production', 'deploy', 'credential', 'external_service', 'destructive', 'security', 'retention', 'specification', 'manual_e2e', 'worktree_safety'];

// Never carry arbitrary output, filenames, assertion values or error messages
// across the process boundary. Diagnostics are a fixed vocabulary projection.
export function failureSignals(text) {
  return {
    unsafe: /authentication required|authentication failed|not logged in|invalid (?:credential|api key)|credential(?:s)? required|missing.{0,30}(?:secret|token|api.key)|permission denied|row.level security|migration required|requires?.{0,30}(?:production|deploy|external service|E2E|database)|tenant boundary|destructive operation|manual approval|security.{0,20}judgment|retention.{0,20}judgment/i.test(text),
    capability: /listen.{0,30}EPERM|EACCES.{0,30}(?:listen|bind)|localhost.{0,30}(?:bind|denied)|browser.{0,40}(?:launch|restriction|denied)|executable doesn't exist/i.test(text),
    type: /\bTS\d{4}\b/.test(text),
    localPhase: text.match(/Local verification failed at (start|migrations|db-tests|isolation|db-types|e2e); output omitted/)?.[1],
    localDbTest:text.match(/Local DB test failed: (ai_sent_review|internal_work_idempotency|password_recovery_reauth|rpc_contracts|security_hardening)\.test\.sql;/)?.[1],
    assertion: /assertion|AssertionError|color-contrast|expected.{0,40}(?:equal|be|match)/i.test(text),
  };
}

export class CommandFailure extends Error {
  constructor({ unsafe = false, capability = false, type = false, assertion = false, operational = false, localPhase, localDbTest } = {}) {
    super('Command failed; output omitted');
    this.localPhase=localPhase;this.localDbTest=localDbTest;
    this.category = unsafe ? 'unsafe' : operational ? 'operational' : capability ? 'capability' : 'local_verification';
    this.diagnostic = type ? 'type_error' : assertion ? 'assertion_failed' : 'check_failed';
  }
}

export class VerificationFailure extends Error {
  constructor(check, failure) {
    super('Parent verification failed; output omitted');
    this.retryable = failure instanceof CommandFailure && failure.category === 'local_verification';
    this.reason = failure instanceof CommandFailure ? failure.category : 'operational';
    this.diagnostic = { category: 'local_verification', check, diagnostic: failure instanceof CommandFailure ? failure.diagnostic : 'check_failed', ...(check==='local_db_e2e'&&failure.localPhase?{phase:failure.localPhase,...(failure.localDbTest?{dbTest:failure.localDbTest}:{})}:{}) };
  }
}

export function sandboxHandoff(run) {
  const result = run.result;
  return run.code === 0 && !run.needsHuman && ['completed', 'needs_human'].includes(result?.status)
    && !failureSignals([result.summary, result.unrun_tests, result.security_impact, result.remaining_work].join('\n')).unsafe
    && result.reasons?.length > 0 && result.reasons.every(r => r.category === 'sandbox_capability' && localChecks.includes(r.check));
}

export function repairDiagnostic(value) {
  if (!value || value.category !== 'local_verification' || ![...localChecks,'local_db_e2e'].includes(value.check)
    || !['type_error', 'assertion_failed', 'check_failed'].includes(value.diagnostic)
    || Object.keys(value).some(key => !['category', 'check', 'diagnostic','phase','dbTest'].includes(key))) return null;
  if(value.phase!==undefined&&!(value.check==='local_db_e2e'&&['start','migrations','db-tests','isolation','db-types','e2e'].includes(value.phase)))return null;
  if(value.dbTest!==undefined&&!['ai_sent_review','internal_work_idempotency','password_recovery_reauth','rpc_contracts','security_hardening'].includes(value.dbTest))return null;
  return { category: 'local_verification', check: value.check, diagnostic: value.diagnostic,...(value.phase?{phase:value.phase}:{}),...(value.dbTest?{dbTest:value.dbTest}:{}) };
}

// Separate from ordinary repair failures; preserved across quota waits/restarts.
export function planAlternative(current, failure) {
  if (!(failure instanceof VerificationFailure) || !failure.retryable
    || failure.diagnostic.phase === 'start' || failure.diagnostic.phase === 'migrations') return false;
  const history = current.alternativeHistory ?? [];
  if (history.length >= 2) return false;
  current.alternativeHistory = [...history, repairDiagnostic(failure.diagnostic)];
  current.repair = failure.diagnostic;
  current.failures++;
  current.stage = 'implement';
  return true;
}
