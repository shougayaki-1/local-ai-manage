import { mkdir, readFile, writeFile, rename, open, unlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { repairDiagnostic, localChecks } from './failure.mjs';

export const emptyState = () => ({ version: 1, repo: null, status: 'idle', current: null, lastReason: null, paused: false, quotaWaitStarted: null, nextRetryAt: null });

function validCurrent(current) {
  return current && Number.isSafeInteger(current.number) && current.number > 0
    && /^codex\/issue-\d+-[a-z0-9-]+$/.test(current.branch ?? '') && current.branch.startsWith(`codex/issue-${current.number}-`)
    && typeof current.worktree === 'string' && Number.isInteger(current.failures) && current.failures >= 0
    && Number.isInteger(current.quotaWaits) && current.quotaWaits >= 0 && ['prepare', 'implement', 'publish'].includes(current.stage)
    && (current.repair === undefined || repairDiagnostic(current.repair))
    && (current.alternativeHistory === undefined || (Array.isArray(current.alternativeHistory)
      && current.alternativeHistory.length <= 2 && current.alternativeHistory.every(entry => repairDiagnostic(entry))))
    && (current.verificationChecks === undefined || (Array.isArray(current.verificationChecks)
      && current.verificationChecks.every(name => localChecks.includes(name))));
}

export async function loadState(directory) {
  let state;
  try { state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return emptyState(); throw new Error('Worker state is unreadable; restore it before continuing'); }
  if (state.version !== 1 || !['idle', 'running', 'quota-wait', 'needs-human', 'failed'].includes(state.status) || typeof state.paused !== 'boolean'
    || (state.repo !== null && typeof state.repo !== 'string')
    || (state.nextRetryAt !== null && !Number.isFinite(state.nextRetryAt))
    || (state.quotaWaitStarted !== null && !Number.isFinite(state.quotaWaitStarted))
    || (state.current && !validCurrent(state.current))
    || (state.humanWaiting !== undefined && (!Array.isArray(state.humanWaiting) || state.humanWaiting.length > 256
      || state.humanWaiting.some(entry => !entry || !validCurrent(entry.current) || typeof entry.reason !== 'string'
        || !Number.isSafeInteger(entry.since) || entry.since < 0 || entry.current.number === state.current?.number)
      || new Set(state.humanWaiting.map(entry => entry.current.number)).size !== state.humanWaiting.length))) {
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
