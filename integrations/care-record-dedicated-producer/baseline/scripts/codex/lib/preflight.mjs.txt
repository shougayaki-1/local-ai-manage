// E2E mentions and test-code edits are allowed. Only execution requirements stop
// the queue before worktree preparation. No Issue prose is persisted as a reason.
export function preflightReason(body = '') {
  let requiredDepth = null;
  for (const line of body.split(/\r?\n/)) {
    const heading = line.match(/^\s*(#{1,6})\s+(.+)/);
    if (heading) {
      if (requiredDepth !== null && heading[1].length <= requiredDepth) requiredDepth = null;
      if (/acceptance criteria|required tests|completion criteria|受け入れ|受入|完了条件|必須.*(?:テスト|検証)/i.test(heading[2])) requiredDepth = heading[1].length;
    }
    if (/^\s*(?:acceptance criteria|required tests|completion criteria|受入条件|完了条件)\s*[:：]/i.test(line)) requiredDepth = 0;
    for (const clause of line.split(/[。;；]/)) {
      if (!/\bE2E\b|test:e2e|end.to.end/i.test(clause)) continue;
      if (/不要|必須ではない|実行しない|禁止|しなくて|not required|must not|do not|without running|out of scope|optional/i.test(clause)) continue;
      const execution = /実行|走らせ|成功する|通る|\b(?:run|execute|execution|pass|passing)\b|npm\s+run\s+test:e2e/i.test(clause);
      const mandatory = requiredDepth !== null || /必須|必ず|完了条件|なければならない|すること|\b(?:must|required|shall)\b/i.test(clause);
      if (execution && mandatory) return 'manual_e2e_required';
    }
  }
  return null;
}
