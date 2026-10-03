import { access, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export class WorktreeSafetyError extends Error {
  constructor(reason, check = {}) {
    super(`Worktree needs human review: ${reason}`);
    this.reason = reason;
    this.check = check;
  }
}

// No reset/rebase/clean/stash. A saved base is never inferred from a moving remote.
export async function ensureWorktree(current, root, execute) {
  await execute('git', ['fetch', 'origin', 'main'], { cwd: root, purpose: 'github' });
  const latest = await execute('git', ['rev-parse', 'origin/main'], { cwd: root });
  const started = current.stage !== 'prepare' || !!(current.session || current.progress || current.result || current.lastRun);
  let exists = true;
  try { await access(current.worktree); } catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
  if (!exists) {
    if (started) throw new WorktreeSafetyError('missing_saved_worktree');
    await mkdir(dirname(current.worktree), { recursive: true, mode: 0o700 });
    await execute('git', ['worktree', 'add', '-b', current.branch, current.worktree, latest], { cwd: root });
    // Persist only after creation succeeds, so failed preparation cannot invent a base.
    current.base = latest;
  }
  const git = args => execute('git', args, { cwd: current.worktree });
  if (await git(['branch', '--show-current']) !== current.branch) throw new WorktreeSafetyError('worktree_branch_mismatch');
  const head = await git(['rev-parse', 'HEAD']);
  const dirty = !!await git(['status', '--porcelain', '--untracked-files=all']);
  let remoteBase;
  try { remoteBase = await git(['merge-base', 'HEAD', latest]); }
  catch { throw new WorktreeSafetyError('worktree_unrelated_history', { head, base: current.base ?? null, latest, dirty }); }
  const localCommits = Number(await git(['rev-list', '--count', `${latest}..HEAD`]));
  const check = { head, base: current.base ?? null, latest, remoteBase, dirty, localCommits };
  let baseAncestor = false;
  if (current.base) {
    try { baseAncestor = await git(['merge-base', 'HEAD', current.base]) === current.base; }
    catch { /* Missing/unrelated saved base is a safety failure, not a new base. */ }
  }
  if (baseAncestor && current.base === latest) return check;
  // Only an untouched, clean ancestor can be fast-forwarded. Session/progress and
  // implementation commits always require explicit human reconciliation.
  if (!started && !dirty && localCommits === 0 && remoteBase === head
      && (!current.base || current.base === head || current.base === latest)) {
    if (head !== latest) await git(['merge', '--ff-only', latest]);
    if (await git(['rev-parse', 'HEAD']) !== latest || await git(['status', '--porcelain', '--untracked-files=all'])) {
      throw new WorktreeSafetyError('worktree_update_incomplete', check);
    }
    current.base = latest;
    return { ...check, head: latest, base: latest, remoteBase: latest };
  }
  throw new WorktreeSafetyError(baseAncestor ? 'stale_existing_worktree' : 'worktree_base_mismatch', check);
}
