import { mkdir, readFile, writeFile, rename, open, unlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { repairDiagnostic, localChecks } from './failure.mjs';

export const emptyState = () => ({ version: 1, repo: null, status: 'idle', current: null, lastReason: null, paused: false, quotaWaitStarted: null, nextRetryAt: null });

export async function loadState(directory) {
  let state;
  try { state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return emptyState(); throw new Error('Worker state is unreadable; restore it before continuing'); }
  if (state.version !== 1 || !['idle', 'running', 'quota-wait', 'needs-human', 'failed'].includes(state.status) || typeof state.paused !== 'boolean'
    || (state.repo !== null && typeof state.repo !== 'string')
    || (state.nextRetryAt !== null && !Number.isFinite(state.nextRetryAt))
    || (state.quotaWaitStarted !== null && !Number.isFinite(state.quotaWaitStarted))
    || (state.current && (!Number.isSafeInteger(state.current.number) || state.current.number <= 0
      || !/^codex\/issue-\d+-[a-z0-9-]+$/.test(state.current.branch ?? '') || !state.current.branch.startsWith(`codex/issue-${state.current.number}-`)
      || typeof state.current.worktree !== 'string' || !Number.isInteger(state.current.failures) || state.current.failures < 0
      || !Number.isInteger(state.current.quotaWaits) || state.current.quotaWaits < 0 || !['prepare', 'implement', 'publish'].includes(state.current.stage)
      || (state.current.repair !== undefined && !repairDiagnostic(state.current.repair))
      || (state.current.verificationChecks !== undefined && (!Array.isArray(state.current.verificationChecks)
        || state.current.verificationChecks.some(name => !localChecks.includes(name))))))) {
    throw new Error('Invalid worker state; manual recovery required');
  }
  return state;
}

export async function saveJson(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function lockState(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, 'worker.lock');
  // A stale lock is deliberately not stolen: its child may still be running.
  let lock;
  try { lock = await open(path, 'wx', 0o600); }
  catch { throw new Error('Worker lock exists; verify worker and Codex children have stopped before removing it'); }
  await lock.writeFile(`${process.pid}\n`);
  await lock.close();
  return () => unlink(path);
}
