import { failureSignals, sandboxHandoff, localChecks } from './failure.mjs';

const excluded = new Set(['codex:blocked', 'codex:running', 'codex:failed', 'codex:needs-human']);

export function metadata(body = '') {
  const blocks = [...body.matchAll(/<!--\s*codex-queue\s*\n([\s\S]*?)-->/g)];
  if (!blocks.length) return { dependencies: [], priority: undefined };
  if (blocks.length !== 1) throw new Error('Multiple queue metadata blocks');
  const value = blocks[0][1];
  const dependencies = value.match(/^depends_on:\s*(\[[^\n]*\])\s*$/m);
  if (/^depends_on:/m.test(value) && !dependencies) throw new Error('Invalid dependencies');
  const parsed = dependencies ? JSON.parse(dependencies[1]) : [];
  if (!Array.isArray(parsed) || parsed.some(n => !Number.isSafeInteger(n) || n <= 0)) throw new Error('Invalid dependencies');
  const priority = value.match(/^priority:\s*(p[0-3])\s*$/m)?.[1];
  if (/^priority:/m.test(value) && !priority) throw new Error('Invalid priority');
  return { dependencies: [...new Set(parsed)], priority };
}

export function labels(issue) {
  return (issue.labels ?? []).map(label => typeof label === 'string' ? label : label.name);
}

export function selectIssue(issues, dependencyStates, linkedIssues = new Set()) {
  const candidates = [];
  for (const issue of issues) {
    if(typeof issue.body==='string'&&/<!--\s*codex-worker-status\s*-->/.test(issue.body))continue;
    const names = labels(issue);
    if (issue.state.toLowerCase() !== 'open' || !names.includes('codex:ready') || names.some(n => excluded.has(n)) || linkedIssues.has(issue.number)) continue;
    let info;
    try { info = metadata(issue.body); } catch { continue; }
    if (info.dependencies.some(n => dependencyStates.get(n)?.toLowerCase() !== 'closed')) continue;
    const ranks = names.filter(n => /^priority:p[0-3]$/.test(n)).map(n => Number(n.at(-1)));
    const rank = info.priority ? Number(info.priority[1]) : ranks.length ? Math.min(...ranks) : 4;
    candidates.push({ issue, rank });
  }
  return candidates.sort((a, b) => a.rank - b.rank || a.issue.number - b.issue.number)[0]?.issue ?? null;
}

export function branchName(issue) {
  const slug = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48).replace(/-$/, '') || 'implementation';
  return `codex/issue-${issue.number}-${slug}`;
}

export function disposition(run, failures, config) {
  if (run.quota || run.result?.status === 'quota_wait') return 'quota_wait';
  if (run.interrupted || run.result?.status === 'paused') return 'paused';
  if (run.result?.reasons?.some(r => !['sandbox_capability', 'local_verification', 'verification_retry_limit'].includes(r.category))) return 'needs_human';
  if (sandboxHandoff(run)) return 'completed';
  if (!failureSignals([run.result?.summary,run.result?.unrun_tests,run.result?.security_impact,run.result?.remaining_work].join('\n')).unsafe && run.code === 0 && !run.needsHuman && !run.interrupted && run.result?.reasons?.length && run.result.reasons.every(r => ['sandbox_capability','local_verification','verification_retry_limit'].includes(r.category) && localChecks.includes(r.check))) return 'completed';
  if (run.result?.reasons?.some(r => r.category === 'sandbox_capability')) return 'needs_human';
  if (!run.needsHuman && run.result?.reasons?.length && run.result.reasons.every(r => r.category === 'local_verification' && localChecks.includes(r.check))) return failures < config.maxRetries ? 'retry' : 'needs_human';
  if (run.needsHuman || run.result?.status === 'needs_human') return 'needs_human';
  if (run.code === 0 && run.result?.status === 'completed' && run.result.safe_to_open_pr) return 'completed';
  return failures < config.maxRetries ? 'retry' : 'needs_human';
}
