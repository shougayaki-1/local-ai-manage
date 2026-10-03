import { metadata } from './queue.mjs';

export class GitHub {
  constructor(repo, execute) { this.repo = repo; this.execute = execute; }
  async gh(args, options) { return this.execute('gh', args, { ...options, purpose: 'github' }); }
  async api(path) { return JSON.parse(await this.gh(['api', `repos/${this.repo}/${path}`])); }
  async issue(number) { return this.api(`issues/${number}`); }
  async snapshot() {
    const pages = JSON.parse(await this.gh(['api', '--paginate', '--slurp', `repos/${this.repo}/issues?state=open&labels=codex%3Aready&per_page=100`]));
    const issues = pages.flat().filter(i => !i.pull_request);
    const dependencies = new Map();
    for (const issue of issues) {
      let info;
      try { info = metadata(issue.body); } catch { continue; }
      for (const n of info.dependencies) if (!dependencies.has(n)) {
        try { dependencies.set(n, (await this.issue(n)).state); }
        catch { dependencies.set(n, 'unknown'); }
      }
    }
    const pulls = JSON.parse(await this.gh(['api', '--paginate', '--slurp', `repos/${this.repo}/pulls?state=open&per_page=100`]));
    const linked = new Set();
    for (const pr of pulls.flat()) {
      const branchIssue = pr.head.ref.match(/^codex\/issue-(\d+)-/);
      if (branchIssue) linked.add(Number(branchIssue[1]));
    }
    // Timeline cross-references include linked PRs even without closing keywords.
    for (const issue of issues) {
      try {
        const timeline = JSON.parse(await this.gh(['api', '--paginate', '--slurp', `repos/${this.repo}/issues/${issue.number}/timeline?per_page=100`]));
        if (timeline.flat().some(e => e.source?.issue?.pull_request && e.source.issue.state === 'open')) linked.add(issue.number);
      } catch { linked.add(issue.number); } // Fail closed if association checks are unavailable.
    }
    return { issues, dependencies, linked };
  }
  async mark(number, status) {
    const add = status === 'running' ? ['codex:running'] : status === 'completed' ? [] : [`codex:${status.replace('_', '-')}`];
    const remove = status === 'running' ? [] : ['codex:running', 'codex:ready'];
    await this.gh(['issue', 'edit', String(number), '--repo', this.repo, ...add.flatMap(n => ['--add-label', n]), ...remove.flatMap(n => ['--remove-label', n])]);
  }
  async draft(current, result) {
    const existing = JSON.parse(await this.gh(['pr', 'list', '--repo', this.repo, '--state', 'all', '--head', current.branch, '--json', 'url,state,isDraft', '--limit', '100']));
    if (existing.length) {
      if (existing.length === 1 && existing[0].state === 'OPEN' && existing[0].isDraft) return existing[0].url;
      throw new Error('Existing non-draft or closed PR requires human review');
    }
    const body = `Closes #${current.number}\n\nCodex Continuous Worker による自動実装。merge は人が確認して行います。\n\n${result.summary}\n\n検証:\n${result.tests.map(t => `- ${t}`).join('\n')}\n\n未実行の検証と理由:\n${result.unrun_tests}\n\nSecurity / RLS / migration:\n${result.security_impact}\n\n残作業:\n${result.remaining_work}\n`;
    return this.gh(['pr', 'create', '--repo', this.repo, '--base', 'main', '--head', current.branch, '--draft', '--title', `Issue #${current.number}: implementation`, '--body-file', '-'], { input: body, cwd: current.worktree });
  }
}
